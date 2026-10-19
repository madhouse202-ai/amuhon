import { randomUUID, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUCKET = "amuhon-order-files";

function response(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function sameSecret(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export async function POST(request: Request) {
  const cleanupSecret = process.env.ORDER_UPLOAD_CLEANUP_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  const suppliedSecret = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!cleanupSecret || cleanupSecret.length < 32 || !sameSecret(cleanupSecret, suppliedSecret)) {
    return response("認証できません。", 401);
  }

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
    claimResponse = await fetch(`${supabaseUrl.origin}/rest/v1/rpc/claim_stale_amuhon_order_asset_cleanup`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_cleanup_lease_id: cleanupLeaseId, p_limit: 50 }),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    claimed = await claimResponse.json().catch(() => null) as unknown;
  } catch {
    return response("期限切れアップロードの確認に失敗しました。", 502);
  }
  if (!claimResponse.ok || !Array.isArray(claimed) || claimed.some((id) => typeof id !== "string")) {
    return response("期限切れアップロードの確認に失敗しました。", 502);
  }
  const orderIds = claimed as string[];
  if (orderIds.length === 0) return Response.json({ cleaned: 0 }, { headers: { "Cache-Control": "no-store" } });

  const prefixes = orderIds.flatMap((id) => [`${id}/body.pdf`, `${id}/cover.png`]);
  let storageResponse: Response | null = null;
  try {
    storageResponse = await fetch(`${supabaseUrl.origin}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefixes }),
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    storageResponse = null;
  }

  let releaseResponse: Response | null = null;
  try {
    releaseResponse = await fetch(`${supabaseUrl.origin}/rest/v1/rpc/release_stale_amuhon_order_asset_cleanup`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_cleanup_lease_id: cleanupLeaseId, p_order_ids: orderIds }),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    releaseResponse = null;
  }

  if (!storageResponse?.ok || !releaseResponse?.ok) {
    return response("一部の期限切れファイルを清掃できませんでした。次回の定期実行で再試行します。", 502);
  }
  return Response.json({ cleaned: orderIds.length }, { headers: { "Cache-Control": "no-store" } });
}
