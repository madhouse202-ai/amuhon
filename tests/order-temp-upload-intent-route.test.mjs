import assert from "node:assert/strict";
import test from "node:test";
import { POST, tusEndpoint } from "../app/api/orders/[id]/uploads/route.ts";
import { createOrderTusHeaders, inspectOrderTusCredentials, isOrderTusProjectMatch } from "../lib/order-tus.ts";

const ORDER_ID = "d9d71ea0-115c-4b26-8c1d-86bead2aecc4";
const ATTEMPT_ID = "a9d71ea0-115c-4b26-8c1d-86bead2aecc4";
const LEASE_ID = "b9d71ea0-115c-4b26-8c1d-86bead2aecc4";
const TOKEN = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const SIGNED_JWS = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.dGVzdHNpZw";
const originalEnv = Object.fromEntries([
  "NEXT_PUBLIC_ORDER_DIRECT_UPLOAD_EXPERIMENT", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_ORDER_UPLOAD_DIAGNOSTICS", "NODE_ENV", "ORDER_RATE_LIMIT_SECRET", "ORDER_APP_ORIGIN",
].map((name) => [name, process.env[name]]));

function configure(enabled = true, diagnostics = false, nodeEnv = "test") {
  process.env.NEXT_PUBLIC_ORDER_DIRECT_UPLOAD_EXPERIMENT = enabled ? "true" : "false";
  process.env.NEXT_PUBLIC_ORDER_UPLOAD_DIAGNOSTICS = diagnostics ? "true" : "false";
  process.env.NODE_ENV = nodeEnv;
  process.env.SUPABASE_URL = "https://staging-project-ref.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-service-role-secret";
  process.env.ORDER_RATE_LIMIT_SECRET = "test-only-rate-limit-secret-that-is-long-enough";
  process.env.ORDER_APP_ORIGIN = "https://app.test";
}

function request({ token = TOKEN, origin = "https://app.test" } = {}) {
  return new Request(`https://app.test/api/orders/${ORDER_ID}/uploads`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: `amuhon_order_upload_${ORDER_ID}=${token}`,
      "Content-Type": "application/json",
      "x-real-ip": "192.0.2.10",
    },
    body: JSON.stringify({ attemptId: ATTEMPT_ID }),
  });
}

function signedUploadResponse(requestUrl) {
  const signedPath = new URL(requestUrl).pathname.replace("/storage/v1", "");
  const encodedToken = SIGNED_JWS.replaceAll(".", "%2E");
  return Response.json({ url: `${signedPath}?token=${encodedToken}` });
}

async function invoke(req, mockFetch) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await POST(req, { params: Promise.resolve({ id: ORDER_ID }) });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("direct upload is disabled by default unless the explicit experiment flag is enabled", async () => {
  configure(false);
  let called = false;
  const result = await invoke(request(), async () => { called = true; throw new Error("unexpected request"); });
  assert.equal(result.status, 404);
  assert.equal(called, false);
});

test("order ID alone does not grant intent and invalid origin is rejected before RPC", async () => {
  configure(true);
  let called = false;
  const noCookie = new Request(`https://app.test/api/orders/${ORDER_ID}/uploads`, {
    method: "POST", headers: { Origin: "https://app.test", "Content-Type": "application/json" }, body: JSON.stringify({ attemptId: ATTEMPT_ID }),
  });
  assert.equal((await invoke(noCookie, async () => { called = true; })).status, 403);
  assert.equal((await invoke(request({ origin: "https://evil.test" }), async () => { called = true; })).status, 403);
  assert.equal(called, false);
});

test("intent JSON body is bounded even without a Content-Length header", async () => {
  configure(true);
  let called = false;
  const oversized = new Request(`https://app.test/api/orders/${ORDER_ID}/uploads`, {
    method: "POST",
    headers: {
      Origin: "https://app.test",
      Cookie: `amuhon_order_upload_${ORDER_ID}=${TOKEN}`,
      "Content-Type": "application/json",
      "x-real-ip": "192.0.2.10",
    },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1025)); controller.close(); } }),
    duplex: "half",
  });
  const result = await invoke(oversized, async () => { called = true; throw new Error("must reject before RPC"); });
  assert.equal(result.status, 413);
  assert.equal(called, false);
});

