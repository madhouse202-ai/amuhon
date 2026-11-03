import { adminAuthFailureResponse, requireAdmin } from "../../../../lib/admin-auth.ts";
import { createAdminServiceClient } from "../../../../lib/admin-data.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.allowed) return adminAuthFailureResponse(auth);
  const supabase = createAdminServiceClient();
  if (!supabase) return Response.json({ error: "注文管理サービスを利用できません。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  try {
    const { data, error } = await supabase.rpc("get_amuhon_admin_order_list");
    if (error || !data || typeof data !== "object" || Array.isArray(data) || !Array.isArray((data as Record<string, unknown>).orders)) {
      return Response.json({ error: "注文一覧を取得できませんでした。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ orders: (data as { orders: unknown[] }).orders }, { headers: { "Cache-Control": "no-store, private" } });
  } catch {
    return Response.json({ error: "注文一覧を取得できませんでした。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
