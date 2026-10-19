import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/internal/cleanup-order-uploads/route.ts";

const ORDER_ID = "d9d71ea0-115c-4b26-8c1d-86bead2aecc4";
process.env.SUPABASE_URL = "https://staging-project-ref.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-server-key";
process.env.ORDER_UPLOAD_CLEANUP_SECRET = "test-only-cleanup-secret-with-more-than-32-chars";

async function invoke(request, mockFetch) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await POST(request);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("cleanup endpoint requires its separate server-side secret", async () => {
  let called = false;
  const result = await invoke(new Request("https://app.test/api/internal/cleanup-order-uploads", { method: "POST" }), async () => {
    called = true;
    throw new Error("must not call services");
  });
  assert.equal(result.status, 401);
  assert.equal(called, false);
});

test("cleanup claims only stale rows and deletes both deterministic asset keys", async () => {
  const calls = [];
  const result = await invoke(new Request("https://app.test/api/internal/cleanup-order-uploads", {
    method: "POST", headers: { Authorization: "Bearer test-only-cleanup-secret-with-more-than-32-chars" },
  }), async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("claim_stale_amuhon_order_asset_cleanup")) return Response.json([ORDER_ID]);
    if (url.includes("/storage/v1/object/amuhon-order-files")) return Response.json({});
    if (url.includes("release_stale_amuhon_order_asset_cleanup")) return Response.json(1);
    throw new Error("unexpected request");
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { cleaned: 1 });
  const deleteCall = calls.find(({ init }) => init.method === "DELETE");
  assert.deepEqual(JSON.parse(String(deleteCall.init.body)).prefixes, [`${ORDER_ID}/body.pdf`, `${ORDER_ID}/cover.png`]);
  assert.ok(calls.some(({ url }) => url.includes("release_stale_amuhon_order_asset_cleanup")));
});
