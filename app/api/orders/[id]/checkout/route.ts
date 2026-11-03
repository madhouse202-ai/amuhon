import { randomUUID } from "node:crypto";

import { readOrderUploadCookie } from "../../../../../lib/order-upload-cookie.ts";
import { hashOrderUploadToken } from "../../../../../lib/order-upload-token.ts";
import { quoteOrderPrice } from "../../../../../lib/order-pricing.ts";
import { callOrderRpc, getSupabaseServerConfig, isValidOrderId, validOrderPostOrigin } from "../../../../../lib/order-checkout-server.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHECKOUT_TTL_SECONDS = 60 * 60;
const REQUEST_TIMEOUT_MS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function getStripeTestSecret(): string | null {
  const key = process.env.STRIPE_SECRET_KEY;
  return key && key.startsWith("sk_test_") && key.length >= 16 ? key : null;
}

function validCheckoutUrl(value: unknown, sessionId: string): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com" &&
      url.pathname === `/c/pay/${sessionId}`;
  } catch {
    return false;
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!validOrderPostOrigin(request)) return fail("送信元を確認できませんでした。画面を再読み込みしてください。", 403);
  const { id: orderId } = await context.params;
  if (!isValidOrderId(orderId)) return fail("注文情報を確認できません。", 404);
  const token = readOrderUploadCookie(request, orderId);
  if (!token) return fail("決済を開始する権限がありません。", 403);
  const stripeSecret = getStripeTestSecret();
  const supabase = getSupabaseServerConfig();
  if (!stripeSecret || !supabase) return fail("テスト決済サービスが未設定です。", 503);

  const tokenHash = hashOrderUploadToken(token);
  let begin: Awaited<ReturnType<typeof callOrderRpc>>;
  try {
    begin = await callOrderRpc(supabase, "begin_amuhon_order_checkout", {
      p_order_id: orderId,
      p_upload_token_hash: tokenHash,
      p_checkout_attempt_id: randomUUID(),
    });
  } catch {
    return fail("注文の決済条件を確認できませんでした。時間をおいて再試行してください。", 502);
  }
  if (!begin.ok || !begin.data) return fail("この注文は決済を開始できません。ファイル検証・ページ数・価格を確認してください。", 409);
  if (begin.data.state === "paid") return fail("この注文の決済はすでに確認されています。", 409);
  if (begin.data.state === "session_available" && typeof begin.data.sessionId === "string" &&
      /^cs_test_[A-Za-z0-9]+$/.test(begin.data.sessionId) && validCheckoutUrl(begin.data.checkoutUrl, begin.data.sessionId)) {
    return Response.json({ checkoutUrl: begin.data.checkoutUrl }, { headers: { "Cache-Control": "no-store" } });
  }
  const attemptId = begin.data.attemptId;
  const pageCount = begin.data.pageCount;
  const amountYen = begin.data.amountYen;
  const attemptStartedAt = typeof begin.data.attemptStartedAt === "string" ? Date.parse(begin.data.attemptStartedAt) : Number.NaN;
  if (begin.data.state !== "create_session" || typeof attemptId !== "string" || !UUID_PATTERN.test(attemptId) ||
      !Number.isSafeInteger(pageCount) || !Number.isSafeInteger(amountYen) || begin.data.currency !== "JPY" ||
      !Number.isFinite(attemptStartedAt) || attemptStartedAt > Date.now() + 60_000 || attemptStartedAt < Date.now() - 45 * 60_000) {
    return fail("決済情報を安全に確認できませんでした。注文状況を確認してください。", 409);
  }
  const quote = quoteOrderPrice(pageCount as number);
  if (!quote || quote.amountYen !== amountYen) return fail("サーバーの価格条件が一致しません。決済を停止しました。", 409);

  const origin = process.env.ORDER_APP_ORIGIN;
  if (!origin) return fail("決済画面の戻り先設定を確認してください。", 503);
  let appOrigin: string;
  try {
    appOrigin = new URL(origin).origin;
    if (appOrigin !== origin.replace(/\/$/, "")) return fail("決済画面の戻り先設定を確認してください。", 503);
  } catch {
    return fail("決済画面の戻り先設定を確認してください。", 503);
  }
  // The DB-issued attempt timestamp keeps the Stripe idempotency request body identical on retries.
  const expiresAt = Math.floor(attemptStartedAt / 1000) + CHECKOUT_TTL_SECONDS;
  if (expiresAt <= Math.floor(Date.now() / 1000) + 30 * 60) {
    return fail("決済作成の有効時間が過ぎました。注文状況を確認してください。", 409);
  }
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("payment_method_types[0]", "card");
  params.set("line_items[0][price_data][currency]", "jpy");
  params.set("line_items[0][price_data][unit_amount]", String(quote.amountYen));
  params.set("line_items[0][price_data][product_data][name]", `編む本 製本（本文${quote.pageCount}ページ）`);
  params.set("line_items[0][price_data][product_data][description]", "税込・送料込み");
  params.set("line_items[0][quantity]", "1");
  params.set("client_reference_id", orderId);
  params.set("metadata[order_id]", orderId);
  params.set("metadata[checkout_attempt_id]", attemptId);
  params.set("success_url", `${appOrigin}/order/success?order_id=${encodeURIComponent(orderId)}&session_id={CHECKOUT_SESSION_ID}`);
  params.set("cancel_url", `${appOrigin}/order/cancel?order_id=${encodeURIComponent(orderId)}`);
  params.set("expires_at", String(expiresAt));

  let stripeSession: Record<string, unknown> | null = null;
  try {
    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecret}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `amuhon-order-${orderId}-${attemptId}`,
      },
      body: params,
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!stripeResponse.ok) return fail("テスト決済画面を作成できませんでした。時間をおいて注文状況を確認してください。", 502);
    stripeSession = await stripeResponse.json() as Record<string, unknown>;
  } catch {
    return fail("テスト決済画面への接続を確認できませんでした。注文状況を確認してから再試行してください。", 502);
  }

  const sessionId = stripeSession.id;
  const checkoutUrl = stripeSession.url;
  const stripeExpiry = stripeSession.expires_at;
  if (typeof sessionId !== "string" || !/^cs_test_[A-Za-z0-9]+$/.test(sessionId) || stripeSession.object !== "checkout.session" ||
      !validCheckoutUrl(checkoutUrl, sessionId) || !Number.isSafeInteger(stripeExpiry) ||
      (stripeExpiry as number) <= Math.floor(Date.now() / 1000) || (stripeExpiry as number) > expiresAt + 5 ||
      stripeSession.livemode !== false || stripeSession.status !== "open" || stripeSession.mode !== "payment" || stripeSession.currency !== "jpy" || stripeSession.amount_total !== quote.amountYen ||
      stripeSession.client_reference_id !== orderId || !stripeSession.metadata || typeof stripeSession.metadata !== "object" ||
      (stripeSession.metadata as Record<string, unknown>).order_id !== orderId ||
      (stripeSession.metadata as Record<string, unknown>).checkout_attempt_id !== attemptId) {
    return fail("決済サービスの応答を安全に確認できませんでした。注文状況を確認してください。", 502);
  }

  try {
    const recorded = await callOrderRpc(supabase, "record_amuhon_order_checkout_session", {
      p_order_id: orderId,
      p_upload_token_hash: tokenHash,
      p_checkout_attempt_id: attemptId,
      p_session_id: sessionId,
      p_session_url: checkoutUrl,
      p_expires_at_epoch: stripeExpiry,
    });
    if (!recorded.ok || !recorded.data || !["recorded", "paid"].includes(String(recorded.data.state))) {
      return fail("決済画面は作成されましたが、注文への記録を確認できませんでした。注文状況を確認してください。", 503);
    }
    if (recorded.data.state === "paid") {
      return Response.json({ alreadyPaid: true }, { headers: { "Cache-Control": "no-store" } });
    }
  } catch {
    return fail("決済画面は作成されましたが、注文への記録を確認できませんでした。注文状況を確認してください。", 503);
  }

  return Response.json({ checkoutUrl }, { headers: { "Cache-Control": "no-store" } });
}
