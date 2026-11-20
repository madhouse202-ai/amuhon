import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import JSZip from "jszip";
import { POST } from "../app/api/orders/route.ts";
import { hashOrderUploadToken } from "../lib/order-upload-token.ts";

const originalEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  ORDER_RATE_LIMIT_SECRET: process.env.ORDER_RATE_LIMIT_SECRET,
  ORDER_APP_ORIGIN: process.env.ORDER_APP_ORIGIN,
};
process.env.SUPABASE_URL = "https://staging-project-ref.supabase.co";
process.env.SUPABASE_SECRET_KEY = "sb_secret_test-only-server-key";
process.env.ORDER_RATE_LIMIT_SECRET = "test-only-rate-limit-secret-with-32-characters";
process.env.ORDER_APP_ORIGIN = "https://app.test";

const input = {
  idempotencyKey: "d9d71ea0-115c-4b26-8c1d-86bead2aecc4",
  customer: {
    name: "テスト利用者", postalCode: "1000001", prefecture: "東京都",
    city: "千代田区", address: "1-1", phone: "0312345678", email: "test@example.jp",
  },
  book: {
    title: "テスト本", editor: "編者", coverStyle: "classic", coverColor: "red",
    // The browser's title, contributor and URLs must be ignored; only this
    // catalog ID selects a work on the server.
    works: [{
      id: "000015", title: "偽の作品名", author: "偽の作者",
      cardUrl: "https://example.test/card", textUrl: "https://example.test/text", xhtmlUrl: "https://example.test/text.xhtml",
    }],
  },
  declaredBodyPdfPageCount: 24,
};

const xhtmlBytes = new TextEncoder().encode('<html><body><div class="main_text">検証用本文</div></body></html>');
const sourceSha256 = createHash("sha256").update(xhtmlBytes).digest("hex");
const catalogZip = await (async () => {
  const archive = new JSZip();
  const row = [
    "000015", "カタログ上の作品", "青空", "作者", "著者", "あおぞら", "さくしゃ", "かたろぐじょうのさくひん", "かたろぐじょうのさくひん",
    "https://www.aozora.gr.jp/cards/000015/card.html",
    "https://www.aozora.gr.jp/cards/000015/files/000015_0.txt",
    "https://www.aozora.gr.jp/cards/000015/files/000015_0.html",
    "初出情報", "底本", "出版社", "入力者", "校正者",
  ];
  const unsafeUrlRow = [
    "000016", "確認用作品", "青空", "確認", "著者", "あおぞら", "かくにん", "かくにんようさくひん", "かくにんようさくひん",
    "https://www.aozora.gr.jp/cards/000016/card.html",
    "https://www.aozora.gr.jp/cards/000016/files/000016_0.txt",
    "https://example.test/000016.html",
    "", "", "", "", "",
  ];
  archive.file("catalog.csv", [
    ["作品ID", "作品名", "姓", "名", "役割フラグ", "姓読み", "名読み", "作品名読み", "ソート用読み", "図書カードURL", "テキストファイルURL", "XHTMLファイルURL", "初出", "底本名1", "底本出版社名1", "入力者", "校正者"].join(","),
    row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","),
    unsafeUrlRow.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","),
  ].join("\n"));
  return archive.generateAsync({ type: "uint8array" });
})();

