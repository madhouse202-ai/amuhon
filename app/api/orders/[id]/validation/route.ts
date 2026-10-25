import { hashOrderUploadToken } from "../../../../../lib/order-upload-token.ts";
import { readOrderUploadCookie } from "../../../../../lib/order-upload-cookie.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 1024;
const RPC_TIMEOUT_MS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_STATES = new Set(["queued", "validating", "succeeded"]);

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function validOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const expected = process.env.ORDER_APP_ORIGIN || new URL(request.url).origin;
  return Boolean(origin && origin === expected);
}

async function readLimitedJson(request: Request): Promise<unknown | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)) {
    throw new Error("too_large");
  }
  if (!request.body) throw new Error("invalid_json");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Error("too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getSupabaseConfig(): { url: URL; serviceRoleKey: string } | null {
  const rawUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !serviceRoleKey) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;
    return { url, serviceRoleKey };
  } catch {
    return null;
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (process.env.NEXT_PUBLIC_ORDER_DIRECT_UPLOAD_EXPERIMENT !== "true") {
    return errorResponse("このアップロード方式は現在利用できません。", 404);
  }

  const { id: orderId } = await context.params;
  if (!UUID_PATTERN.test(orderId)) return errorResponse("注文を確認できません。", 400);
  if (!validOrigin(request)) return errorResponse("送信元を確認できませんでした。", 403);

  const uploadToken = readOrderUploadCookie(request, orderId);
  if (!uploadToken) return errorResponse("注文のアップロード権限を確認できません。", 403);

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return errorResponse("送信内容の形式が正しくありません。", 415);
  }

  let body: unknown;
  try {
    body = await readLimitedJson(request);
  } catch (error) {
    return errorResponse(error instanceof Error && error.message === "too_large"
      ? "送信内容が上限を超えています。"
      : "送信内容を読み取れませんでした。", error instanceof Error && error.message === "too_large" ? 413 : 400);
  }
  if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.attemptId !== "string" ||
      !UUID_PATTERN.test(body.attemptId)) {
    return errorResponse("アップロード試行を確認できません。", 400);
  }

  const config = getSupabaseConfig();
  if (!config) return errorResponse("注文保存サービスが未設定です。", 503);

  try {
    const response = await fetch(`${config.url.origin}/rest/v1/rpc/enqueue_amuhon_order_validation_job`, {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        p_order_id: orderId.toLowerCase(),
        p_upload_token_hash: hashOrderUploadToken(uploadToken),
        p_attempt_id: body.attemptId.toLowerCase(),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const result = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const message = isRecord(result) && typeof result.message === "string" ? result.message : "";
      if (message === "UPLOAD_NOT_AUTHORIZED") return errorResponse("注文のアップロード権限を確認できません。", 403);
      if (message === "UPLOAD_ATTEMPT_NOT_ACTIVE" || message === "ORDER_NOT_UPLOADABLE" ||
          message === "VALIDATION_JOB_TERMINAL" || message === "VALIDATION_JOB_LEGACY_SUCCESS_REQUIRES_REVIEW") {
        return errorResponse("このアップロード試行は検証ジョブに登録できません。画面の状態を確認してください。", 409);
      }
      return errorResponse("検証ジョブを登録できませんでした。時間をおいて同じ画面から再試行してください。", 502);
    }

    if (!isRecord(result) || result.attemptId !== body.attemptId.toLowerCase() ||
        typeof result.state !== "string" || !JOB_STATES.has(result.state)) {
      return errorResponse("検証ジョブの登録結果を確認できませんでした。再試行してください。", 502);
    }
    return Response.json({ state: result.state }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return errorResponse("検証ジョブ登録サービスに接続できませんでした。再試行してください。", 502);
  }
}
