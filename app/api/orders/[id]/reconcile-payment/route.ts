import { readOrderUploadCookie } from "../../../../../lib/order-upload-cookie.ts";
import { hashOrderUploadToken } from "../../../../../lib/order-upload-token.ts";
import { callOrderRpc, getSupabaseServerConfig, isValidOrderId, validOrderPostOrigin } from "../../../../../lib/order-checkout-server.ts";
import { getStripeServerConfig, isCheckoutSessionIdForMode } from "../../../../../lib/stripe-mode.ts";
import { validatePaidCheckoutSession } from "../../../../../lib/stripe-paid-session-validation.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REQUEST_BYTES = 1024;

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSmallJsonBody(request: Request): Promise<unknown | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)) return null;
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 3000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) return null;
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!validOrderPostOrigin(request)) return fail("送信元を確認できませんでした。画面を再読み込みしてください。", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return fail("決済情報を確認できません。注文状況を確認してください。", 415);
  }
  const { id: orderId } = await context.params;
  if (!isValidOrderId(orderId)) return fail("注文情報を確認できません。", 404);
  const token = readOrderUploadCookie(request, orderId);
  if (!token) return fail("注文状況を確認する権限がありません。", 403);

  const stripe = getStripeServerConfig();
  const supabase = getSupabaseServerConfig();
  if (!stripe || !supabase) return fail("決済状況を確認できません。時間をおいて再試行してください。", 503);

  const body = await readSmallJsonBody(request);
  if (body === null) return fail("決済情報を確認できません。注文状況を確認してください。", 400);
  const requestedSessionId = isRecord(body) ? body.sessionId : undefined;
  if (!isCheckoutSessionIdForMode(requestedSessionId, stripe.mode)) {
    return fail("決済情報を確認できません。注文状況を確認してください。", 400);
  }

  const uploadTokenHash = hashOrderUploadToken(token);
  let contextResult: Awaited<ReturnType<typeof callOrderRpc>>;
  try {
    contextResult = await callOrderRpc(supabase, "get_amuhon_order_payment_reconciliation_v1", {
      p_order_id: orderId,
      p_upload_token_hash: uploadTokenHash,
    });
  } catch {
    return fail("注文状況を確認できません。時間をおいて再試行してください。", 502);
  }
  const order = contextResult.data;
  if (!contextResult.ok || !order || order.orderId !== orderId) {
    return fail("注文状況を確認できません。時間をおいて再試行してください。", 502);
  }
  if (order.status === "paid") {
    return Response.json({ state: "already_paid" }, { headers: { "Cache-Control": "no-store" } });
  }

  const attemptId = order.attemptId;
  const sessionId = order.sessionId;
  const expiresAtEpoch = order.sessionExpiresAtEpoch;
  const amountYen = order.amountYen;
  if (order.status !== "ready_for_payment" || order.filesVerified !== true || order.priceConsistent !== true ||
      order.currency !== "JPY" || order.livemode !== stripe.livemode ||
      typeof attemptId !== "string" || !UUID_PATTERN.test(attemptId) ||
      typeof sessionId !== "string" || sessionId !== requestedSessionId ||
      !Number.isSafeInteger(expiresAtEpoch) || !Number.isSafeInteger(amountYen) || (amountYen as number) < 1) {
    return fail("決済状況を安全に照合できません。注文状況を確認してください。", 409);
  }

  let stripeSession: unknown;
  try {
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${stripe.secretKey}`, Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return fail("決済状況をStripeで確認できませんでした。時間をおいて再試行してください。", 502);
    stripeSession = await response.json() as unknown;
  } catch {
    return fail("決済状況をStripeで確認できませんでした。時間をおいて再試行してください。", 502);
  }

  const validationFailures = validatePaidCheckoutSession(stripeSession, {
    mode: stripe.mode,
    livemode: stripe.livemode,
    orderId,
    attemptId,
    sessionId,
    amountYen: amountYen as number,
    currency: "JPY",
    expiresAtEpoch: expiresAtEpoch as number,
  });
  if (validationFailures.length > 0) {
    console.error("[payment-reconcile] STRIPE_SESSION_REJECTED", validationFailures.join(","));
    return fail("Stripeの決済状況と注文内容が一致しません。注文状況を確認してください。", 409);
  }

  const session = stripeSession as Record<string, unknown>;
  let applied: Awaited<ReturnType<typeof callOrderRpc>>;
  try {
    applied = await callOrderRpc(supabase, "reconcile_amuhon_stripe_checkout_paid_v1", {
      p_order_id: orderId,
      p_upload_token_hash: uploadTokenHash,
      p_checkout_attempt_id: attemptId,
      p_session_id: sessionId,
      p_session_expires_at_epoch: expiresAtEpoch,
      p_amount_total: session.amount_total,
      p_currency: session.currency,
      p_payment_intent_id: session.payment_intent,
      p_livemode: stripe.livemode,
    });
  } catch {
    return fail("決済は確認できましたが、注文への反映を確認できません。注文状況を確認してください。", 503);
  }
  if (!applied.ok || !applied.data || applied.data.orderId !== orderId ||
      !["paid", "already_paid"].includes(String(applied.data.state))) {
    return fail("決済は確認できましたが、注文への反映を確認できません。注文状況を確認してください。", 503);
  }

  return Response.json({ state: applied.data.state }, { headers: { "Cache-Control": "no-store" } });
}
