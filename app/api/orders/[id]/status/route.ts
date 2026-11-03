import { hashOrderUploadToken } from "../../../../../lib/order-upload-token.ts";
import { readOrderUploadCookie } from "../../../../../lib/order-upload-cookie.ts";
import { callOrderRpc, getSupabaseServerConfig, isValidOrderId, validOrderReadOrigin } from "../../../../../lib/order-checkout-server.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isValidOrderId(id) || !validOrderReadOrigin(request)) return fail("注文状況を確認できません。", 404);
  const token = readOrderUploadCookie(request, id);
  if (!token) return fail("注文状況を確認する権限がありません。", 403);
  const config = getSupabaseServerConfig();
  if (!config) return fail("注文状況サービスが未設定です。", 503);
  try {
    const result = await callOrderRpc(config, "get_amuhon_order_checkout_status", {
      p_order_id: id,
      p_upload_token_hash: hashOrderUploadToken(token),
    });
    if (!result.ok || !result.data || result.data.orderId !== id) return fail("注文状況を取得できませんでした。", 502);
    return Response.json({
      status: result.data.status,
      pageCount: result.data.pageCount,
      filesVerified: result.data.filesVerified === true,
      quotedAmountYen: result.data.quotedAmountYen,
      amountYen: result.data.amountYen,
      currency: result.data.currency,
      priceConsistent: result.data.priceConsistent === true,
      canCheckout: result.data.canCheckout === true,
      checkoutState: result.data.checkoutState,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return fail("注文状況を取得できませんでした。", 502);
  }
}
