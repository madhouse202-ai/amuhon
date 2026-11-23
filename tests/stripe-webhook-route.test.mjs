import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { POST } from "../app/api/webhooks/stripe/route.ts";
import { verifyStripeWebhookSignature } from "../lib/stripe-webhook-signature.ts";

const SECRET = "whsec_test-webhook-secret-only";
const ORDER_ID = "d9d71ea0-115c-4b26-8c1d-86bead2aecc4";
const ATTEMPT_ID = "5c8c89d2-1000-4f6e-8db2-2bda904b5710";
const originalEnv = { ...process.env };

function signature(rawBody, timestamp = Math.floor(Date.now() / 1000), secret = SECRET) {
  const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function paidEvent(overrides = {}) {
  return {
    id: "evt_testABC123", type: "checkout.session.completed", livemode: false,
    data: { object: {
      id: "cs_test_abc123", object: "checkout.session", mode: "payment", livemode: false, payment_status: "paid", currency: "jpy",
      amount_total: 1980, expires_at: Math.floor(Date.now() / 1000) + 1800,
      client_reference_id: ORDER_ID, payment_intent: "pi_testABC123",
      metadata: { order_id: ORDER_ID, checkout_attempt_id: ATTEMPT_ID },
      ...overrides,
    } },
  };
}

async function invoke(event, { signatureHeader, mockFetch, mode = "test", stripeKey, webhookSecret = SECRET } = {}) {
  const oldFetch = globalThis.fetch;
  process.env.STRIPE_MODE = mode;
  process.env.STRIPE_SECRET_KEY = stripeKey ?? (mode === "live" ? "sk_live_server-only-test-key" : "sk_test_server-only-test-key");
  process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
  process.env.SUPABASE_URL = "https://mock-project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_mock-only-not-a-real-key";
  const raw = Buffer.from(JSON.stringify(event));
  globalThis.fetch = mockFetch ?? (async () => { throw new Error("unexpected RPC"); });
  try {
    return await POST(new Request("https://app.test/api/webhooks/stripe", {
      method: "POST", headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": signatureHeader ?? signature(raw, Math.floor(Date.now() / 1000), webhookSecret),
      }, body: raw,
    }));
  } finally { globalThis.fetch = oldFetch; }
}

test("signature verifier accepts the exact timestamped payload and rejects tampering or stale signatures", () => {
  const raw = Buffer.from("{\"event\":true}");
  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifyStripeWebhookSignature(raw, signature(raw, now), SECRET, now), true);
  assert.equal(verifyStripeWebhookSignature(Buffer.from("{\"event\":false}"), signature(raw, now), SECRET, now), false);
  assert.equal(verifyStripeWebhookSignature(raw, signature(raw, now - 301), SECRET, now), false);
  assert.equal(verifyStripeWebhookSignature(raw, signature(raw, now, "sk_test_not-a-webhook-secret"), "sk_test_not-a-webhook-secret", now), false);
});

