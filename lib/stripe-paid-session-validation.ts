import { isCheckoutSessionIdForMode, type StripeMode } from "./stripe-mode.ts";

export type PaidCheckoutSessionExpectation = {
  mode: StripeMode;
  livemode: boolean;
  orderId: string;
  attemptId: string;
  sessionId: string;
  amountYen: number;
  currency: "JPY";
  expiresAtEpoch: number;
};

export type PaidCheckoutSessionFailure =
  | "SESSION_RESPONSE_INVALID"
  | "SESSION_ID_MISMATCH"
  | "SESSION_OBJECT_MISMATCH"
  | "SESSION_NOT_COMPLETE"
  | "PAYMENT_NOT_PAID"
  | "SESSION_MODE_MISMATCH"
  | "SESSION_LIVEMODE_MISMATCH"
  | "SESSION_ORDER_MISMATCH"
  | "SESSION_ATTEMPT_MISMATCH"
  | "SESSION_AMOUNT_MISMATCH"
  | "SESSION_CURRENCY_MISMATCH"
  | "SESSION_EXPIRY_MISMATCH"
  | "PAYMENT_INTENT_INVALID";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a retrieved Stripe object against the server-owned order context. */
export function validatePaidCheckoutSession(
  value: unknown,
  expected: PaidCheckoutSessionExpectation,
): PaidCheckoutSessionFailure[] {
  if (!isRecord(value)) return ["SESSION_RESPONSE_INVALID"];

  const failures: PaidCheckoutSessionFailure[] = [];
  if (!isCheckoutSessionIdForMode(value.id, expected.mode) || value.id !== expected.sessionId) failures.push("SESSION_ID_MISMATCH");
  if (value.object !== "checkout.session") failures.push("SESSION_OBJECT_MISMATCH");
  if (value.status !== "complete") failures.push("SESSION_NOT_COMPLETE");
  if (value.payment_status !== "paid") failures.push("PAYMENT_NOT_PAID");
  if (value.mode !== "payment") failures.push("SESSION_MODE_MISMATCH");
  if (value.livemode !== expected.livemode) failures.push("SESSION_LIVEMODE_MISMATCH");
  if (value.client_reference_id !== expected.orderId) failures.push("SESSION_ORDER_MISMATCH");

  const metadata = isRecord(value.metadata) ? value.metadata : null;
  if (!metadata || metadata.order_id !== expected.orderId) failures.push("SESSION_ORDER_MISMATCH");
  if (!metadata || metadata.checkout_attempt_id !== expected.attemptId) failures.push("SESSION_ATTEMPT_MISMATCH");
  if (!Number.isSafeInteger(value.amount_total) || value.amount_total !== expected.amountYen) failures.push("SESSION_AMOUNT_MISMATCH");
  if (value.currency !== expected.currency.toLowerCase()) failures.push("SESSION_CURRENCY_MISMATCH");
  if (!Number.isSafeInteger(value.expires_at) || value.expires_at !== expected.expiresAtEpoch) failures.push("SESSION_EXPIRY_MISMATCH");
  if (typeof value.payment_intent !== "string" || !/^pi_[A-Za-z0-9]+$/.test(value.payment_intent)) failures.push("PAYMENT_INTENT_INVALID");

  return failures;
}
