import { randomUUID } from "node:crypto";

import { readOrderUploadCookie } from "../../../../../lib/order-upload-cookie.ts";
import { hashOrderUploadToken } from "../../../../../lib/order-upload-token.ts";
import { quoteOrderPrice } from "../../../../../lib/order-pricing.ts";
import { callOrderRpc, getSupabaseServerConfig, isValidOrderId, validOrderPostOrigin } from "../../../../../lib/order-checkout-server.ts";
import { getStripeServerConfig, isCheckoutSessionIdForMode } from "../../../../../lib/stripe-mode.ts";
import { checkoutRecordExceptionCode, checkoutRecordFailureCode } from "../../../../../lib/order-checkout-diagnostics.ts";
import { isTrustedStripeCheckoutUrl, parseTrustedStripeCheckoutHosts, validateCheckoutSessionResponse } from "../../../../../lib/stripe-checkout-session-validation.ts";
import { isLegacyBuyerAssetFlowEnabled } from "../../../../../lib/order-production-gate.ts";
import { parseCommercialRightsDecision } from "../../../../../lib/commercial-rights.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHECKOUT_TTL_SECONDS = 60 * 60;
const REQUEST_TIMEOUT_MS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function checkoutRedirectResponse(checkoutUrl: string) {
  const checkoutHost = new URL(checkoutUrl).hostname.toLowerCase();
  return Response.json({ checkoutUrl, checkoutHost }, { headers: { "Cache-Control": "no-store" } });
}