test("authorized intent returns only short-lived signed temp-object capabilities", async () => {
  configure(true);
  const calls = [];
  const result = await invoke(request(), async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("get_amuhon_order_temp_upload_attempt")) return Response.json(null);
    if (url.includes("begin_amuhon_order_asset_upload")) return Response.json({ state: "claimed" });
    if (url.includes("register_amuhon_order_temp_upload_attempt")) return Response.json({
      attemptId: ATTEMPT_ID,
      bodyObjectKey: `${ORDER_ID}/${ATTEMPT_ID}/body.pdf`,
      coverObjectKey: `${ORDER_ID}/${ATTEMPT_ID}/cover.png`,
      expiresAt: "2026-10-21T02:00:00.000Z",
    });
    if (url.includes("/storage/v1/object/upload/sign/")) return signedUploadResponse(url);
    throw new Error("unexpected request");
  });
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.equal(body.verified, false);
  assert.equal(body.bucket, "amuhon-order-temp-files");
  assert.equal(body.uploadMaxBytes, 40_000_000);
  assert.equal(body.tusEndpoint, "https://staging-project-ref.storage.supabase.co/storage/v1/upload/resumable/sign");
  assert.match(body.tusEndpoint, /\/upload\/resumable\/sign$/);
  assert.equal(body.bodyObjectKey, `${ORDER_ID}/${ATTEMPT_ID}/body.pdf`);
  assert.equal(body.coverObjectKey, `${ORDER_ID}/${ATTEMPT_ID}/cover.png`);
  assert.equal(body.bodyUploadSignature, SIGNED_JWS);
  assert.equal(body.coverUploadSignature, SIGNED_JWS);
  const tusHeaders = createOrderTusHeaders("test-public-anon-key", body.bodyUploadSignature);
  assert.equal(tusHeaders.apikey, "test-public-anon-key");
  assert.equal(tusHeaders["x-signature"], SIGNED_JWS);
  assert.equal(Object.hasOwn(tusHeaders, "Authorization"), false);
  assert.equal(tusHeaders["x-signature"].startsWith("Bearer "), false);
  assert.doesNotMatch(JSON.stringify(body), /test-only-service-role-secret|0123456789abcdefghijklmnopqrstuvwxyzABCDEFG/);
  const begin = calls.find(({ url }) => url.includes("begin_amuhon_order_asset_upload"));
  const beginArgs = JSON.parse(String(begin.init.body));
  assert.match(beginArgs.p_upload_token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(beginArgs.p_upload_token_hash, TOKEN);
  assert.equal(calls.filter(({ url }) => url.includes("/storage/v1/object/upload/sign/")).length, 2);
  const signatureCalls = calls.filter(({ url }) => url.includes("/storage/v1/object/upload/sign/"));
  assert.ok(signatureCalls.every(({ init }) => init.headers.Authorization === "Bearer test-only-service-role-secret"));
  assert.ok(signatureCalls.every(({ init }) => JSON.parse(String(init.body)).upsert === false));
  assert.equal(calls.some(({ url }) => url.includes("/storage/v1/upload/resumable")), false);
});

test("signed TUS endpoint always ends with /upload/resumable/sign", () => {
  assert.equal(
    tusEndpoint(new URL("https://staging-project-ref.supabase.co")),
    "https://staging-project-ref.storage.supabase.co/storage/v1/upload/resumable/sign",
  );
  assert.equal(
    tusEndpoint(new URL("https://supabase.example.test:8443/custom/path")),
    "https://supabase.example.test:8443/storage/v1/upload/resumable/sign",
  );
});

