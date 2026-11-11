import assert from "node:assert/strict";
import test from "node:test";
import { POST as checkoutPost } from "../app/api/orders/[id]/checkout/route.ts";
import { GET as statusGet } from "../app/api/orders/[id]/status/route.ts";

const ORDER_ID = "d9d71ea0-115c-4b26-8c1d-86bead2aecc4";
const TOKEN = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const COOKIE = `amuhon_order_upload_${ORDER_ID}=${TOKEN}`;
const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_abc123";
const originalEnv = { ...process.env };

function setTestEnv(stripeKey = "sk_test_server-only-key") {
  process.env.STRIPE_MODE = "test";
  process.env.SUPABASE_URL = "https://mock-project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  process.env.STRIPE_SECRET_KEY = stripeKey;
  process.env.ORDER_APP_ORIGIN = "https://app.test";
}

function request({ cookie = COOKIE, origin = "https://app.test" } = {}) {
  return new Request(`https://app.test/api/orders/${ORDER_ID}/checkout`, {
    method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: "{}",
  });
}

async function invoke(mockFetch, options) {
  const originalFetch = globalThis.fetch;
  setTestEnv();
  globalThis.fetch = mockFetch;
  try { return await checkoutPost(request(options), { params: Promise.resolve({ id: ORDER_ID }) }); }
  finally { globalThis.fetch = originalFetch; }
}

test("checkout rejects missing capability and wrong Origin before RPC or Stripe", async () => {
  let calls = 0;
  const mock = async () => { calls += 1; throw new Error("network must not be reached"); };
  assert.equal((await invoke(mock, { cookie: "" })).status, 403);
  assert.equal((await invoke(mock, { origin: "https://attacker.test" })).status, 403);
  assert.equal(calls, 0);
});

