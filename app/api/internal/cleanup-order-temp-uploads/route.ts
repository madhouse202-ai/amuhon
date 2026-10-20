import { randomUUID, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUCKET = "amuhon-order-temp-files";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BATCH = 2;

type TempAttempt = { attempt_id: string; order_id: string; body_object_key: string; cover_object_key: string };

function response(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function sameSecret(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export async function POST(request: Request) {
  if (process.env.ORDER_TEMP_UPLOAD_CLEANUP_ENABLED !== "true") return response("一時ファイル清掃は無効です。", 404);
  const cleanupSecret = process.env.ORDER_UPLOAD_CLEANUP_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  const suppliedSecret = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!cleanupSecret || cleanupSecret.length < 32 || !sameSecret(cleanupSecret, suppliedSecret)) return response("認証できません。", 401);

  const rawUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !serviceRoleKey) return response("清掃サービスが未設定です。", 503);
  let supabaseUrl: URL;
  try {
    supabaseUrl = new URL(rawUrl);
    if (supabaseUrl.protocol !== "https:" && supabaseUrl.hostname !== "localhost") return response("清掃サービスの接続先が正しくありません。", 503);
  } catch {
    return response("清掃サービスの接続先が正しくありません。", 503);
  }

  const cleanupLeaseId = randomUUID();
  let claimResponse: Response;
  let claimed: unknown;
  try {
    claimResponse = await fetch(`${supabaseUrl.origin}/rest/v1/rpc/claim_expired_amuhon_order_temp_upload_attempts`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_cleanup_lease_id: cleanupLeaseId, p_limit: MAX_BATCH }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    claimed = await claimResponse.json().catch(() => null) as unknown;
  } catch {
    return response("期限切れ一時ファイルの確認に失敗しました。", 502);
  }
  if (!claimResponse.ok || !Array.isArray(claimed) || claimed.some((item) => {
    if (!item || typeof item !== "object") return true;
    const row = item as Partial<TempAttempt>;
    return !UUID_PATTERN.test(row.attempt_id ?? "") || !UUID_PATTERN.test(row.order_id ?? "") ||
      row.body_object_key !== `${row.order_id}/${row.attempt_id}/body.pdf` ||
      row.cover_object_key !== `${row.order_id}/${row.attempt_id}/cover.png`;
  })) return response("期限切れ一時ファイルの確認に失敗しました。", 502);

  const outcomes = await Promise.all((claimed as TempAttempt[]).map(async (attempt) => {
    let deleted = false;
    try {
      const removed = await fetch(`${supabaseUrl.origin}/storage/v1/object/${BUCKET}`, {
        method: "DELETE",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prefixes: [attempt.body_object_key, attempt.cover_object_key] }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      deleted = removed.ok;
    } catch {
      deleted = false;
    }
    try {
      const finished = await fetch(`${supabaseUrl.origin}/rest/v1/rpc/finish_amuhon_order_temp_upload_cleanup`, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_cleanup_lease_id: cleanupLeaseId, p_attempt_id: attempt.attempt_id, p_deleted: deleted }),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!finished.ok || await finished.json().catch(() => false) !== true) return false;
    } catch {
      return false;
    }
    return deleted;
  }));

  if (outcomes.some((success) => !success)) return response("一部の一時ファイルを清掃できませんでした。次回の定期実行で再試行します。", 502);
  return Response.json({ cleaned: outcomes.length }, { headers: { "Cache-Control": "no-store" } });
}