async function invoke(mockDraftRpc, { payload = input, rightsApproval = { approved: true, notices: [{ workId: "000015", sourceSha256, conditions: "台帳記録済み条件" }] } } = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target === "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip") {
      return new Response(catalogZip, { status: 200, headers: { "content-type": "application/zip" } });
    }
    if (target === "https://www.aozora.gr.jp/cards/000015/files/000015_0.html") {
      return new Response(xhtmlBytes, { status: 200, headers: { "content-type": "application/xhtml+xml; charset=utf-8" } });
    }
    if (target.endsWith("/rpc/check_amuhon_works_commercial_rights_v1")) {
      return Response.json(rightsApproval);
    }
    return mockDraftRpc(url, init, calls);
  };
  try {
    const response = await POST(new Request("https://app.test/api/orders", {
      method: "POST",
      headers: { Origin: "https://app.test", "Content-Type": "application/json", "x-real-ip": "192.0.2.20" },
      body: JSON.stringify(payload),
    }));
    return { response, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("order draft RPC stores only upload-token hash and returns the capability in an HttpOnly cookie", async () => {
  const { response, calls } = await invoke(async () => {
    return Response.json({
      id: "d9d71ea0-115c-4b26-8c1d-86bead2aecc4",
      status: "draft",
      createdAt: "2026-10-20T00:00:00.000Z",
      created: true,
      uploadTokenAccepted: true,
    }, { status: 201 });
  });
  const draftCall = calls.find((call) => call.url.endsWith("/rpc/create_amuhon_order_draft_with_upload_token"));
  const rightsCall = calls.find((call) => call.url.endsWith("/rpc/check_amuhon_works_commercial_rights_v1"));
  const rpcArgs = JSON.parse(String(draftCall.init.body));
  const rightsArgs = JSON.parse(String(rightsCall.init.body));
  const result = await response.json();
  assert.equal(response.status, 201);
  assert.match(draftCall.url, /create_amuhon_order_draft_with_upload_token$/);
  assert.equal(calls[0].url, "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip");
  assert.equal(calls[1].url, "https://www.aozora.gr.jp/cards/000015/files/000015_0.html");
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(rightsArgs.p_works[0].title, "カタログ上の作品");
  assert.equal(rightsArgs.p_works[0].cardUrl, "https://www.aozora.gr.jp/cards/000015/card.html");
  assert.equal(rightsArgs.p_works[0].sourceSha256, sourceSha256);
  assert.equal(rpcArgs.p_book_snapshot.works[0].sourceSha256, sourceSha256);
  assert.equal(rpcArgs.p_book_snapshot.works[0].title, "カタログ上の作品");
  assert.doesNotMatch(JSON.stringify(rpcArgs.p_book_snapshot), /偽の作品名|example\.test/);
  assert.match(rpcArgs.p_upload_token_hash, /^[a-f0-9]{64}$/);
  assert.equal("uploadToken" in result.order, false);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  const token = cookie.split("=")[1];
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(hashOrderUploadToken(token), rpcArgs.p_upload_token_hash);
  assert.match(setCookie, /Path=\/api\/orders\/d9d71ea0-115c-4b26-8c1d-86bead2aecc4/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.equal(result.order.status, "draft");
});

test("same idempotency key can receive a fresh capability on safe draft retry", async () => {
  const { response } = await invoke(async () => Response.json({
    id: "d9d71ea0-115c-4b26-8c1d-86bead2aecc4",
    status: "draft",
    createdAt: "2026-10-20T00:00:00.000Z",
    created: false,
    uploadTokenAccepted: true,
  }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.duplicate, true);
  assert.equal(result.order.status, "draft");
  assert.equal("uploadToken" in result.order, false);
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
});

test("service-side idempotency mismatch is rejected without leaking database details", async () => {
  const { response } = await invoke(async () => Response.json({ message: "IDEMPOTENCY_KEY_REUSE_MISMATCH" }, { status: 409 }));
  assert.equal(response.status, 409);
  assert.doesNotMatch((await response.text()), /IDEMPOTENCY_KEY_REUSE_MISMATCH/);
});

test("browser-supplied hashes and non-catalog identifiers are rejected before any upstream lookup", async () => {
  const forgedHashPayload = structuredClone(input);
  forgedHashPayload.book.works[0].sourceSha256 = sourceSha256;
  const forgedHash = await invoke(async () => {
    assert.fail("No RPC or catalog request should be made for a browser-claimed hash");
  }, { payload: forgedHashPayload });
  assert.equal(forgedHash.response.status, 400);
  assert.equal(forgedHash.calls.length, 0);

  const arbitraryIdPayload = structuredClone(input);
  arbitraryIdPayload.book.works[0].id = "work-15";
  const arbitraryId = await invoke(async () => {
    assert.fail("No RPC or catalog request should be made for a non-Aozora identifier");
  }, { payload: arbitraryIdPayload });
  assert.equal(arbitraryId.response.status, 400);
  assert.equal(arbitraryId.calls.length, 0);
});

test("catalog-supplied non-Aozora source URLs are rejected before fetching them", async () => {
  const untrustedCatalogUrl = structuredClone(input);
  untrustedCatalogUrl.book.works[0].id = "000016";
  let draftCalls = 0;
  const { response, calls } = await invoke(async () => {
    draftCalls += 1;
    return Response.json({});
  }, { payload: untrustedCatalogUrl });
  assert.equal(response.status, 503);
  assert.equal(draftCalls, 0);
  assert.equal(calls.some((call) => call.url.startsWith("https://example.test/")), false);
});

test("unapproved catalog edition stops before creating an order", async () => {
  let draftCalls = 0;
  const { response } = await invoke(async () => {
    draftCalls += 1;
    return Response.json({});
  }, { rightsApproval: { approved: false, notices: [] } });
  assert.equal(response.status, 409);
  assert.equal(draftCalls, 0);
});

test("ledger notice cannot replace the server-computed edition hash", async () => {
  let draftCalls = 0;
  const { response } = await invoke(async () => {
    draftCalls += 1;
    return Response.json({});
  }, { rightsApproval: { approved: true, notices: [{ workId: "000015", sourceSha256: "b".repeat(64), conditions: "台帳記録済み条件" }] } });
  assert.equal(response.status, 503);
  assert.equal(draftCalls, 0);
});

test("test-only environment is restored", () => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
