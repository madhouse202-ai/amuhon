import { isUuid } from "../../../../../lib/admin-authorization.ts";
import { adminAuthFailureResponse, requireAdmin } from "../../../../../lib/admin-auth.ts";
import { createAdminServiceClient } from "../../../../../lib/admin-data.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (!auth.allowed) return adminAuthFailureResponse(auth);
  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: "注文が見つかりません。" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const supabase = createAdminServiceClient();
  if (!supabase) return Response.json({ error: "注文管理サービスを利用できません。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  try {
    const { data, error } = await supabase.rpc("get_amuhon_admin_order_detail", { p_order_id: id });
    if (error) return Response.json({ error: "注文詳細を取得できませんでした。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
    if (!data || typeof data !== "object" || Array.isArray(data) || (data as Record<string, unknown>).id !== id) {
      return Response.json({ error: "注文が見つかりません。" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ order: data }, { headers: { "Cache-Control": "no-store, private" } });
  } catch {
    return Response.json({ error: "注文詳細を取得できませんでした。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