test("paid webhook atomically applies payment, verifies durable outbox, and never sends email inline", async () => {
  const event = paidEvent();
  const calls = [];
  let paymentArgs;
  const response = await invoke(event, { mockFetch: async (input, init) => {
    const url = String(input);
    const name = url.split("/rpc/").at(-1);
    calls.push(name);
    if (name === "apply_amuhon_stripe_checkout_paid_v2") {
      paymentArgs = JSON.parse(String(init.body));
      return Response.json({ state: "paid", orderId: ORDER_ID });
    }
    if (name === "get_amuhon_order_paid_notification_webhook_status_v1") {
      assert.deepEqual(JSON.parse(String(init.body)), { p_order_id: ORDER_ID });
      return Response.json({ state: "queued" });
    }
    assert.fail(`unexpected request target: ${url.startsWith("https://api.resend.com") ? "provider" : "RPC"}`);
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["apply_amuhon_stripe_checkout_paid_v2", "get_amuhon_order_paid_notification_webhook_status_v1"]);
  assert.equal(paymentArgs.p_event_id, event.id);
  assert.equal(paymentArgs.p_event_type, event.type);
  assert.equal(paymentArgs.p_order_id, ORDER_ID);
  assert.equal(paymentArgs.p_checkout_attempt_id, ATTEMPT_ID);
  assert.equal(paymentArgs.p_session_id, "cs_test_abc123");
  assert.equal(paymentArgs.p_amount_total, 1980);
  assert.equal(paymentArgs.p_currency, "jpy");
  assert.equal(paymentArgs.p_payment_intent_id, "pi_testABC123");
  assert.equal(paymentArgs.p_livemode, false);
  assert.doesNotMatch(await response.text(), /service-role-test-only|whsec_/);
});

test("live-mode paid webhook uses live-bound payment validation and verifies the outbox", async () => {
  const event = paidEvent({
    id: "cs_live_abc123",
    livemode: true,
    payment_intent: "pi_liveABC123",
  });
  event.livemode = true;
  const calls = [];
  let paymentArgs;
  const webhookSecret = "whsec_test_live-mode-only";
  const response = await invoke(event, {
    mode: "live",
    stripeKey: "sk_live_mock-only-key",
    webhookSecret,
    mockFetch: async (input, init) => {
      const name = String(input).split("/rpc/").at(-1);
      calls.push(name);
      if (name === "apply_amuhon_stripe_checkout_paid_v2") {
        paymentArgs = JSON.parse(String(init.body));
        return Response.json({ state: "paid", orderId: ORDER_ID, livemode: true });
      }
      if (name === "get_amuhon_order_paid_notification_webhook_status_v1") {
        return Response.json({ state: "suppressed" });
      }
      assert.fail(`unexpected RPC: ${name}`);
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["apply_amuhon_stripe_checkout_paid_v2", "get_amuhon_order_paid_notification_webhook_status_v1"]);
  assert.equal(paymentArgs.p_session_id, "cs_live_abc123");
  assert.equal(paymentArgs.p_payment_intent_id, "pi_liveABC123");
  assert.equal(paymentArgs.p_livemode, true);
});

test("future paid rows in enabled or disabled state are acknowledged after outbox verification", async () => {
  for (const state of ["queued", "suppressed", "sending", "sent", "needs_review"]) {
    const response = await invoke(paidEvent(), { mockFetch: async (input) =>
      String(input).endsWith("apply_amuhon_stripe_checkout_paid_v2")
        ? Response.json({ state: "paid" })
        : Response.json({ state }) });
    assert.equal(response.status, 200, `state ${state}`);
  }
});

test("newly paid order without durable outbox returns retryable failure, while historical duplicate is not backfilled", async () => {
  const callNames = [];
  const mockFetch = async (input) => {
    const name = String(input).split("/rpc/").at(-1);
    callNames.push(name);
    return name === "apply_amuhon_stripe_checkout_paid_v2"
      ? Response.json({ state: "paid" })
      : Response.json({ state: "missing" });
  };
  assert.equal((await invoke(paidEvent(), { mockFetch })).status, 503);
  assert.deepEqual(callNames, ["apply_amuhon_stripe_checkout_paid_v2", "get_amuhon_order_paid_notification_webhook_status_v1"]);

  callNames.length = 0;
  const duplicateFetch = async (input) => {
    const name = String(input).split("/rpc/").at(-1);
    callNames.push(name);
    return name === "apply_amuhon_stripe_checkout_paid_v2"
      ? Response.json({ state: "duplicate" })
      : Response.json({ state: "missing" });
  };
  assert.equal((await invoke(paidEvent(), { mockFetch: duplicateFetch })).status, 200);
  assert.deepEqual(callNames, ["apply_amuhon_stripe_checkout_paid_v2", "get_amuhon_order_paid_notification_webhook_status_v1"]);
});

test("outbox verification errors remain opaque and return a retryable webhook status", async () => {
  const oldConsoleError = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const response = await invoke(paidEvent(), { mockFetch: async (input) =>
      String(input).endsWith("apply_amuhon_stripe_checkout_paid_v2")
        ? Response.json({ state: "paid" })
        : Response.json({ detail: "private database response" }, { status: 503 }) });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private database response/);
    assert.deepEqual(lines, ["[stripe-webhook] NOTIFICATION_OUTBOX_VERIFY_FAILED"]);
  } finally { console.error = oldConsoleError; }
});

test("invalid signatures, live-mode events, and unpaid sessions never reach the database", async () => {
  let calls = 0;
  const mockFetch = async () => { calls += 1; throw new Error("RPC must not be called"); };
  const event = paidEvent();
  const raw = Buffer.from(JSON.stringify(event));
  assert.equal((await invoke(event, { signatureHeader: "t=1,v1=bad", mockFetch })).status, 400);
  assert.equal((await invoke(paidEvent({ livemode: true }), { mockFetch })).status, 400);
  assert.equal((await invoke(paidEvent({ payment_status: "unpaid" }), { mockFetch })).status, 400);
  assert.equal(calls, 0);
  assert.ok(signature(raw));
});

test("mode/key mismatch and session/event livemode mismatch never reach the database", async () => {
  let calls = 0;
  const mockFetch = async () => { calls += 1; throw new Error("RPC must not be called"); };
  const responseWithModeMismatch = await invoke(paidEvent(), {
    mode: "live", stripeKey: "sk_test_wrong-mode-key", mockFetch,
  });
  assert.equal(responseWithModeMismatch.status, 503);

  const responseWithSessionMismatch = await invoke(paidEvent({ livemode: true }), { mockFetch });
  assert.equal(responseWithSessionMismatch.status, 400);
  assert.equal(calls, 0);
});

test("unhandled signed event types are acknowledged without payment mutation", async () => {
  const response = await invoke({ id: "evt_testABC123", type: "customer.created", livemode: false, data: { object: {} } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, ignored: true });
});

test("test-only environment is restored", () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(originalEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});
