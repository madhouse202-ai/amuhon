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

async function invoke(event, { signatureHeader, mockFetch } = {}) {
  const oldFetch = globalThis.fetch;
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.SUPABASE_URL = "https://mock-project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  const raw = Buffer.from(JSON.stringify(event));
  globalThis.fetch = mockFetch ?? (async () => { throw new Error("unexpected RPC"); });
  try {
    return await POST(new Request("https://app.test/api/webhooks/stripe", {
      method: "POST", headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": signatureHeader ?? signature(raw),
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

test("only a verified test-mode paid Checkout event reaches the atomic payment RPC", async () => {
  const event = paidEvent();
  let rpcArgs;
  const response = await invoke(event, { mockFetch: async (input, init) => {
    assert.match(String(input), /apply_amuhon_stripe_checkout_paid$/);
    rpcArgs = JSON.parse(String(init.body));
    return Response.json({ state: "paid", orderId: ORDER_ID });
  } });
  assert.equal(response.status, 200);
  assert.equal(rpcArgs.p_event_id, event.id);
  assert.equal(rpcArgs.p_event_type, event.type);
  assert.equal(rpcArgs.p_order_id, ORDER_ID);
  assert.equal(rpcArgs.p_checkout_attempt_id, ATTEMPT_ID);
  assert.equal(rpcArgs.p_session_id, "cs_test_abc123");
  assert.equal(rpcArgs.p_amount_total, 1980);
  assert.equal(rpcArgs.p_currency, "jpy");
  assert.equal(rpcArgs.p_payment_intent_id, "pi_testABC123");
  assert.doesNotMatch(await response.text(), /service-role-test-only|whsec_/);
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

test("unhandled signed event types are acknowledged without payment mutation", async () => {
  const response = await invoke({ id: "evt_testABC123", type: "customer.created", livemode: false, data: { object: {} } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, ignored: true });
});

test("test-only environment is restored", () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(originalEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});
