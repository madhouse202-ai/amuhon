import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/orders/[id]/reconcile-payment/route.ts";

const ORDER_ID = "d9d71ea0-115c-4b26-8c1d-86bead2aecc4";
const ATTEMPT_ID = "5c8c89d2-1000-4f6e-8db2-2bda904b5710";
const SESSION_ID = "cs_test_abc123";
const PAYMENT_INTENT_ID = "pi_testABC123";
const TOKEN = "A".repeat(43);
const EXPIRES_AT = 1_800_000_000;
const savedEnv = new Map(Object.entries(process.env));

function dbContext(overrides = {}) {
  return {
    orderId: ORDER_ID,
    status: "ready_for_payment",
    filesVerified: true,
    priceConsistent: true,
    amountYen: 1980,
    currency: "JPY",
    livemode: false,
    attemptId: ATTEMPT_ID,
    sessionId: SESSION_ID,
    sessionExpiresAtEpoch: EXPIRES_AT,
    ...overrides,
  };
}

function stripeSession(overrides = {}) {
  return {
    id: SESSION_ID,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    livemode: false,
    client_reference_id: ORDER_ID,
    metadata: { order_id: ORDER_ID, checkout_attempt_id: ATTEMPT_ID },
    amount_total: 1980,
    currency: "jpy",
    expires_at: EXPIRES_AT,
    payment_intent: PAYMENT_INTENT_ID,
    ...overrides,
  };
}

function setupEnv() {
  process.env.STRIPE_MODE = "test";
  process.env.STRIPE_SECRET_KEY = "sk_test_mock_reconciliation_key";
  process.env.SUPABASE_URL = "https://mock-project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_mock-only-not-a-real-key";
  process.env.ORDER_APP_ORIGIN = "https://app.test";
}

function request(body = { sessionId: SESSION_ID }, { origin = "https://app.test", cookie = true } = {}) {
  const headers = { "content-type": "application/json", origin };
  if (cookie) headers.cookie = `amuhon_order_upload_${ORDER_ID}=${TOKEN}`;
  return new Request(`https://app.test/api/orders/${ORDER_ID}/reconcile-payment`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
}

async function invoke({ order = dbContext(), stripe = stripeSession(), finalResult = { state: "paid", orderId: ORDER_ID }, options } = {}) {
  setupEnv();
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname.endsWith("/get_amuhon_order_payment_reconciliation_v1")) return Response.json(order);
    if (url.origin === "https://api.stripe.com") return Response.json(stripe);
    if (url.pathname.endsWith("/reconcile_amuhon_stripe_checkout_paid_v1")) return Response.json(finalResult);
    throw new Error("unexpected_mock_fetch");
  };
  try {
    const response = await POST(request(undefined, options), { params: Promise.resolve({ id: ORDER_ID }) });
    return { response, calls };
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of [...Object.keys(process.env)]) if (!savedEnv.has(key)) delete process.env[key];
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("reconciles a matching paid Session through Stripe and the atomic service RPC", async () => {
  const { response, calls } = await invoke();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: "paid" });
  assert.equal(calls.length, 3);
  const stripeCall = calls.find(({ url }) => url.origin === "https://api.stripe.com");
  assert.equal(stripeCall.url.pathname, `/v1/checkout/sessions/${SESSION_ID}`);
  assert.equal(new Headers(stripeCall.init.headers).get("authorization"), "Bearer sk_test_mock_reconciliation_key");
  assert.equal(stripeCall.init.redirect, "error");
  const applyCall = calls.find(({ url }) => url.pathname.endsWith("/reconcile_amuhon_stripe_checkout_paid_v1"));
  const args = JSON.parse(String(applyCall.init.body));
  assert.equal(args.p_order_id, ORDER_ID);
  assert.equal(args.p_checkout_attempt_id, ATTEMPT_ID);
  assert.equal(args.p_session_id, SESSION_ID);
  assert.equal(args.p_amount_total, 1980);
  assert.equal(args.p_currency, "jpy");
  assert.equal(args.p_payment_intent_id, PAYMENT_INTENT_ID);
  assert.equal(args.p_livemode, false);
});

test("already-paid orders do not call Stripe or mutate again", async () => {
  const { response, calls } = await invoke({ order: dbContext({ status: "paid" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: "already_paid" });
  assert.equal(calls.length, 1);
});

test("accepts the idempotent already-paid result when the webhook wins the database race", async () => {
  const { response, calls } = await invoke({ finalResult: { state: "already_paid", orderId: ORDER_ID } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: "already_paid" });
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith("/reconcile_amuhon_stripe_checkout_paid_v1")).length, 1);
});

test("repeated success-page recovery calls apply payment once and later calls read the paid state", async () => {
  setupEnv();
  const previousFetch = globalThis.fetch;
  const order = dbContext();
  let stripeCalls = 0;
  let applyCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/get_amuhon_order_payment_reconciliation_v1")) return Response.json(order);
    if (url.origin === "https://api.stripe.com") {
      stripeCalls += 1;
      return Response.json(stripeSession());
    }
    if (url.pathname.endsWith("/reconcile_amuhon_stripe_checkout_paid_v1")) {
      applyCalls += 1;
      order.status = "paid";
      return Response.json({ state: "paid", orderId: ORDER_ID });
    }
    throw new Error("unexpected_mock_fetch");
  };
  try {
    const invokeRoute = () => POST(request(), { params: Promise.resolve({ id: ORDER_ID }) });
    assert.equal((await invokeRoute()).status, 200);
    assert.equal((await invokeRoute()).status, 200);
    assert.equal(applyCalls, 1);
    assert.equal(stripeCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of [...Object.keys(process.env)]) if (!savedEnv.has(key)) delete process.env[key];
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("unverified, mismatched, or unpaid Stripe results never reach the paid RPC", async () => {
  for (const input of [
    { order: dbContext({ status: "preparing" }) },
    { order: dbContext({ filesVerified: false }) },
    { order: dbContext({ priceConsistent: false }) },
    { order: dbContext({ sessionId: "cs_test_other123" }) },
    { stripe: stripeSession({ payment_status: "unpaid" }) },
    { stripe: stripeSession({ amount_total: 2280 }) },
    { stripe: stripeSession({ livemode: true }) },
    { stripe: stripeSession({ metadata: { order_id: ORDER_ID, checkout_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }) },
  ]) {
    const { response, calls } = await invoke(input);
    assert.equal(response.status, input.order?.sessionId === "cs_test_other123" ? 409 : 409);
    assert.equal(calls.some(({ url }) => url.pathname.endsWith("/reconcile_amuhon_stripe_checkout_paid_v1")), false);
  }
});

test("requires same-origin requests and the order capability cookie", async () => {
  for (const options of [{ origin: "https://attacker.test" }, { cookie: false }]) {
    const { response, calls } = await invoke({ options });
    assert.ok(response.status === 403);
    assert.equal(calls.length, 0);
  }
});

test("does not treat a malformed or unrecorded Session ID as authorization", async () => {
  setupEnv();
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json(dbContext()); };
  try {
    const bad = await POST(request({ sessionId: "https://attacker.test/session" }), { params: Promise.resolve({ id: ORDER_ID }) });
    assert.equal(bad.status, 400);
    const mismatch = await POST(request({ sessionId: "cs_test_other123" }), { params: Promise.resolve({ id: ORDER_ID }) });
    assert.equal(mismatch.status, 409);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of [...Object.keys(process.env)]) if (!savedEnv.has(key)) delete process.env[key];
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("environment is restored", () => {
  for (const [key, value] of savedEnv) assert.equal(process.env[key], value);
});
