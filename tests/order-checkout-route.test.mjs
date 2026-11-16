import assert from "node:assert/strict";
import test from "node:test";
import { POST as checkoutPost } from "../app/api/orders/[id]/checkout/route.ts";
import { GET as statusGet } from "../app/api/orders/[id]/status/route.ts";
import { callOrderRpc, getSupabaseServerConfig } from "../lib/order-checkout-server.ts";

const ORDER_ID = "d9d71ea0-115c-4b26-8c1d-86bead2aecc4";
const TOKEN = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const COOKIE = `amuhon_order_upload_${ORDER_ID}=${TOKEN}`;
const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_abc123";
const originalEnv = { ...process.env };

function setTestEnv(stripeKey = "sk_test_server-only-key") {
  process.env.STRIPE_MODE = "test";
  process.env.SUPABASE_URL = "https://mock-project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_mock-only-not-a-real-key";
  process.env.STRIPE_SECRET_KEY = stripeKey;
  process.env.ORDER_APP_ORIGIN = "https://app.test";
}

test("checkout server RPC uses a new secret as apikey only", async () => {
  const originalFetch = globalThis.fetch;
  setTestEnv();
  process.env.SUPABASE_SECRET_KEY = "sb_secret_mock-only-not-a-real-key";
  let request;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), headers: new Headers(init.headers), redirect: init.redirect };
    return Response.json({ ok: true });
  };
  try {
    const config = getSupabaseServerConfig();
    assert.equal(config?.serviceCredential.source, "secret");
    const result = await callOrderRpc(config, "fixed_mock_rpc", {});
    assert.equal(result.ok, true);
    assert.match(request.url, /\/rpc\/fixed_mock_rpc$/);
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.get("apikey"), "sb_secret_mock-only-not-a-real-key");
    assert.equal(request.headers.has("authorization"), false);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SUPABASE_SECRET_KEY;
  }
});

function request({ cookie = COOKIE, origin = "https://app.test" } = {}) {
  return new Request(`https://app.test/api/orders/${ORDER_ID}/checkout`, {
    method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: "{}",
  });
}

async function invoke(mockFetch, options = {}) {
  const originalFetch = globalThis.fetch;
  const {
    trustedCheckoutHosts = ["checkout.stripe.com"],
    allowlistResponse = null,
    allowlistError = null,
    ...requestOptions
  } = options;
  setTestEnv();
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/rpc/get_amuhon_stripe_checkout_allowed_hosts_v1")) {
      if (allowlistError) throw allowlistError;
      if (allowlistResponse) return Response.json(allowlistResponse.data, { status: allowlistResponse.status ?? 200 });
      return Response.json({ hosts: trustedCheckoutHosts });
    }
    return mockFetch(input, init);
  };
  try { return await checkoutPost(request(requestOptions), { params: Promise.resolve({ id: ORDER_ID }) }); }
  finally { globalThis.fetch = originalFetch; }
}

async function invokeWithCapturedErrors(mockFetch, options = {}) {
  const originalError = console.error;
  const messages = [];
  console.error = (...parts) => messages.push(parts.map(String).join(" "));
  try {
    const response = await invoke(mockFetch, options);
    return { response, messages };
  } finally {
    console.error = originalError;
  }
}

