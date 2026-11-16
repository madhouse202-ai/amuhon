import { isCheckoutSessionIdForMode, type StripeMode } from "./stripe-mode.ts";

export type CheckoutSessionValidationCode =
  | "SESSION_ID_MODE_MISMATCH"
  | "SESSION_OBJECT_MISMATCH"
  | "SESSION_URL_MISSING"
  | "SESSION_URL_INVALID"
  | "SESSION_URL_SCHEME_NOT_HTTPS"
  | "SESSION_URL_AUTHORITY_INVALID"
  | "SESSION_URL_HOST_NOT_TRUSTED"
  | "SESSION_EXPIRY_INVALID"
  | "SESSION_EXPIRY_NOT_FUTURE"
  | "SESSION_EXPIRY_AFTER_REQUESTED_LIMIT"
  | "SESSION_LIVEMODE_MISMATCH"
  | "SESSION_STATUS_NOT_OPEN"
  | "SESSION_MODE_MISMATCH"
  | "SESSION_CURRENCY_MISMATCH"
  | "SESSION_AMOUNT_MISMATCH"
  | "SESSION_CLIENT_REFERENCE_MISMATCH"
  | "SESSION_METADATA_INVALID"
  | "SESSION_ORDER_METADATA_MISMATCH"
  | "SESSION_ATTEMPT_METADATA_MISMATCH";

export type CheckoutSessionValidationInput = {
  mode: StripeMode;
  livemode: boolean;
  amountYen: number;
  orderId: string;
  attemptId: string;
  expiresAt: number;
  nowEpochSeconds: number;
};

const DNS_HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedHostname(value: string): boolean {
  const finalLabel = value.split(".").at(-1) ?? "";
  // Requiring an alphabetic start in the public suffix also rejects URL-parser IP shorthands.
  return value === value.toLowerCase() && DNS_HOST_PATTERN.test(value) && /^[a-z]/.test(finalLabel) &&
    !/^\d+(?:\.\d+){3}$/.test(value);
}

/** Accepts the service-role-only RPC payload. Any malformed entry fails closed. */
export function parseTrustedStripeCheckoutHosts(value: unknown): Set<string> | null {
  if (!isRecord(value) || !Array.isArray(value.hosts) || value.hosts.length === 0 || value.hosts.length > 50) return null;
  const hosts = new Set<string>();
  for (const entry of value.hosts) {
    if (typeof entry !== "string" || !isAllowedHostname(entry)) return null;
    hosts.add(entry);
  }
  return hosts.size === value.hosts.length ? hosts : null;
}

function checkoutUrlValidationFailures(value: unknown, trustedHosts: ReadonlySet<string>): CheckoutSessionValidationCode[] {
  if (typeof value !== "string" || value.length === 0) return ["SESSION_URL_MISSING"];
  if (value.length > 4096 || /[\\\s\u0000-\u001f\u007f]/.test(value)) return ["SESSION_URL_INVALID"];
  if (!/^https:\/\//i.test(value)) return ["SESSION_URL_SCHEME_NOT_HTTPS"];
  try {
    const url = new URL(value);
    const failures: CheckoutSessionValidationCode[] = [];
    if (url.protocol !== "https:") failures.push("SESSION_URL_SCHEME_NOT_HTTPS");
    const authority = /^https:\/\/([^/?#]+)\//i.exec(value)?.[1];
    // Match the database rule: exact DNS hostname, optionally with the explicit default port.
    // WHATWG URL normalizes :443 to an empty URL.port, so inspect the original authority too.
    if (url.username !== "" || url.password !== "" || url.port !== "" ||
        !authority || !/^[a-z0-9.-]+(?::443)?$/i.test(authority)) {
      failures.push("SESSION_URL_AUTHORITY_INVALID");
    }
    if (!trustedHosts.has(url.hostname.toLowerCase())) failures.push("SESSION_URL_HOST_NOT_TRUSTED");
    // Require a path, matching the database-side validator, without pinning Stripe's path shape.
    if (!/^https:\/\/[^/?#]+\/[^\\\s]*([?#][^\\\s]*)?$/i.test(value)) failures.push("SESSION_URL_INVALID");
    return failures;
  } catch {
    return ["SESSION_URL_INVALID"];
  }
}

export function isTrustedStripeCheckoutUrl(value: unknown, trustedHosts: ReadonlySet<string>): value is string {
  return checkoutUrlValidationFailures(value, trustedHosts).length === 0;
}

export function validateCheckoutSessionResponse(
  value: unknown,
  expected: CheckoutSessionValidationInput,
  trustedHosts: ReadonlySet<string>,
): CheckoutSessionValidationCode[] {
  const session = isRecord(value) ? value : {};
  const failures: CheckoutSessionValidationCode[] = [];

  if (!isCheckoutSessionIdForMode(session.id, expected.mode)) failures.push("SESSION_ID_MODE_MISMATCH");
  if (session.object !== "checkout.session") failures.push("SESSION_OBJECT_MISMATCH");

  failures.push(...checkoutUrlValidationFailures(session.url, trustedHosts));

  if (!Number.isSafeInteger(session.expires_at)) {
    failures.push("SESSION_EXPIRY_INVALID");
  } else {
    const expiresAt = session.expires_at as number;
    if (expiresAt <= expected.nowEpochSeconds) failures.push("SESSION_EXPIRY_NOT_FUTURE");
    if (expiresAt > expected.expiresAt + 5) failures.push("SESSION_EXPIRY_AFTER_REQUESTED_LIMIT");
  }

  if (session.livemode !== expected.livemode) failures.push("SESSION_LIVEMODE_MISMATCH");
  if (session.status !== "open") failures.push("SESSION_STATUS_NOT_OPEN");
  if (session.mode !== "payment") failures.push("SESSION_MODE_MISMATCH");
  if (session.currency !== "jpy") failures.push("SESSION_CURRENCY_MISMATCH");
  if (session.amount_total !== expected.amountYen) failures.push("SESSION_AMOUNT_MISMATCH");
  if (session.client_reference_id !== expected.orderId) failures.push("SESSION_CLIENT_REFERENCE_MISMATCH");

  const metadata = isRecord(session.metadata) ? session.metadata : null;
  if (!metadata) failures.push("SESSION_METADATA_INVALID");
  if (metadata?.order_id !== expected.orderId) failures.push("SESSION_ORDER_METADATA_MISMATCH");
  if (metadata?.checkout_attempt_id !== expected.attemptId) failures.push("SESSION_ATTEMPT_METADATA_MISMATCH");

  return failures;
}
