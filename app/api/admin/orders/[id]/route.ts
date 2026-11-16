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
    let pdfRenderJob: Record<string, unknown> = { state: "unavailable" };
    try {
      const renderStatus = await supabase.rpc("get_amuhon_admin_order_pdf_render_status", { p_order_id: id });
      if (!renderStatus.error && renderStatus.data && typeof renderStatus.data === "object" && !Array.isArray(renderStatus.data)) {
        const candidate = renderStatus.data as Record<string, unknown>;
        const allowedStates = new Set(["not_applicable", "not_queued", "queued", "rendering", "succeeded", "failed"]);
        if (typeof candidate.state === "string" && allowedStates.has(candidate.state)) {
          const attempts = candidate.attemptCount;
          const errorCode = candidate.errorCode;
          pdfRenderJob = {
            state: candidate.state,
            ...(Number.isSafeInteger(attempts) && (attempts as number) >= 0 && (attempts as number) <= 5
              ? { attemptCount: attempts } : {}),
            ...(typeof errorCode === "string" && /^[a-z_]{1,40}$/.test(errorCode) ? { errorCode } : {}),
            ...(typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt))
              ? { updatedAt: candidate.updatedAt } : {}),
            ...(typeof candidate.completedAt === "string" && Number.isFinite(Date.parse(candidate.completedAt))
              ? { completedAt: candidate.completedAt } : {}),
          };
        }
      }
    } catch {
      // The queue migration may not be deployed yet; keep the admin order view available.
    }
    return Response.json({ order: { ...(data as Record<string, unknown>), pdfRenderJob } }, { headers: { "Cache-Control": "no-store, private" } });
  } catch {
    return Response.json({ error: "注文詳細を取得できませんでした。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