function validSessionResponse(attemptId, expiresAt, overrides = {}) {
  return {
    id: "cs_test_abc123",
    url: CHECKOUT_URL,
    expires_at: expiresAt,
    object: "checkout.session",
    livemode: false,
    status: "open",
    mode: "payment",
    currency: "jpy",
    amount_total: 1980,
    client_reference_id: ORDER_ID,
    metadata: { order_id: ORDER_ID, checkout_attempt_id: attemptId },
    ...overrides,
  };
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
  globalThis.fetch = async (input) => {
    calls += 1;
    if (String(input).endsWith("/rpc/get_amuhon_stripe_checkout_allowed_hosts_v1")) return Response.json({ hosts: ["checkout.stripe.com"] });
    return Response.json({ state: "create_session", livemode: true });
  };
  try {
    const response = await checkoutPost(request(), { params: Promise.resolve({ id: ORDER_ID }) });
    assert.equal(response.status, 409);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("explicit live mode creates and records only a matching live Checkout Session", async () => {
  const originalFetch = globalThis.fetch;
  process.env.STRIPE_MODE = "live";
  process.env.SUPABASE_URL = "https://mock-project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_mock-only-not-a-real-key";
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
    if (url.endsWith("/rpc/get_amuhon_stripe_checkout_allowed_hosts_v1")) return Response.json({ hosts: ["checkout.stripe.com"] });
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
    assert.deepEqual(await response.json(), { checkoutUrl: liveUrl, checkoutHost: "checkout.stripe.com" });
    assert.equal(calls.length, 4);
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
      assert.equal(init.redirect, "error");
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
  assert.deepEqual(returned, { checkoutUrl: CHECKOUT_URL, checkoutHost: "checkout.stripe.com" });
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
  assert.deepEqual(await response.json(), { checkoutUrl: CHECKOUT_URL, checkoutHost: "checkout.stripe.com" });
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

test("trusted HTTPS Stripe Checkout URLs do not depend on an undocumented path and allow fragments", async () => {
  const attemptId = "5c8c89d2-1000-4f6e-8db2-2bda904b5710";
  const customUrl = "https://checkout.brand.example:443/checkout/session?state=opaque#stripe-fragment";
  let recordCalls = 0;
  const response = await invoke(async (input, init = {}) => {
    const url = String(input);
    if (url.includes("begin_amuhon_order_checkout_v2")) return Response.json({
      state: "create_session", attemptId, pageCount: 24, amountYen: 1980, currency: "JPY", attemptStartedAt: new Date().toISOString(), livemode: false,
    });
    if (url === "https://api.stripe.com/v1/checkout/sessions") {
      const expiresAt = Number(new URLSearchParams(String(init.body)).get("expires_at"));
      return Response.json(validSessionResponse(attemptId, expiresAt, { url: customUrl }));
    }
    if (url.includes("record_amuhon_order_checkout_session_v2")) {
      recordCalls += 1;
      return Response.json({ state: "recorded" });
    }
    throw new Error("unexpected request");
  }, { trustedCheckoutHosts: ["checkout.brand.example", "checkout.stripe.com"] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { checkoutUrl: customUrl, checkoutHost: "checkout.brand.example" });
  assert.equal(recordCalls, 1);
});

test("Stripe response validation emits only the fixed failure code and never records rejected sessions", async () => {
  const cases = [
    {
      name: "untrusted URL host",
      override: (attemptId, expiresAt) => validSessionResponse(attemptId, expiresAt, { url: "https://evil.example/pay" }),
      expectedCode: "SESSION_URL_HOST_NOT_TRUSTED",
    },
    {
      name: "wrong URL scheme",
      override: (attemptId, expiresAt) => validSessionResponse(attemptId, expiresAt, { url: "http://checkout.stripe.com/c/pay/cs_test_abc123" }),
      expectedCode: "SESSION_URL_SCHEME_NOT_HTTPS",
    },
    {
      name: "URL userinfo is rejected",
      override: (attemptId, expiresAt) => validSessionResponse(attemptId, expiresAt, { url: "https://attacker@checkout.stripe.com/pay" }),
      expectedCode: "SESSION_URL_AUTHORITY_INVALID",
    },
    {
      name: "non-default URL port is rejected",
      override: (attemptId, expiresAt) => validSessionResponse(attemptId, expiresAt, { url: "https://checkout.stripe.com:444/pay" }),
      expectedCode: "SESSION_URL_AUTHORITY_INVALID",
    },
    {
      name: "wrong amount",
      override: (attemptId, expiresAt) => validSessionResponse(attemptId, expiresAt, { amount_total: 1 }),
      expectedCode: "SESSION_AMOUNT_MISMATCH",
    },
    {
      name: "wrong currency",
      override: (attemptId, expiresAt) => validSessionResponse(attemptId, expiresAt, { currency: "usd" }),
      expectedCode: "SESSION_CURRENCY_MISMATCH",
    },
    {
      name: "wrong Checkout mode",
      override: (attemptId, expiresAt) => validSessionResponse(attemptId, expiresAt, { mode: "subscription" }),
      expectedCode: "SESSION_MODE_MISMATCH",
    },
    {
      name: "wrong client reference",
      override: (attemptId, expiresAt) => validSessionResponse(attemptId, expiresAt, { client_reference_id: "different-order" }),
      expectedCode: "SESSION_CLIENT_REFERENCE_MISMATCH",
    },
    {
      name: "wrong livemode",
      override: (attemptId, expiresAt) => validSessionResponse(attemptId, expiresAt, { livemode: true }),
      expectedCode: "SESSION_LIVEMODE_MISMATCH",
    },
    {
      name: "wrong order metadata",
      override: (attemptId, expiresAt) => validSessionResponse(attemptId, expiresAt, {
        metadata: { order_id: "other-order-value", checkout_attempt_id: attemptId },
      }),
      expectedCode: "SESSION_ORDER_METADATA_MISMATCH",
    },
    {
      name: "wrong attempt metadata",
      override: (attemptId, expiresAt) => validSessionResponse(attemptId, expiresAt, {
        metadata: { order_id: ORDER_ID, checkout_attempt_id: "other-attempt-value" },
      }),
      expectedCode: "SESSION_ATTEMPT_METADATA_MISMATCH",
    },
  ];

  for (const scenario of cases) {
    const attemptId = "5c8c89d2-1000-4f6e-8db2-2bda904b5710";
    let recordCalls = 0;
    const { response, messages } = await invokeWithCapturedErrors(async (input, init = {}) => {
      const url = String(input);
      if (url.includes("begin_amuhon_order_checkout_v2")) return Response.json({
        state: "create_session", attemptId, pageCount: 24, amountYen: 1980, currency: "JPY", attemptStartedAt: new Date().toISOString(), livemode: false,
      });
      if (url === "https://api.stripe.com/v1/checkout/sessions") {
        const expiresAt = Number(new URLSearchParams(String(init.body)).get("expires_at"));
        return Response.json(scenario.override(attemptId, expiresAt));
      }
      if (url.includes("record_amuhon_order_checkout_session_v2")) recordCalls += 1;
      throw new Error("unexpected request");
    });

    assert.equal(response.status, 502, scenario.name);
    assert.equal(recordCalls, 0, scenario.name);
    assert.equal(messages.length, 1, scenario.name);
    assert.match(messages[0], new RegExp(`^\\[checkout\\] STRIPE_SESSION_RESPONSE_REJECTED ${scenario.expectedCode}$`), scenario.name);
    assert.doesNotMatch(messages.join(" "), /https?:|cs_test_|order-value|checkout_attempt|sk_test_|0123456789/, scenario.name);
    assert.equal(await response.text(), JSON.stringify({ error: "決済サービスの応答を安全に確認できませんでした。注文状況を確認してください。" }), scenario.name);
  }
});

test("Stripe response with a mismatched livemode is not recorded or returned", async () => {
  const attemptId = "5c8c89d2-1000-4f6e-8db2-2bda904b5710";
  let recordCalls = 0;
  const { response, messages } = await invokeWithCapturedErrors(async (input, init = {}) => {
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
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^\[checkout\] STRIPE_SESSION_RESPONSE_REJECTED SESSION_LIVEMODE_MISMATCH$/);
});

test("trusted host allowlist failure stops before creating a Stripe Session", async () => {
  let beginCalls = 0;
  let stripeCalls = 0;
  let recordCalls = 0;
  const { response, messages } = await invokeWithCapturedErrors(async (input) => {
    const url = String(input);
    if (url.includes("begin_amuhon_order_checkout_v2")) beginCalls += 1;
    if (url.includes("api.stripe.com")) stripeCalls += 1;
    if (url.includes("record_amuhon_order_checkout_session_v2")) recordCalls += 1;
    throw new Error("unexpected request");
  }, { allowlistResponse: { data: { hosts: ["*"] }, status: 200 } });
  assert.equal(response.status, 503);
  assert.equal(beginCalls, 0);
  assert.equal(stripeCalls, 0);
  assert.equal(recordCalls, 0);
  assert.deepEqual(messages, ["[checkout] CHECKOUT_HOST_ALLOWLIST_FAILED CHECKOUT_HOST_ALLOWLIST_RESPONSE_INVALID"]);
});

test("checkout record RPC failure classes are fixed and never expose response bodies", async () => {
  const recordFailures = [
    {
      name: "RPC timeout/transport exception",
      execute: async () => { throw new Error("private connection detail with cs_test_secret and https://private.invalid"); },
      expected: "RECORD_RPC_TRANSPORT_FAILURE",
    },
    {
      name: "RPC timeout",
      execute: async () => { const error = new Error("private timeout details"); error.name = "TimeoutError"; throw error; },
      expected: "RECORD_RPC_TIMEOUT",
    },
    {
      name: "permission denied",
      execute: async () => Response.json({ message: "secret body must not be logged" }, { status: 403 }),
      expected: "RECORD_RPC_PERMISSION_FAILURE",
    },
    {
      name: "generic HTTP failure",
      execute: async () => Response.json({ message: "private gateway body" }, { status: 503 }),
      expected: "RECORD_RPC_HTTP_FAILURE",
    },
    {
      name: "database URL rejection",
      execute: async () => Response.json({ code: "P0001", message: "INVALID_CHECKOUT_SESSION", detail: "raw database detail" }, { status: 500 }),
      expected: "RECORD_SQL_INVALID_SESSION",
    },
    {
      name: "database generic failure",
      execute: async () => Response.json({ code: "P0001", message: "private database text" }, { status: 500 }),
      expected: "RECORD_RPC_DATABASE_FAILURE",
    },
    {
      name: "SQLSTATE is distinguished from HTTP gateway failure",
      execute: async () => Response.json({ code: "23505", message: "private constraint detail" }, { status: 400 }),
      expected: "RECORD_RPC_DATABASE_FAILURE",
    },
    {
      name: "non-error property names cannot become log diagnostics",
      execute: async () => Response.json({ code: "P0001", message: "toString" }, { status: 500 }),
      expected: "RECORD_RPC_DATABASE_FAILURE",
    },
    {
      name: "empty successful response",
      execute: async () => Response.json(null),
      expected: "RECORD_RPC_EMPTY_RESPONSE",
    },
    {
      name: "unexpected successful state",
      execute: async () => Response.json({ state: "secret-unexpected-state" }),
      expected: "RECORD_RPC_UNEXPECTED_STATE",
    },
  ];

  for (const failure of recordFailures) {
    const attemptId = "5c8c89d2-1000-4f6e-8db2-2bda904b5710";
    const { response, messages } = await invokeWithCapturedErrors(async (input, init = {}) => {
      const url = String(input);
      if (url.includes("begin_amuhon_order_checkout_v2")) return Response.json({
        state: "create_session", attemptId, pageCount: 24, amountYen: 1980, currency: "JPY", attemptStartedAt: new Date().toISOString(), livemode: false,
      });
      if (url === "https://api.stripe.com/v1/checkout/sessions") {
        const expiresAt = Number(new URLSearchParams(String(init.body)).get("expires_at"));
        return Response.json(validSessionResponse(attemptId, expiresAt));
      }
      if (url.includes("record_amuhon_order_checkout_session_v2")) return failure.execute();
      throw new Error("unexpected request");
    });
    assert.equal(response.status, 503, failure.name);
    assert.deepEqual(messages, [`[checkout] CHECKOUT_SESSION_RECORD_FAILED ${failure.expected}`], failure.name);
    assert.doesNotMatch(messages.join(" "), /https?:|cs_test_|private|secret|database|0123456789|d9d71ea0/, failure.name);
  }
});

test("a record failure retry reuses the same Stripe idempotency request and Session", async () => {
  const attemptId = "5c8c89d2-1000-4f6e-8db2-2bda904b5710";
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const requestBodies = [];
  const idempotencyKeys = [];
  let recordCalls = 0;
  const mockFetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("begin_amuhon_order_checkout_v2")) return Response.json({
      state: "create_session", attemptId, pageCount: 24, amountYen: 1980, currency: "JPY", attemptStartedAt: startedAt, livemode: false,
    });
    if (url === "https://api.stripe.com/v1/checkout/sessions") {
      requestBodies.push(String(init.body));
      idempotencyKeys.push(init.headers["Idempotency-Key"]);
      const expiresAt = Number(new URLSearchParams(String(init.body)).get("expires_at"));
      return Response.json(validSessionResponse(attemptId, expiresAt));
    }
    if (url.includes("record_amuhon_order_checkout_session_v2")) {
      recordCalls += 1;
      if (recordCalls === 1) return Response.json({ code: "P0001", message: "private database detail" }, { status: 500 });
      return Response.json({ state: "recorded" });
    }
    throw new Error("unexpected request");
  };

  const first = await invokeWithCapturedErrors(mockFetch);
  const second = await invokeWithCapturedErrors(mockFetch);
  assert.equal(first.response.status, 503);
  assert.deepEqual(first.messages, ["[checkout] CHECKOUT_SESSION_RECORD_FAILED RECORD_RPC_DATABASE_FAILURE"]);
  assert.equal(second.response.status, 200);
  assert.deepEqual(await second.response.json(), { checkoutUrl: CHECKOUT_URL, checkoutHost: "checkout.stripe.com" });
  assert.equal(recordCalls, 2);
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0], requestBodies[1]);
  assert.equal(idempotencyKeys[0], idempotencyKeys[1]);
  assert.doesNotMatch(first.messages.join(" "), /private|cs_test_|https?:|d9d71ea0/);
});

test("a webhook payment committed before record RPC returns alreadyPaid without redirecting", async () => {
  const attemptId = "5c8c89d2-1000-4f6e-8db2-2bda904b5710";
  const response = await invoke(async (input, init = {}) => {
    const url = String(input);
    if (url.includes("begin_amuhon_order_checkout_v2")) return Response.json({
      state: "create_session", attemptId, pageCount: 24, amountYen: 1980, currency: "JPY", attemptStartedAt: new Date(Date.now() - 1000).toISOString(), livemode: false,
    });
    if (url === "https://api.stripe.com/v1/checkout/sessions") {
      const expiresAt = Number(new URLSearchParams(String(init.body)).get("expires_at"));
      return Response.json(validSessionResponse(attemptId, expiresAt));
    }
    if (url.includes("record_amuhon_order_checkout_session_v2")) return Response.json({ state: "paid" });
    throw new Error("unexpected request");
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { alreadyPaid: true });
});

test("uncertain or expired checkout attempts stop before creating a replacement Session", async () => {
  for (const message of ["CHECKOUT_SESSION_UNCERTAIN_REVIEW_REQUIRED", "CHECKOUT_SESSION_EXPIRED_REVIEW_REQUIRED"]) {
    let stripeCalls = 0;
    const response = await invoke(async (input) => {
      if (String(input).includes("begin_amuhon_order_checkout_v2")) return Response.json({ message }, { status: 409 });
      if (String(input).startsWith("https://api.stripe.com/")) stripeCalls += 1;
      throw new Error("replacement must not be created");
    });
    assert.equal(response.status, 409, message);
    assert.equal(stripeCalls, 0, message);
  }
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