test("diagnostics are opt-in development-only booleans and compare the same project", async () => {
  configure(true, true, "development");
  const result = await invoke(request(), async (input) => {
    const url = String(input);
    if (url.includes("get_amuhon_order_temp_upload_attempt")) return Response.json(null);
    if (url.includes("begin_amuhon_order_asset_upload")) return Response.json({ state: "claimed" });
    if (url.includes("register_amuhon_order_temp_upload_attempt")) return Response.json({
      attemptId: ATTEMPT_ID,
      bodyObjectKey: `${ORDER_ID}/${ATTEMPT_ID}/body.pdf`,
      coverObjectKey: `${ORDER_ID}/${ATTEMPT_ID}/cover.png`,
      expiresAt: "2026-10-21T02:00:00.000Z",
    });
    if (url.includes("/storage/v1/object/upload/sign/")) return signedUploadResponse(url);
    throw new Error("unexpected request");
  });
  const body = await result.json();
  assert.equal(body.diagnostics.signerAndTusProjectMatch, true);
  assert.deepEqual(Object.keys(body.diagnostics), ["signerAndTusProjectMatch"]);
  const credentialResult = inspectOrderTusCredentials(SIGNED_JWS, SIGNED_JWS, "public-key", "public-key");
  assert.deepEqual(credentialResult, {
    signatureMatches: true,
    signaturePresent: true,
    signatureHasThreeParts: true,
    apiKeyMatches: true,
  });
  assert.doesNotMatch(JSON.stringify(body.diagnostics), /eyJ|test|public-key|hash/i);
  assert.equal(isOrderTusProjectMatch("https://staging-project-ref.supabase.co", "https://other-project.storage.supabase.co/storage/v1/upload/resumable"), false);

  configure(true, true, "production");
  const productionResult = await invoke(request(), async (input) => {
    const url = String(input);
    if (url.includes("get_amuhon_order_temp_upload_attempt")) return Response.json(null);
    if (url.includes("begin_amuhon_order_asset_upload")) return Response.json({ state: "claimed" });
    if (url.includes("register_amuhon_order_temp_upload_attempt")) return Response.json({
      attemptId: ATTEMPT_ID,
      bodyObjectKey: `${ORDER_ID}/${ATTEMPT_ID}/body.pdf`,
      coverObjectKey: `${ORDER_ID}/${ATTEMPT_ID}/cover.png`,
      expiresAt: "2026-10-21T02:00:00.000Z",
    });
    if (url.includes("/storage/v1/object/upload/sign/")) return signedUploadResponse(url);
    throw new Error("unexpected request");
  });
  const productionBody = await productionResult.json();
  assert.equal(Object.hasOwn(productionBody, "diagnostics"), false);
});

test("credential diagnostic returns only booleans on mismatch and malformed values", () => {
  const result = inspectOrderTusCredentials("expected", "Bearer altered", "configured", "other");
  assert.deepEqual(result, {
    signatureMatches: false,
    signaturePresent: true,
    signatureHasThreeParts: false,
    apiKeyMatches: false,
  });
  assert.equal(Object.values(result).every((value) => typeof value === "boolean"), true);
});

test("signed upload response rejects malformed JWS without returning or logging its value", async () => {
  configure(true);
  const malformedToken = "not-a-compact-jws";
  const result = await invoke(request(), async (input) => {
    const url = String(input);
    if (url.includes("get_amuhon_order_temp_upload_attempt")) return Response.json(null);
    if (url.includes("begin_amuhon_order_asset_upload")) return Response.json({ state: "claimed" });
    if (url.includes("register_amuhon_order_temp_upload_attempt")) return Response.json({
      attemptId: ATTEMPT_ID,
      bodyObjectKey: `${ORDER_ID}/${ATTEMPT_ID}/body.pdf`,
      coverObjectKey: `${ORDER_ID}/${ATTEMPT_ID}/cover.png`,
      expiresAt: "2026-10-21T02:00:00.000Z",
    });
    if (url.includes("/storage/v1/object/upload/sign/")) {
      const signedPath = new URL(url).pathname.replace("/storage/v1", "");
      return Response.json({ url: `${signedPath}?token=${malformedToken}` });
    }
    throw new Error("unexpected request");
  });
  const body = await result.text();
  assert.equal(result.status, 502);
  assert.doesNotMatch(body, /not-a-compact-jws/);
});