async function readTrustedCheckoutHosts(supabase: NonNullable<ReturnType<typeof getSupabaseServerConfig>>) {
  try {
    const result = await callOrderRpc(supabase, "get_amuhon_stripe_checkout_allowed_hosts_v1", {});
    if (!result.ok) return { hosts: null, diagnostic: result.status === 401 ? "CHECKOUT_HOST_ALLOWLIST_AUTH_FAILURE" :
      result.status === 403 ? "CHECKOUT_HOST_ALLOWLIST_PERMISSION_FAILURE" :
      result.status === 404 ? "CHECKOUT_HOST_ALLOWLIST_RPC_UNAVAILABLE" : "CHECKOUT_HOST_ALLOWLIST_RPC_FAILURE" };
    const hosts = result.data ? parseTrustedStripeCheckoutHosts(result.data) : null;
    return hosts ? { hosts, diagnostic: null } : { hosts: null, diagnostic: "CHECKOUT_HOST_ALLOWLIST_RESPONSE_INVALID" };
  } catch (error) {
    const timedOut = typeof error === "object" && error !== null && "name" in error &&
      ((error as { name?: unknown }).name === "TimeoutError" || (error as { name?: unknown }).name === "AbortError");
    return { hosts: null, diagnostic: timedOut ? "CHECKOUT_HOST_ALLOWLIST_TIMEOUT" : "CHECKOUT_HOST_ALLOWLIST_TRANSPORT_FAILURE" };
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isLegacyBuyerAssetFlowEnabled()) return fail("印刷データのサーバー生成を準備中のため、現在は注文を開始できません。", 503);
  if (!validOrderPostOrigin(request)) return fail("送信元を確認できませんでした。画面を再読み込みしてください。", 403);
  const { id: orderId } = await context.params;
  if (!isValidOrderId(orderId)) return fail("注文情報を確認できません。", 404);
  const token = readOrderUploadCookie(request, orderId);
  if (!token) return fail("決済を開始する権限がありません。", 403);
  const stripe = getStripeServerConfig();
  const supabase = getSupabaseServerConfig();
  if (!stripe || !supabase) return fail("決済サービスの設定を確認できません。", 503);

  try {
    const rights = await callOrderRpc(supabase, "check_amuhon_order_commercial_rights_v1", {
      p_order_id: orderId,
      p_upload_token_hash: hashOrderUploadToken(token),
    });
    const approved = parseCommercialRightsDecision(rights.data);
    if (!rights.ok || approved === null) return fail("作品の利用条件を確認できません。決済は開始していません。", 503);
    if (!approved) return fail("この注文の作品は販売用の利用確認が完了していません。決済は開始していません。", 409);
  } catch {
    return fail("作品の利用条件を確認できません。決済は開始していません。", 503);
  }

  // Load the database-owned allowlist before begin_v2, which may bind an attempt and
  // move a verified order into ready_for_payment. A missing allowlist must not strand it.
  const allowlist = await readTrustedCheckoutHosts(supabase);
  if (allowlist.diagnostic || !allowlist.hosts) {
    console.error("[checkout] CHECKOUT_HOST_ALLOWLIST_FAILED", allowlist.diagnostic ?? "CHECKOUT_HOST_ALLOWLIST_RESPONSE_INVALID");
    return fail("決済サービスの接続先を確認できませんでした。時間をおいて再試行してください。", 503);
  }
  const trustedHosts = allowlist.hosts;

  const tokenHash = hashOrderUploadToken(token);
  let begin: Awaited<ReturnType<typeof callOrderRpc>>;
  try {
    begin = await callOrderRpc(supabase, "begin_amuhon_order_checkout_v2", {
      p_order_id: orderId,
      p_upload_token_hash: tokenHash,
      p_checkout_attempt_id: randomUUID(),
      p_livemode: stripe.livemode,
    });
  } catch {
    return fail("注文の決済条件を確認できませんでした。時間をおいて再試行してください。", 502);
  }
  if (!begin.ok || !begin.data) return fail("この注文は決済を開始できません。ファイル検証・ページ数・価格を確認してください。", 409);
  if (begin.data.state === "paid") return fail("この注文の決済はすでに確認されています。", 409);

  if (begin.data.state === "session_available") {
    if (typeof begin.data.sessionId === "string" &&
        isCheckoutSessionIdForMode(begin.data.sessionId, stripe.mode) && begin.data.livemode === stripe.livemode &&
        isTrustedStripeCheckoutUrl(begin.data.checkoutUrl, trustedHosts)) {
      return checkoutRedirectResponse(begin.data.checkoutUrl as string);
    }
    return fail("既存の決済画面を安全に確認できませんでした。注文状況を確認してください。", 409);
  }
  const attemptId = begin.data.attemptId;
  const pageCount = begin.data.pageCount;
  const amountYen = begin.data.amountYen;
  const attemptStartedAt = typeof begin.data.attemptStartedAt === "string" ? Date.parse(begin.data.attemptStartedAt) : Number.NaN;
  if (begin.data.state !== "create_session" || begin.data.livemode !== stripe.livemode ||
      typeof attemptId !== "string" || !UUID_PATTERN.test(attemptId) ||
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
        Authorization: `Bearer ${stripe.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `amuhon-order-${stripe.mode}-${orderId}-${attemptId}`,
      },
      body: params,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!stripeResponse.ok) return fail("決済画面を作成できませんでした。時間をおいて注文状況を確認してください。", 502);
    stripeSession = await stripeResponse.json() as Record<string, unknown>;
  } catch {
    return fail("決済画面への接続を確認できませんでした。注文状況を確認してから再試行してください。", 502);
  }

  const validationFailures = validateCheckoutSessionResponse(stripeSession, {
    mode: stripe.mode,
    livemode: stripe.livemode,
    amountYen: quote.amountYen,
    orderId,
    attemptId,
    expiresAt,
    nowEpochSeconds: Math.floor(Date.now() / 1000),
  }, trustedHosts);
  if (validationFailures.length > 0) {
    // Log only a fixed allowlisted diagnostic code list. Never include response values or request data.
    console.error("[checkout] STRIPE_SESSION_RESPONSE_REJECTED", validationFailures.join(","));
    return fail("決済サービスの応答を安全に確認できませんでした。注文状況を確認してください。", 502);
  }

  const sessionId = stripeSession.id as string;
  const checkoutUrl = stripeSession.url as string;
  const stripeExpiry = stripeSession.expires_at as number;

  try {
    const recorded = await callOrderRpc(supabase, "record_amuhon_order_checkout_session_v2", {
      p_order_id: orderId,
      p_upload_token_hash: tokenHash,
      p_checkout_attempt_id: attemptId,
      p_session_id: sessionId,
      p_session_url: checkoutUrl,
      p_expires_at_epoch: stripeExpiry,
      p_livemode: stripe.livemode,
    });
    const recordFailureCode = checkoutRecordFailureCode(recorded);
    if (recordFailureCode) {
      console.error("[checkout] CHECKOUT_SESSION_RECORD_FAILED", recordFailureCode);
      return fail("決済画面は作成されましたが、注文への記録を確認できませんでした。注文状況を確認してください。", 503);
    }
    if (recorded.data?.state === "paid") {
      return Response.json({ alreadyPaid: true }, { headers: { "Cache-Control": "no-store" } });
    }
  } catch (error) {
    console.error("[checkout] CHECKOUT_SESSION_RECORD_FAILED", checkoutRecordExceptionCode(error));
    return fail("決済画面は作成されましたが、注文への記録を確認できませんでした。注文状況を確認してください。", 503);
  }

  return checkoutRedirectResponse(checkoutUrl);
}
