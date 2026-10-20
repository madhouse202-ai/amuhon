import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { POST } from "../app/api/orders/[id]/files/route.ts";
import { validateBodyPdf, validateCoverPng } from "../lib/order-assets.ts";
import { calculateCoverLayout } from "../lib/production.ts";

const ORDER_ID = "d9d71ea0-115c-4b26-8c1d-86bead2aecc4";
const TOKEN = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const originalEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  ORDER_RATE_LIMIT_SECRET: process.env.ORDER_RATE_LIMIT_SECRET,
  ORDER_APP_ORIGIN: process.env.ORDER_APP_ORIGIN,
};
process.env.SUPABASE_URL = "https://staging-project-ref.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-server-key";
process.env.ORDER_RATE_LIMIT_SECRET = "test-only-rate-limit-secret-that-is-long-enough";
process.env.ORDER_APP_ORIGIN = "https://app.test";

async function fixture(pageCount = 24) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) pdf.addPage([105 / 25.4 * 72, 148 / 25.4 * 72]);
  const bodyPdf = new Uint8Array(await pdf.save());
  const layout = calculateCoverLayout(pageCount);
  assert.ok(layout);
  const coverPng = new Uint8Array(await sharp({
    create: { width: layout.pixelWidth, height: layout.pixelHeight, channels: 3, background: { r: 100, g: 50, b: 30 } },
  }).png().withMetadata({ density: 350 }).toBuffer());
  return { bodyPdf, coverPng };
}

function uploadRequest({ token = TOKEN, bodyPdf, coverPng }) {
  const form = new FormData();
  form.append("bodyPdf", new File([bodyPdf], "body.pdf", { type: "application/octet-stream" }));
  form.append("coverPng", new File([coverPng], "cover.png", { type: "application/octet-stream" }));
  return new Request(`https://app.test/api/orders/${ORDER_ID}/files`, {
    method: "POST",
    headers: { Origin: "https://app.test", Cookie: `amuhon_order_upload_${ORDER_ID}=${token}`, "x-real-ip": "192.0.2.10" },
    body: form,
  });
}

async function invoke(request, mockFetch) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await POST(request, { params: Promise.resolve({ id: ORDER_ID }) });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("upload capability is required before any database or storage request", async () => {
  const calls = [];
  const response = await invoke(new Request(`https://app.test/api/orders/${ORDER_ID}/files`, {
    method: "POST", headers: { Origin: "https://app.test" }, body: "",
  }), async (...args) => { calls.push(args); throw new Error("unexpected network call"); });
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test("valid files are checked server-side and stored under the order's deterministic private paths", async () => {
  const { bodyPdf, coverPng } = await fixture();
  const calls = [];
  const response = await invoke(uploadRequest({ bodyPdf, coverPng }), async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("begin_amuhon_order_asset_upload")) {
      return Response.json({ state: "claimed", declaredPageCount: 24 });
    }
    if (url.includes("finish_amuhon_order_asset_upload")) {
      const args = JSON.parse(String(init.body));
      assert.equal(args.p_body_pdf_page_count, 24);
      assert.match(args.p_body_pdf_sha256, /^[a-f0-9]{64}$/);
      assert.match(args.p_cover_png_sha256, /^[a-f0-9]{64}$/);
      return Response.json({ state: "complete", pageCount: 24 });
    }
    if (url.includes("/storage/v1/object/")) return Response.json({ Key: url });
    throw new Error("unexpected request");
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.order.status, "preparing");
  assert.equal(result.order.bodyPdfPageCount, 24);
  assert.deepEqual(calls.filter(({ url }) => url.includes("/storage/v1/object/")).map(({ url }) => url), [
    `https://staging-project-ref.supabase.co/storage/v1/object/amuhon-order-files/${ORDER_ID}/body.pdf`,
    `https://staging-project-ref.supabase.co/storage/v1/object/amuhon-order-files/${ORDER_ID}/cover.png`,
  ]);
  const beginArgs = JSON.parse(String(calls[0].init.body));
  assert.equal(beginArgs.p_upload_token_hash.length, 64);
  assert.notEqual(beginArgs.p_upload_token_hash, TOKEN);
});

test("declared page count mismatch aborts before uploading either file", async () => {
  const { bodyPdf, coverPng } = await fixture(24);
  const calls = [];
  const response = await invoke(uploadRequest({ bodyPdf, coverPng }), async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("begin_amuhon_order_asset_upload")) return Response.json({ state: "claimed", declaredPageCount: 32 });
    if (url.includes("abort_amuhon_order_asset_upload")) return Response.json(true);
    throw new Error("unexpected request");
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /実ページ数/);
  assert.equal(calls.some((url) => url.includes("/storage/v1/object/")), false);
  assert.equal(calls.some((url) => url.includes("abort_amuhon_order_asset_upload")), true);
});

