import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/internal/cleanup-order-uploads/route.ts";
import { POST as cleanupTemp } from "../app/api/internal/cleanup-order-temp-uploads/route.ts";

const ORDER_ID = "d9d71ea0-115c-4b26-8c1d-86bead2aecc4";
process.env.SUPABASE_URL = "https://staging-project-ref.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-server-key";
process.env.ORDER_UPLOAD_CLEANUP_SECRET = "test-only-cleanup-secret-with-more-than-32-chars";

async function invoke(request, mockFetch, handler = POST) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await handler(request);
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

test("temporary upload cleanup only deletes validated attempt-specific paths", async () => {
  const originalFlag = process.env.ORDER_TEMP_UPLOAD_CLEANUP_ENABLED;
  process.env.ORDER_TEMP_UPLOAD_CLEANUP_ENABLED = "true";
  const attemptId = "a9d71ea0-115c-4b26-8c1d-86bead2aecc4";
  const calls = [];
  try {
    const result = await invoke(new Request("https://app.test/api/internal/cleanup-order-temp-uploads", {
      method: "POST", headers: { Authorization: "Bearer test-only-cleanup-secret-with-more-than-32-chars" },
    }), async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("claim_expired_amuhon_order_temp_upload_attempts")) return Response.json([{
        attempt_id: attemptId,
        order_id: ORDER_ID,
        body_object_key: `${ORDER_ID}/${attemptId}/body.pdf`,
        cover_object_key: `${ORDER_ID}/${attemptId}/cover.png`,
      }]);
      if (url.includes("/storage/v1/object/amuhon-order-temp-files")) return Response.json({});
      if (url.includes("finish_amuhon_order_temp_upload_cleanup")) return Response.json(true);
      throw new Error("unexpected request");
    }, cleanupTemp);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { cleaned: 1 });
    const remove = calls.find(({ url }) => url.includes("/storage/v1/object/amuhon-order-temp-files"));
    assert.deepEqual(JSON.parse(String(remove.init.body)).prefixes, [
      `${ORDER_ID}/${attemptId}/body.pdf`, `${ORDER_ID}/${attemptId}/cover.png`,
    ]);
    assert.ok(calls.some(({ url }) => url.includes("finish_amuhon_order_temp_upload_cleanup")));
  } finally {
    if (originalFlag === undefined) delete process.env.ORDER_TEMP_UPLOAD_CLEANUP_ENABLED;
    else process.env.ORDER_TEMP_UPLOAD_CLEANUP_ENABLED = originalFlag;
  }
});

test("temporary cleanup rejects malformed database paths without deleting objects", async () => {
  const originalFlag = process.env.ORDER_TEMP_UPLOAD_CLEANUP_ENABLED;
  process.env.ORDER_TEMP_UPLOAD_CLEANUP_ENABLED = "true";
  let deleted = false;
  try {
    const result = await invoke(new Request("https://app.test/api/internal/cleanup-order-temp-uploads", {
      method: "POST", headers: { Authorization: "Bearer test-only-cleanup-secret-with-more-than-32-chars" },
    }), async (input) => {
      if (String(input).includes("claim_expired_amuhon_order_temp_upload_attempts")) return Response.json([{
        attempt_id: "not-a-uuid", order_id: ORDER_ID, body_object_key: "arbitrary/path", cover_object_key: "arbitrary/cover",
      }]);
      deleted = true;
      throw new Error("unexpected request");
    }, cleanupTemp);
    assert.equal(result.status, 502);
    assert.equal(deleted, false);
  } finally {
    if (originalFlag === undefined) delete process.env.ORDER_TEMP_UPLOAD_CLEANUP_ENABLED;
    else process.env.ORDER_TEMP_UPLOAD_CLEANUP_ENABLED = originalFlag;
  }
});
