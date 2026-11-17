import assert from "node:assert/strict";
import test from "node:test";
import { validatePaidCheckoutSession } from "../lib/stripe-paid-session-validation.ts";

const expected = {
  mode: "test",
  livemode: false,
  orderId: "d9d71ea0-115c-4b26-8c1d-86bead2aecc4",
  attemptId: "5c8c89d2-1000-4f6e-8db2-2bda904b5710",
  sessionId: "cs_test_abc123",
  amountYen: 1980,
  currency: "JPY",
  expiresAtEpoch: 1_800_000_000,
};

function paidSession(overrides = {}) {
  return {
    id: expected.sessionId,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    livemode: false,
    client_reference_id: expected.orderId,
    metadata: { order_id: expected.orderId, checkout_attempt_id: expected.attemptId },
    amount_total: 1980,
    currency: "jpy",
    expires_at: expected.expiresAtEpoch,
    payment_intent: "pi_testABC123",
    ...overrides,
  };
}

test("accepts only a completed, paid Session that matches server-owned order facts", () => {
  assert.deepEqual(validatePaidCheckoutSession(paidSession(), expected), []);
});

test("rejects unpaid, uncompleted, wrong-order, wrong-amount, wrong-currency, wrong-mode, and stale Sessions", () => {
  const cases = [
    ["unpaid", { payment_status: "unpaid" }, "PAYMENT_NOT_PAID"],
    ["processing", { status: "open" }, "SESSION_NOT_COMPLETE"],
    ["different session", { id: "cs_test_other123" }, "SESSION_ID_MISMATCH"],
    ["different order", { client_reference_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, "SESSION_ORDER_MISMATCH"],
    ["different amount", { amount_total: 2280 }, "SESSION_AMOUNT_MISMATCH"],
    ["different currency", { currency: "usd" }, "SESSION_CURRENCY_MISMATCH"],
    ["different mode", { livemode: true }, "SESSION_LIVEMODE_MISMATCH"],
    ["different attempt", { metadata: { order_id: expected.orderId, checkout_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }, "SESSION_ATTEMPT_MISMATCH"],
    ["different expiry", { expires_at: expected.expiresAtEpoch + 1 }, "SESSION_EXPIRY_MISMATCH"],
    ["invalid payment intent", { payment_intent: { id: "pi_testABC123" } }, "PAYMENT_INTENT_INVALID"],
  ];
  for (const [name, override, code] of cases) {
    assert.ok(validatePaidCheckoutSession(paidSession(override), expected).includes(code), name);
  }
});

test("rejects malformed Stripe responses without disclosing response contents", () => {
  assert.deepEqual(validatePaidCheckoutSession(null, expected), ["SESSION_RESPONSE_INVALID"]);
});