test("same authorized attempt can recover its lease and reissue signatures for identical keys", async () => {
  configure(true);
  const calls = [];
  const result = await invoke(request(), async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("get_amuhon_order_temp_upload_attempt")) return Response.json({
      attemptId: ATTEMPT_ID,
      leaseId: LEASE_ID,
      bodyObjectKey: `${ORDER_ID}/${ATTEMPT_ID}/body.pdf`,
      coverObjectKey: `${ORDER_ID}/${ATTEMPT_ID}/cover.png`,
      expiresAt: "2026-10-21T02:00:00.000Z",
    });
    if (url.includes("begin_amuhon_order_asset_upload")) return Response.json({ state: "claimed" });
    if (url.includes("register_amuhon_order_temp_upload_attempt")) return Response.json({
      attemptId: ATTEMPT_ID,
      bodyObjectKey: `${ORDER_ID}/${ATTEMPT_ID}/body.pdf`,
      coverObjectKey: `${ORDER_ID}/${ATTEMPT_ID}/cover.png`,
      expiresAt: "2026-10-21T02:00:00.000Z",
    });
    if (url.includes("/storage/v1/object/upload/sign/")) return signedUploadResponse(url);
    throw new Error("unexpected request");
  });
  assert.equal(result.status, 200);
  assert.equal(calls.filter(({ url }) => url.includes("begin_amuhon_order_asset_upload")).length, 1);
  const register = calls.find(({ url }) => url.includes("register_amuhon_order_temp_upload_attempt"));
  assert.equal(JSON.parse(String(register.init.body)).p_lease_id, LEASE_ID);
  assert.equal((await result.json()).bodyObjectKey, `${ORDER_ID}/${ATTEMPT_ID}/body.pdf`);
});

test("expired attempt rotates to a new immutable key instead of reusing or overwriting the old object", async () => {
  configure(true);
  const calls = [];
  let freshAttemptId;
  const result = await invoke(request(), async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("get_amuhon_order_temp_upload_attempt")) return Response.json({
      attemptId: ATTEMPT_ID,
      leaseId: LEASE_ID,
      bodyObjectKey: `${ORDER_ID}/${ATTEMPT_ID}/body.pdf`,
      coverObjectKey: `${ORDER_ID}/${ATTEMPT_ID}/cover.png`,
      expiresAt: "2026-10-19T02:00:00.000Z",
    });
    if (url.includes("begin_amuhon_order_asset_upload")) return Response.json({ state: "claimed" });
    if (url.includes("register_amuhon_order_temp_upload_attempt")) {
      const args = JSON.parse(String(init.body));
      if (args.p_attempt_id === ATTEMPT_ID) {
        return Response.json({ message: "UPLOAD_ATTEMPT_NOT_REUSABLE" }, { status: 400 });
      }
      freshAttemptId = args.p_attempt_id;
      return Response.json({
        attemptId: freshAttemptId,
        bodyObjectKey: `${ORDER_ID}/${freshAttemptId}/body.pdf`,
        coverObjectKey: `${ORDER_ID}/${freshAttemptId}/cover.png`,
        expiresAt: "2026-10-21T02:00:00.000Z",
      });
    }
    if (url.includes("/storage/v1/object/upload/sign/")) return signedUploadResponse(url);
    throw new Error("unexpected request");
  });
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.match(freshAttemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(freshAttemptId, ATTEMPT_ID);
  assert.equal(body.attemptId, freshAttemptId);
  assert.equal(body.bodyObjectKey, `${ORDER_ID}/${freshAttemptId}/body.pdf`);
  assert.equal(body.coverObjectKey, `${ORDER_ID}/${freshAttemptId}/cover.png`);
  const begin = calls.find(({ url }) => url.includes("begin_amuhon_order_asset_upload"));
  assert.equal(JSON.parse(String(begin.init.body)).p_lease_id, LEASE_ID);
  const registerCalls = calls.filter(({ url }) => url.includes("register_amuhon_order_temp_upload_attempt"));
  assert.equal(registerCalls.length, 2);
  assert.equal(JSON.parse(String(registerCalls[0].init.body)).p_attempt_id, ATTEMPT_ID);
  assert.equal(JSON.parse(String(registerCalls[1].init.body)).p_attempt_id, freshAttemptId);
  const signUrls = calls.filter(({ url }) => url.includes("/storage/v1/object/upload/sign/")).map(({ url }) => url);
  assert.ok(signUrls.length === 2 && signUrls.every((url) => url.includes(freshAttemptId)));
});

test("test-only environment is restored", () => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
