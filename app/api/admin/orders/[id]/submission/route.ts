import { isUuid } from "../../../../../../lib/admin-authorization.ts";
import { adminAuthFailureResponse, requireAdmin, validAdminMutationOrigin } from "../../../../../../lib/admin-auth.ts";
import { createAdminServiceClient } from "../../../../../../lib/admin-data.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (!auth.allowed) return adminAuthFailureResponse(auth);
  if (!validAdminMutationOrigin(request) || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "リクエストを確認できませんでした。" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: "注文が見つかりません。" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "リクエスト形式を確認できませんでした。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "リクエスト形式を確認できませんでした。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["nextStatus", "printerOrderNumber", "vendorOrderConfirmed"].includes(key)) ||
      !["processing", "on_hold", "submitted", "shipped"].includes(String(input.nextStatus)) ||
      !(input.printerOrderNumber === null || typeof input.printerOrderNumber === "string") ||
      typeof input.vendorOrderConfirmed !== "boolean" ||
      (typeof input.printerOrderNumber === "string" && (input.printerOrderNumber.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9 _./-]{0,99}$/.test(input.printerOrderNumber)))) {
    return Response.json({ error: "入稿内容を確認できませんでした。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const supabase = createAdminServiceClient();
  if (!supabase) return Response.json({ error: "注文管理サービスを利用できません。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  try {
    const { data, error } = await supabase.rpc("mark_amuhon_order_printer_submitted_v2", {
      p_order_id: id,
      p_admin_user_id: auth.userId,
      p_next_status: input.nextStatus,
      p_printer_order_number: input.printerOrderNumber,
      p_vendor_order_confirmed: input.vendorOrderConfirmed,
    });
    if (error) return Response.json({ error: "注文状態・権利確認・生成ファイル・製本直送.comの確認内容を見直してください。" }, { status: 409, headers: { "Cache-Control": "no-store" } });
    if (!data || typeof data !== "object" || Array.isArray(data) || !["updated", "unchanged"].includes(String((data as Record<string, unknown>).state))) {
      return Response.json({ error: "入稿状態を確認できませんでした。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ state: (data as Record<string, unknown>).state, fulfillmentStatus: (data as Record<string, unknown>).fulfillmentStatus ?? input.nextStatus }, { headers: { "Cache-Control": "no-store, private" } });
  } catch {
    return Response.json({ error: "入稿状態を確認できませんでした。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