test("live Stripe keys are refused in explicit test mode before checkout state can be changed", async () => {
  const originalFetch = globalThis.fetch;
  setTestEnv("sk_live_never-allowed");
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("unexpected fetch"); };
  try {
    const response = await checkoutPost(request(), { params: Promise.resolve({ id: ORDER_ID }) });
    assert.equal(response.status, 503);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("missing mode or a key prefix inconsistent with the selected mode fails before any RPC or Stripe request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("unexpected fetch"); };
  try {
    setTestEnv();
    delete process.env.STRIPE_MODE;
    const missingMode = await checkoutPost(request(), { params: Promise.resolve({ id: ORDER_ID }) });
    assert.equal(missingMode.status, 503);

    setTestEnv("sk_live_wrong-mode-key");
    const mismatchedKey = await checkoutPost(request(), { params: Promise.resolve({ id: ORDER_ID }) });
    assert.equal(mismatchedKey.status, 503);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("database mode mismatch and missing mode response stop before creating a Stripe session", async () => {
  const originalFetch = globalThis.fetch;
  setTestEnv();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ state: "create_session", livemode: true });
  };
  try {
    const response = await checkoutPost(request(), { params: Promise.resolve({ id: ORDER_ID }) });
    assert.equal(response.status, 409);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("explicit live mode creates and records only a matching live Checkout Session", async () => {
  const originalFetch = globalThis.fetch;
  process.env.STRIPE_MODE = "live";
  process.env.SUPABASE_URL = "https://mock-project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  process.env.STRIPE_SECRET_KEY = "sk_live_server-only-mock-key";
  process.env.ORDER_APP_ORIGIN = "https://app.test";
  const attemptId = "5c8c89d2-1000-4f6e-8db2-2bda904b5710";
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const liveUrl = "https://checkout.stripe.com/c/pay/cs_live_abc123";
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/rpc/begin_amuhon_order_checkout_v2")) {
      const args = JSON.parse(String(init.body));
      assert.equal(args.p_livemode, true);
      return Response.json({ state: "create_session", attemptId, pageCount: 64, amountYen: 1980, currency: "JPY", attemptStartedAt: startedAt, livemode: true });
    }
    if (url === "https://api.stripe.com/v1/checkout/sessions") {
      assert.equal(init.headers.Authorization, "Bearer sk_live_server-only-mock-key");
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get("line_items[0][price_data][unit_amount]"), "1980");
      return Response.json({
        id: "cs_live_abc123", url: liveUrl, expires_at: Number(form.get("expires_at")),
        object: "checkout.session", livemode: true, status: "open", mode: "payment", currency: "jpy", amount_total: 1980,
        client_reference_id: ORDER_ID, metadata: { order_id: ORDER_ID, checkout_attempt_id: attemptId },
      });
    }
    if (url.endsWith("/rpc/record_amuhon_order_checkout_session_v2")) {
      const args = JSON.parse(String(init.body));
      assert.equal(args.p_session_id, "cs_live_abc123");
      assert.equal(args.p_livemode, true);
      return Response.json({ state: "recorded", livemode: true });
    }
    throw new Error("unexpected request target");
  };
  try {
    const response = await checkoutPost(request(), { params: Promise.resolve({ id: ORDER_ID }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { checkoutUrl: liveUrl });
    assert.equal(calls.length, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test("checkout charges only the database-authorized server amount and records an idempotent test session", async () => {
  const calls = [];
  const attemptId = "5c8c89d2-1000-4f6e-8db2-2bda904b5710";
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const response = await invoke(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/rpc/begin_amuhon_order_checkout_v2")) {
      const args = JSON.parse(String(init.body));
      assert.equal(args.p_order_id, ORDER_ID);
      assert.equal(args.p_livemode, false);
      assert.match(args.p_upload_token_hash, /^[a-f0-9]{64}$/);
      return Response.json({ state: "create_session", attemptId, pageCount: 24, amountYen: 1980, currency: "JPY", attemptStartedAt: startedAt, livemode: false });
    }
    if (url === "https://api.stripe.com/v1/checkout/sessions") {
      assert.equal(init.headers.Authorization, "Bearer sk_test_server-only-key");
      assert.match(init.headers["Idempotency-Key"], new RegExp(`${ORDER_ID}-${attemptId}$`));
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get("line_items[0][price_data][unit_amount]"), "1980");
      assert.equal(form.get("line_items[0][price_data][currency]"), "jpy");
      assert.equal(form.get("payment_method_types[0]"), "card");
      assert.equal(form.get("metadata[order_id]"), ORDER_ID);
      assert.equal(form.get("metadata[checkout_attempt_id]"), attemptId);
      assert.match(form.get("success_url"), /session_id=%7BCHECKOUT_SESSION_ID%7D|session_id=\{CHECKOUT_SESSION_ID\}/);
      return Response.json({
        id: "cs_test_abc123", url: CHECKOUT_URL, expires_at: Number(form.get("expires_at")),
        object: "checkout.session", livemode: false, status: "open", mode: "payment", currency: "jpy", amount_total: 1980, client_reference_id: ORDER_ID,
        metadata: { order_id: ORDER_ID, checkout_attempt_id: attemptId },
      });
    }
    if (url.endsWith("/rpc/record_amuhon_order_checkout_session_v2")) {
      const args = JSON.parse(String(init.body));
      assert.equal(args.p_session_id, "cs_test_abc123");
      assert.equal(args.p_checkout_attempt_id, attemptId);
      assert.equal(args.p_upload_token_hash.length, 64);
      assert.equal(args.p_livemode, false);
      return Response.json({ state: "recorded" });
    }
    throw new Error("unexpected request target");
  });
  assert.equal(response.status, 200);
  const returned = await response.json();
  assert.deepEqual(returned, { checkoutUrl: CHECKOUT_URL });
  assert.equal(calls.length, 3);
  assert.equal(JSON.stringify(returned).includes("sk_test_"), false);
});

test("unverified files, unsupported page counts, and SQL price mismatches never call Stripe", async () => {
  for (const beginResult of [
    { state: "error" },
    { state: "create_session", attemptId: "5c8c89d2-1000-4f6e-8db2-2bda904b5710", pageCount: 301, amountYen: 3180, currency: "JPY", attemptStartedAt: new Date().toISOString(), livemode: false },
    { state: "create_session", attemptId: "5c8c89d2-1000-4f6e-8db2-2bda904b5710", pageCount: 24, amountYen: 1, currency: "JPY", attemptStartedAt: new Date().toISOString(), livemode: false },
  ]) {
    let stripeCalls = 0;
    const response = await invoke(async (input) => {
      if (String(input).includes("begin_amuhon_order_checkout_v2")) return Response.json(beginResult, { status: beginResult.state === "error" ? 409 : 200 });
      if (String(input).startsWith("https://api.stripe.com/")) stripeCalls += 1;
      throw new Error("no further call expected");
    });
    assert.notEqual(response.status, 200);
    assert.equal(stripeCalls, 0);
  }
});

test("existing Stripe session URL is reused without creating another session", async () => {
  let stripeCalls = 0;
  const response = await invoke(async (input) => {
    const url = String(input);
    if (url.includes("begin_amuhon_order_checkout_v2")) return Response.json({ state: "session_available", sessionId: "cs_test_abc123", checkoutUrl: CHECKOUT_URL, livemode: false });
    stripeCalls += 1;
    throw new Error("new Stripe session must not be created");
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { checkoutUrl: CHECKOUT_URL });
  assert.equal(stripeCalls, 0);
});

test("retrying an uncertain Stripe request reuses the exact idempotency key and request body", async () => {
  const attemptId = "5c8c89d2-1000-4f6e-8db2-2bda904b5710";
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const stripeBodies = [];
  const idempotencyKeys = [];
  const mockFetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("begin_amuhon_order_checkout_v2")) return Response.json({
      state: "create_session", attemptId, pageCount: 24, amountYen: 1980, currency: "JPY", attemptStartedAt: startedAt, livemode: false,
    });
    if (url === "https://api.stripe.com/v1/checkout/sessions") {
      stripeBodies.push(String(init.body));
      idempotencyKeys.push(init.headers["Idempotency-Key"]);
      const form = new URLSearchParams(String(init.body));
      return Response.json({
        id: "cs_test_abc123", object: "checkout.session", url: CHECKOUT_URL,
        expires_at: Number(form.get("expires_at")), livemode: false, status: "open", mode: "payment",
        currency: "jpy", amount_total: 1980, client_reference_id: ORDER_ID,
        metadata: { order_id: ORDER_ID, checkout_attempt_id: attemptId },
      });
    }
    if (url.includes("record_amuhon_order_checkout_session_v2")) return Response.json({ state: "recorded" });
    throw new Error("unexpected request");
  };
  const first = await invoke(mockFetch);
  const second = await invoke(mockFetch);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(stripeBodies.length, 2);
  assert.equal(stripeBodies[0], stripeBodies[1]);
  assert.equal(idempotencyKeys[0], idempotencyKeys[1]);
});

test("Stripe response with mismatched amount or URL is not recorded or returned", async () => {
  const attemptId = "5c8c89d2-1000-4f6e-8db2-2bda904b5710";
  let recordCalls = 0;
  const response = await invoke(async (input, init = {}) => {
    const url = String(input);
    if (url.includes("begin_amuhon_order_checkout_v2")) return Response.json({
      state: "create_session", attemptId, pageCount: 24, amountYen: 1980, currency: "JPY", attemptStartedAt: new Date().toISOString(), livemode: false,
    });
    if (url.startsWith("https://api.stripe.com/")) return Response.json({
      id: "cs_test_abc123", url: "https://evil.test/pay", expires_at: Number(new URLSearchParams(String(init.body)).get("expires_at")),
      object: "checkout.session", livemode: false, status: "open", mode: "payment", currency: "jpy", amount_total: 1, client_reference_id: ORDER_ID,
      metadata: { order_id: ORDER_ID, checkout_attempt_id: attemptId },
    });
    if (url.includes("record_amuhon_order_checkout_session_v2")) recordCalls += 1;
    throw new Error("unexpected request");
  });
  assert.equal(response.status, 502);
  assert.equal(recordCalls, 0);
  assert.doesNotMatch(await response.text(), /sk_test_|service-role-test-only/);
});

test("Stripe response with a mismatched livemode is not recorded or returned", async () => {
  const attemptId = "5c8c89d2-1000-4f6e-8db2-2bda904b5710";
  let recordCalls = 0;
  const response = await invoke(async (input, init = {}) => {
    const url = String(input);
    if (url.includes("begin_amuhon_order_checkout_v2")) return Response.json({
      state: "create_session", attemptId, pageCount: 24, amountYen: 1980, currency: "JPY", attemptStartedAt: new Date().toISOString(), livemode: false,
    });
    if (url === "https://api.stripe.com/v1/checkout/sessions") return Response.json({
      id: "cs_test_abc123", url: CHECKOUT_URL, expires_at: Number(new URLSearchParams(String(init.body)).get("expires_at")),
      object: "checkout.session", livemode: true, status: "open", mode: "payment", currency: "jpy", amount_total: 1980,
      client_reference_id: ORDER_ID, metadata: { order_id: ORDER_ID, checkout_attempt_id: attemptId },
    });
    if (url.includes("record_amuhon_order_checkout_session_v2")) recordCalls += 1;
    throw new Error("unexpected request");
  });
  assert.equal(response.status, 502);
  assert.equal(recordCalls, 0);
});

test("status endpoint requires the order capability and returns only payment-safe fields", async () => {
  const originalFetch = globalThis.fetch;
  setTestEnv();
  let rpcArgs;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /get_amuhon_order_checkout_status$/);
    rpcArgs = JSON.parse(String(init.body));
    return Response.json({ orderId: ORDER_ID, status: "ready_for_payment", pageCount: 24, filesVerified: true,
      quotedAmountYen: 1980, amountYen: 1980, currency: "JPY", priceConsistent: true, canCheckout: true, checkoutState: "not_started",
      livemode: false,
      customer: { email: "must-not-escape@example.test" } });
  };
  try {
    const response = await statusGet(new Request(`https://app.test/api/orders/${ORDER_ID}/status`, { headers: { Cookie: COOKIE } }), {
      params: Promise.resolve({ id: ORDER_ID }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(rpcArgs.p_order_id, ORDER_ID);
    assert.match(rpcArgs.p_upload_token_hash, /^[a-f0-9]{64}$/);
    assert.equal(result.quotedAmountYen, 1980);
    assert.equal(result.livemode, false);
    assert.equal("customer" in result, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("test-only environment is restored", () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(originalEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});
