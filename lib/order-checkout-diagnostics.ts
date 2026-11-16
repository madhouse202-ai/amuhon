import type { RpcResult } from "./order-checkout-server.ts";

export type CheckoutRecordDiagnosticCode =
  | "RECORD_RPC_AUTHENTICATION_FAILURE"
  | "RECORD_RPC_PERMISSION_FAILURE"
  | "RECORD_RPC_FUNCTION_UNAVAILABLE"
  | "RECORD_SQL_INVALID_SESSION"
  | "RECORD_SQL_INVALID_EXPIRY"
  | "RECORD_SQL_ORDER_NOT_AUTHORIZED"
  | "RECORD_SQL_MODE_MISMATCH"
  | "RECORD_SQL_ORDER_NOT_READY"
  | "RECORD_SQL_PRICE_MISMATCH"
  | "RECORD_SQL_ATTEMPT_MISMATCH"
  | "RECORD_SQL_RESPONSE_MISMATCH"
  | "RECORD_SQL_SESSION_MISMATCH"
  | "RECORD_RPC_DATABASE_FAILURE"
  | "RECORD_RPC_HTTP_FAILURE"
  | "RECORD_RPC_EMPTY_RESPONSE"
  | "RECORD_RPC_UNEXPECTED_STATE"
  | "RECORD_RPC_TIMEOUT"
  | "RECORD_RPC_TRANSPORT_FAILURE";

const SQL_MESSAGE_CODES: Readonly<Record<string, CheckoutRecordDiagnosticCode>> = Object.freeze({
  INVALID_CHECKOUT_SESSION: "RECORD_SQL_INVALID_SESSION",
  INVALID_CHECKOUT_EXPIRY: "RECORD_SQL_INVALID_EXPIRY",
  ORDER_NOT_AUTHORIZED: "RECORD_SQL_ORDER_NOT_AUTHORIZED",
  STRIPE_MODE_MISMATCH: "RECORD_SQL_MODE_MISMATCH",
  ORDER_NOT_READY_FOR_PAYMENT: "RECORD_SQL_ORDER_NOT_READY",
  ORDER_PRICE_MISMATCH: "RECORD_SQL_PRICE_MISMATCH",
  CHECKOUT_ATTEMPT_MISMATCH: "RECORD_SQL_ATTEMPT_MISMATCH",
  CHECKOUT_SESSION_RESPONSE_MISMATCH: "RECORD_SQL_RESPONSE_MISMATCH",
  CHECKOUT_SESSION_MISMATCH: "RECORD_SQL_SESSION_MISMATCH",
});

/** Returns null only for the two successful states accepted by the checkout route. */
export function checkoutRecordFailureCode(result: RpcResult): CheckoutRecordDiagnosticCode | null {
  if (!result.ok) {
    const message = typeof result.data?.message === "string" ? result.data.message : "";
    const knownSqlMessage = Object.hasOwn(SQL_MESSAGE_CODES, message) ? SQL_MESSAGE_CODES[message] : undefined;
    if (knownSqlMessage) return knownSqlMessage;
    if (result.status === 401) return "RECORD_RPC_AUTHENTICATION_FAILURE";
    if (result.status === 403) return "RECORD_RPC_PERMISSION_FAILURE";
    if (result.status === 404) return "RECORD_RPC_FUNCTION_UNAVAILABLE";
    if (typeof result.data?.code === "string" && /^[0-9A-Z]{5}$/.test(result.data.code)) return "RECORD_RPC_DATABASE_FAILURE";
    return "RECORD_RPC_HTTP_FAILURE";
  }

  if (!result.data) return "RECORD_RPC_EMPTY_RESPONSE";
  if (result.data.state === "recorded" || result.data.state === "paid") return null;
  return "RECORD_RPC_UNEXPECTED_STATE";
}

export function checkoutRecordExceptionCode(error: unknown): CheckoutRecordDiagnosticCode {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") return "RECORD_RPC_TIMEOUT";
  }
  return "RECORD_RPC_TRANSPORT_FAILURE";
}
