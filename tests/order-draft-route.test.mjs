import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/orders/route.ts";

const originalEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  ORDER_RATE_LIMIT_SECRET: process.env.ORDER_RATE_LIMIT_SECRET,
  ORDER_APP_ORIGIN: process.env.ORDER_APP_ORIGIN,
};
process.env.SUPABASE_URL = "https://staging-project-ref.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-server-key";
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
    works: [{
      id: "work-1", title: "作品", author: "作者",
      cardUrl: "https://example.test/card", textUrl: "https://example.test/text", xhtmlUrl: "https://example.test/text.xhtml",
    }],
  },
  declaredBodyPdfPageCount: 24,
};

async function invoke(mockFetch) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await POST(new Request("https://app.test/api/orders", {
      method: "POST",
      headers: { Origin: "https://app.test", "Content-Type": "application/json", "x-real-ip": "192.0.2.20" },
      body: JSON.stringify(input),
    }));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("order draft RPC stores only upload-token hash and returns the capability once", async () => {
  let rpcArgs;
  let rpcUrl;
  const response = await invoke(async (url, init) => {
    rpcUrl = String(url);
    rpcArgs = JSON.parse(String(init.body));
    return Response.json({
      id: "d9d71ea0-115c-4b26-8c1d-86bead2aecc4",
      status: "draft",
      createdAt: "2026-10-20T00:00:00.000Z",
      created: true,
      uploadTokenAccepted: true,
    }, { status: 201 });
  });
  const result = await response.json();
  assert.equal(response.status, 201);
  assert.match(rpcUrl, /create_amuhon_order_draft_with_upload_token$/);
  assert.match(rpcArgs.p_upload_token_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(rpcArgs).includes(result.order.uploadToken), false);
  assert.match(result.order.uploadToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.order.status, "draft");
});

test("same idempotency key can receive a fresh capability on safe draft retry", async () => {
  const response = await invoke(async () => Response.json({
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
  assert.match(result.order.uploadToken, /^[A-Za-z0-9_-]{43}$/);
});

test("service-side idempotency mismatch is rejected without leaking database details", async () => {
  const response = await invoke(async () => Response.json({ message: "IDEMPOTENCY_KEY_REUSE_MISMATCH" }, { status: 409 }));
  assert.equal(response.status, 409);
  assert.doesNotMatch((await response.text()), /IDEMPOTENCY_KEY_REUSE_MISMATCH/);
});

test("test-only environment is restored", () => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