test("same files can be retried idempotently after the database already finalized them", async () => {
  const { bodyPdf, coverPng } = await fixture();
  const body = await validateBodyPdf(bodyPdf);
  const cover = await validateCoverPng(coverPng, body.pageCount);
  const calls = [];
  const response = await invoke(uploadRequest({ bodyPdf, coverPng }), async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("begin_amuhon_order_asset_upload")) {
      return Response.json({ state: "complete", pageCount: 24, bodyPdfSha256: body.sha256, coverPngSha256: cover.sha256 });
    }
    throw new Error("storage must not be overwritten on retry");
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).duplicate, true);
  assert.equal(calls.some((url) => url.includes("/storage/v1/object/")), false);
});

test("failed second object upload triggers best-effort deletion and releases the lease", async () => {
  const { bodyPdf, coverPng } = await fixture();
  const calls = [];
  const response = await invoke(uploadRequest({ bodyPdf, coverPng }), async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("begin_amuhon_order_asset_upload")) return Response.json({ state: "claimed", declaredPageCount: 24 });
    if (url.includes("/storage/v1/object/") && init.method !== "DELETE" && url.endsWith("/body.pdf")) return Response.json({ Key: url });
    if (url.includes("/storage/v1/object/") && init.method !== "DELETE") return new Response("error", { status: 500 });
    if (url.includes("/storage/v1/object/") && init.method === "DELETE") return Response.json({});
    if (url.includes("abort_amuhon_order_asset_upload")) return Response.json(true);
    throw new Error("unexpected request");
  });
  assert.equal(response.status, 502);
  assert.equal(calls.some(({ url, init }) => url.includes("/storage/v1/object/") && init.method === "DELETE"), true);
  assert.equal(calls.some(({ url }) => url.includes("abort_amuhon_order_asset_upload")), true);
});

test("ambiguous finalizer 5xx keeps uploaded objects and the lease for a safe retry", async () => {
  const { bodyPdf, coverPng } = await fixture();
  const calls = [];
  const response = await invoke(uploadRequest({ bodyPdf, coverPng }), async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("begin_amuhon_order_asset_upload")) return Response.json({ state: "claimed", declaredPageCount: 24 });
    if (url.includes("finish_amuhon_order_asset_upload")) return new Response("upstream error", { status: 502 });
    if (url.includes("/storage/v1/object/") && init.method !== "DELETE") return Response.json({ Key: url });
    if (url.includes("/storage/v1/object/") && init.method === "DELETE") return Response.json({});
    if (url.includes("abort_amuhon_order_asset_upload")) return Response.json(true);
    throw new Error("unexpected request");
  });
  assert.equal(response.status, 503);
  assert.equal(calls.filter(({ url }) => url.includes("finish_amuhon_order_asset_upload")).length, 2);
  assert.equal(calls.some(({ url, init }) => url.includes("/storage/v1/object/") && init.method === "DELETE"), false);
  assert.equal(calls.some(({ url }) => url.includes("abort_amuhon_order_asset_upload")), false);
});

test("test-only environment is restored", () => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
