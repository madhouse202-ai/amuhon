import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/orders/[id]/validation/route.ts";
import { hashOrderUploadToken } from "../lib/order-upload-token.ts";

const ORDER_ID = "d9d71ea0-115c-4b26-8c1d-86bead2aecc4";
const ATTEMPT_ID = "a9d71ea0-115c-4b26-8c1d-86bead2aecc4";
const TOKEN = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const ENV_KEYS = [
  "NEXT_PUBLIC_ORDER_DIRECT_UPLOAD_EXPERIMENT",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ORDER_APP_ORIGIN",
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function configure(enabled = true) {
  process.env.NEXT_PUBLIC_ORDER_DIRECT_UPLOAD_EXPERIMENT = enabled ? "true" : "false";
  process.env.SUPABASE_URL = "https://staging-project-ref.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-service-role-secret";
  process.env.ORDER_APP_ORIGIN = "https://app.test";
}

function request({ orderId = ORDER_ID, attemptId = ATTEMPT_ID, token = TOKEN, origin = "https://app.test", body } = {}) {
  const headers = { Origin: origin, "Content-Type": "application/json" };
  if (token) headers.Cookie = `amuhon_order_upload_${orderId}=${token}`;
  return new Request(`https://app.test/api/orders/${orderId}/validation`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? { attemptId }),
  });
}

async function invoke(req, mockFetch) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await POST(req, { params: Promise.resolve({ id: new URL(req.url).pathname.split("/")[3] }) });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("feature-disabled endpoint does not call Supabase", async () => {
  configure(false);
  let called = false;
  const response = await invoke(request(), async () => { called = true; throw new Error("unexpected fetch"); });
  assert.equal(response.status, 404);
  assert.equal(called, false);
});

test("missing upload cookie and invalid Origin are rejected before RPC", async () => {
  configure();
  let called = false;
  const noCookie = await invoke(request({ token: null }), async () => { called = true; });
  const wrongOrigin = await invoke(request({ origin: "https://evil.test" }), async () => { called = true; });
  assert.equal(noCookie.status, 403);
  assert.equal(wrongOrigin.status, 403);
  assert.equal(called, false);
});

test("malformed order or attempt identifiers are rejected before RPC", async () => {
  configure();
  let called = false;
  const invalidOrder = await invoke(request({ orderId: "not-an-order-id", token: null }), async () => { called = true; });
  const invalidAttempt = await invoke(request({ body: { attemptId: "bad-id" } }), async () => { called = true; });
  const extraSecret = await invoke(request({ body: { attemptId: ATTEMPT_ID, uploadToken: TOKEN } }), async () => { called = true; });
  assert.equal(invalidOrder.status, 400);
  assert.equal(invalidAttempt.status, 400);
  assert.equal(extraSecret.status, 400);
  assert.equal(called, false);
});

test("authorized request sends only server-derived token hash and returns safe job state", async () => {
  configure();
  let rpcUrl;
  let rpcArgs;
  let rpcHeaders;
  const response = await invoke(request(), async (url, init) => {
    rpcUrl = String(url);
    rpcArgs = JSON.parse(String(init.body));
    rpcHeaders = init.headers;
    return Response.json({ attemptId: ATTEMPT_ID, state: "queued", attemptCount: 0, createdAt: "2026-10-25T00:00:00Z" });
  });

  assert.equal(response.status, 200);
  const responseBody = await response.json();
  assert.deepEqual(responseBody, { state: "queued" });
  assert.match(rpcUrl, /\/rest\/v1\/rpc\/enqueue_amuhon_order_validation_job$/);
  assert.deepEqual(rpcArgs, {
    p_order_id: ORDER_ID,
    p_upload_token_hash: hashOrderUploadToken(TOKEN),
    p_attempt_id: ATTEMPT_ID,
  });
  assert.match(rpcArgs.p_upload_token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(rpcArgs.p_upload_token_hash, TOKEN);
  assert.equal(rpcHeaders.apikey, "test-only-service-role-secret");
  assert.equal(rpcHeaders.Authorization, "Bearer test-only-service-role-secret");
  assert.doesNotMatch(JSON.stringify(responseBody), /test-only-service-role-secret|0123456789abcdefghijklmnopqrstuvwxyzABCDEFG/);
});

test("duplicate registration requests use the same attempt and accept the idempotent existing job", async () => {
  configure();
  const calls = [];
  const mockFetch = async (_url, init) => {
    const args = JSON.parse(String(init.body));
    calls.push(args);
    return Response.json({ attemptId: ATTEMPT_ID, state: "queued", attemptCount: 0, createdAt: "2026-10-25T00:00:00Z" });
  };
  const first = await invoke(request(), mockFetch);
  const second = await invoke(request(), mockFetch);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(await first.json(), { state: "queued" });
  assert.deepEqual(await second.json(), { state: "queued" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
});

test("RPC failures are translated to safe client errors", async () => {
  configure();
  const rejectedAttempt = await invoke(request(), async () => Response.json({ message: "UPLOAD_ATTEMPT_NOT_ACTIVE" }, { status: 400 }));
  const unavailable = await invoke(request(), async () => Response.json({ message: "database-internal-detail" }, { status: 500 }));
  assert.equal(rejectedAttempt.status, 409);
  assert.equal(unavailable.status, 502);
  assert.doesNotMatch(await unavailable.text(), /database-internal-detail/);
});

test("environment is restored after tests", () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
