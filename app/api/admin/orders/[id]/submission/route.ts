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
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    return Response.json({ error: "リクエスト形式を確認できませんでした。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const supabase = createAdminServiceClient();
  if (!supabase) return Response.json({ error: "注文管理サービスを利用できません。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  try {
    const { data, error } = await supabase.rpc("mark_amuhon_order_printer_submitted", {
      p_order_id: id,
      p_admin_user_id: auth.userId,
    });
    if (error) return Response.json({ error: "この注文は入稿済みにできません。決済とファイル検証の状態を確認してください。" }, { status: 409, headers: { "Cache-Control": "no-store" } });
    if (!data || typeof data !== "object" || Array.isArray(data) || !["submitted", "already_submitted"].includes(String((data as Record<string, unknown>).state))) {
      return Response.json({ error: "入稿状態を確認できませんでした。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ state: (data as Record<string, unknown>).state }, { headers: { "Cache-Control": "no-store, private" } });
  } catch {
    return Response.json({ error: "入稿状態を確認できませんでした。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
