import { isUuid } from "../../../../../../../lib/admin-authorization.ts";
import { adminAuthFailureResponse, requireAdmin } from "../../../../../../../lib/admin-auth.ts";
import { createAdminServiceClient, fetchVerifiedAdminAsset } from "../../../../../../../lib/admin-data.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

export async function GET(_request: Request, context: { params: Promise<{ id: string; asset: string }> }) {
  const auth = await requireAdmin();
  if (!auth.allowed) return adminAuthFailureResponse(auth);
  const { id, asset } = await context.params;
  if (!isUuid(id) || (asset !== "body_pdf" && asset !== "cover_png")) {
    return Response.json({ error: "ファイルが見つかりません。" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const supabase = createAdminServiceClient();
  if (!supabase) return Response.json({ error: "ファイルサービスを利用できません。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  try {
    const file = await fetchVerifiedAdminAsset(supabase, id, asset);
    if (!file) return Response.json({ error: "決済済み・検証済みファイルを取得できませんでした。" }, { status: 409, headers: { "Cache-Control": "no-store" } });
    return new Response(file.bytes, {
      headers: {
        "Cache-Control": "no-store, private",
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
        "Content-Length": String(file.bytes.byteLength),
        "Content-Type": file.contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "ファイルを安全に取得できませんでした。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
