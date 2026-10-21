import { createHmac, randomUUID } from "node:crypto";

import { hashOrderUploadToken } from "../../../../../lib/order-upload-token.ts";
import { readOrderUploadCookie } from "../../../../../lib/order-upload-cookie.ts";
import { isOrderTusProjectMatch, tusEndpoint } from "../../../../../lib/order-tus.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "amuhon-order-temp-files";
const MAX_INTENT_BODY_BYTES = 1024;
const RPC_TIMEOUT_MS = 12_000;
const STORAGE_TIMEOUT_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RpcResult = { response: Response; data: unknown };
type Attempt = {
  attemptId: string;
  leaseId?: string;
  bodyObjectKey: string;
  coverObjectKey: string;
  expiresAt: string;
};

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function validOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const expected = process.env.ORDER_APP_ORIGIN || new URL(request.url).origin;
  return Boolean(origin && origin === expected);
}

function isDirectUploadEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ORDER_DIRECT_UPLOAD_EXPERIMENT === "true";
}

function isTusAuthDiagnosticsEnabled(): boolean {
  return process.env.NODE_ENV === "development" &&
    process.env.NEXT_PUBLIC_ORDER_UPLOAD_DIAGNOSTICS === "true";
}

function getClientIp(request: Request): string | null {
  const ip = request.headers.get("x-real-ip")?.trim() || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return ip && ip.length <= 100 ? ip : null;
}

function getSupabaseConfig(): { url: URL; serviceRoleKey: string; rateLimitSecret: string } | null {
  const rawUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const rateLimitSecret = process.env.ORDER_RATE_LIMIT_SECRET;
  if (!rawUrl || !serviceRoleKey || !rateLimitSecret || rateLimitSecret.length < 32) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;
    return { url, serviceRoleKey, rateLimitSecret };
  } catch {
    return null;
  }
}

async function callRpc(url: URL, key: string, name: string, args: Record<string, unknown>): Promise<RpcResult> {
  const response = await fetch(`${url.origin}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(args),
    cache: "no-store",
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => null) as unknown;
  return { response, data };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function registerAttempt(
  url: URL,
  key: string,
  orderId: string,
  tokenHash: string,
  leaseId: string,
  requestedAttemptId: string,
): Promise<{ attemptId: string; data: Record<string, unknown> }> {
  let attemptId = requestedAttemptId;
  let result = await callRpc(url, key, "register_amuhon_order_temp_upload_attempt", {
    p_order_id: orderId,
    p_upload_token_hash: tokenHash,
    p_lease_id: leaseId,
    p_attempt_id: attemptId,
  });

  // Expired/cleaned attempt IDs are immutable. Rotate to a fresh key after the
  // DB confirms the old attempt cannot be reused; never overwrite its object.
  if (!result.response.ok && asRecord(result.data)?.message === "UPLOAD_ATTEMPT_NOT_REUSABLE") {
    attemptId = randomUUID();
    result = await callRpc(url, key, "register_amuhon_order_temp_upload_attempt", {
      p_order_id: orderId,
      p_upload_token_hash: tokenHash,
      p_lease_id: leaseId,
      p_attempt_id: attemptId,
    });
  }
  if (!result.response.ok) throw new Error("attempt_registration_failed");
  const data = asRecord(result.data);
  if (!data || data.attemptId !== attemptId ||
      typeof data.bodyObjectKey !== "string" || typeof data.coverObjectKey !== "string" ||
      typeof data.expiresAt !== "string") throw new Error("attempt_registration_failed");
  return { attemptId, data };
}

async function readLimitedBody(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, 5_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new Error("intent_body_timeout");
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function createSignedUploadToken(url: URL, key: string, objectKey: string): Promise<string> {
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${url.origin}/storage/v1/object/upload/sign/${BUCKET}/${encodedKey}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ upsert: false }),
    cache: "no-store",
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
  const data = asRecord(await response.json().catch(() => null));
  if (!response.ok || typeof data?.url !== "string") {
    throw new Error("signed_upload_unavailable");
  }

  // The Storage REST endpoint returns a signed URL. storage-js derives its
  // public `data.token` from that URL's query string; the raw REST response is
  // not guaranteed to contain a top-level `token` field.
  const rawSignedUrl = data.url.startsWith("http")
    ? data.url
    : data.url.startsWith("/storage/v1/")
      ? `${url.origin}${data.url}`
      : data.url.startsWith("/")
        ? `${url.origin}/storage/v1${data.url}`
        : `${url.origin}/storage/v1/${data.url}`;
  let signedUrl: URL;
  try {
    signedUrl = new URL(rawSignedUrl);
  } catch {
    throw new Error("signed_upload_unavailable");
  }
  const expectedPath = `/storage/v1/object/upload/sign/${BUCKET}/${objectKey}`;
  const token = signedUrl.searchParams.get("token");
  if (signedUrl.origin !== url.origin || signedUrl.pathname !== expectedPath ||
      !token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("signed_upload_unavailable");
  }
  return token;
}

async function abortLease(url: URL, key: string, orderId: string, tokenHash: string, leaseId: string) {
  try {
    await callRpc(url, key, "abort_amuhon_order_asset_upload", {
      p_order_id: orderId,
      p_upload_token_hash: tokenHash,
      p_lease_id: leaseId,
    });
  } catch {
    // The existing five-minute lease expiry is the fallback.
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isDirectUploadEnabled()) return fail("直接アップロード実験は無効です。", 404);
  if (!validOrigin(request)) return fail("送信元を確認できませんでした。画面を再読み込みしてください。", 403);
  const { id: orderId } = await context.params;
  if (!UUID_PATTERN.test(orderId)) return fail("注文情報を確認できません。", 404);
  const token = readOrderUploadCookie(request, orderId);
  if (!token) return fail("アップロード権限を確認できません。注文画面から再試行してください。", 403);
  const config = getSupabaseConfig();
  if (!config) return fail("注文保存サービスが未設定です。", 503);
  const clientIp = getClientIp(request);
  if (!clientIp) return fail("安全な送信元情報を確認できません。", 503);

  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_INTENT_BODY_BYTES)) {
    return fail("アップロード情報の形式が正しくありません。", 413);
  }
  let payload: Record<string, unknown> | null;
  try {
    const rawBody = await readLimitedBody(request, MAX_INTENT_BODY_BYTES);
    if (rawBody === null) return fail("アップロード情報が大きすぎます。", 413);
    payload = asRecord(JSON.parse(rawBody));
  } catch (error) {
    if (error instanceof Error && error.message === "intent_body_timeout") return fail("アップロード情報の受信がタイムアウトしました。", 408);
    return fail("アップロード情報の形式が正しくありません。", 400);
  }
  const attemptId = typeof payload?.attemptId === "string" && UUID_PATTERN.test(payload.attemptId)
    ? payload.attemptId.toLowerCase()
    : null;
  if (!attemptId || Object.keys(payload ?? {}).some((key) => key !== "attemptId")) {
    return fail("アップロード試行を確認できません。", 400);
  }

  const tokenHash = hashOrderUploadToken(token);
  const rateKeyHash = createHmac("sha256", config.rateLimitSecret).update(`asset-upload\0${clientIp}`).digest("hex");
  let attempt: Attempt | null = null;
  let effectiveAttemptId = attemptId;
  let leaseId: string | null = null;
  let beginClaimed = false;
  let registrationStarted = false;

  try {
    // A retry with the same non-secret attempt ID can re-issue short-lived
    // storage signatures for the same unique keys without creating new objects.
    const recovered = await callRpc(config.url, config.serviceRoleKey, "get_amuhon_order_temp_upload_attempt", {
      p_order_id: orderId,
      p_upload_token_hash: tokenHash,
      p_attempt_id: attemptId,
    });
    if (!recovered.response.ok) {
      const detail = asRecord(recovered.data)?.message;
      return fail(detail === "UPLOAD_NOT_AUTHORIZED" ? "アップロード権限を確認できません。" : "アップロード状態を確認できませんでした。", detail === "UPLOAD_NOT_AUTHORIZED" ? 403 : 502);
    }
    const recoveredRecord = asRecord(recovered.data);
    if (recoveredRecord) {
      attempt = recoveredRecord as unknown as Attempt;
      leaseId = typeof recoveredRecord.leaseId === "string" ? recoveredRecord.leaseId : null;
    }

    if (!attempt) {
      leaseId = randomUUID();
      const begun = await callRpc(config.url, config.serviceRoleKey, "begin_amuhon_order_asset_upload", {
        p_order_id: orderId,
        p_upload_token_hash: tokenHash,
        p_rate_limit_key_hash: rateKeyHash,
        p_lease_id: leaseId,
      });
      if (!begun.response.ok) {
        const detail = asRecord(begun.data)?.message;
        return fail(detail === "UPLOAD_NOT_AUTHORIZED" ? "アップロード権限を確認できません。"
          : detail === "ORDER_FILE_RATE_LIMITED" ? "ファイル送信回数が上限に達しました。15分ほど待ってください。"
            : "この注文では一時アップロードを開始できません。", detail === "UPLOAD_NOT_AUTHORIZED" ? 403 : detail === "ORDER_FILE_RATE_LIMITED" ? 429 : 409);
      }
      const beginData = asRecord(begun.data);
      if (beginData?.state === "busy") return fail("この注文のファイル処理が進行中です。しばらく待ってから再試行してください。", 409);
      if (beginData?.state !== "claimed") return fail("この注文は一時アップロードを開始できない状態です。", 409);
      beginClaimed = true;

      registrationStarted = true;
      const registered = await registerAttempt(config.url, config.serviceRoleKey, orderId, tokenHash, leaseId, attemptId);
      effectiveAttemptId = registered.attemptId;
      attempt = { ...registered.data, leaseId } as Attempt;
    } else {
      // Re-enter the existing rate-limit/lease RPC for resumable intent retries.
      if (!leaseId) return fail("アップロード状態を確認できませんでした。", 502);
      const begun = await callRpc(config.url, config.serviceRoleKey, "begin_amuhon_order_asset_upload", {
        p_order_id: orderId,
        p_upload_token_hash: tokenHash,
        p_rate_limit_key_hash: rateKeyHash,
        p_lease_id: leaseId,
      });
      const beginData = asRecord(begun.data);
      if (!begun.response.ok || beginData?.state !== "claimed") {
        return fail("この注文では一時アップロードを再開できない状態です。", 409);
      }
      const registered = await registerAttempt(config.url, config.serviceRoleKey, orderId, tokenHash, leaseId, attemptId);
      effectiveAttemptId = registered.attemptId;
      attempt = { ...registered.data, leaseId } as Attempt;
    }

    const expectedBodyKey = `${orderId}/${effectiveAttemptId}/body.pdf`;
    const expectedCoverKey = `${orderId}/${effectiveAttemptId}/cover.png`;
    if (attempt.bodyObjectKey !== expectedBodyKey || attempt.coverObjectKey !== expectedCoverKey || attempt.attemptId !== effectiveAttemptId) {
      throw new Error("attempt_path_mismatch");
    }
    const [bodyUploadSignature, coverUploadSignature] = await Promise.all([
      createSignedUploadToken(config.url, config.serviceRoleKey, attempt.bodyObjectKey),
      createSignedUploadToken(config.url, config.serviceRoleKey, attempt.coverObjectKey),
    ]);
    const endpoint = tusEndpoint(config.url);
    return Response.json({
      attemptId: effectiveAttemptId,
      expiresAt: attempt.expiresAt,
      bucket: BUCKET,
      tusEndpoint: endpoint,
      bodyObjectKey: attempt.bodyObjectKey,
      coverObjectKey: attempt.coverObjectKey,
      bodyUploadSignature,
      coverUploadSignature,
      uploadMaxBytes: 40_000_000,
      verified: false,
      ...(isTusAuthDiagnosticsEnabled()
        ? { diagnostics: { signerAndTusProjectMatch: isOrderTusProjectMatch(config.url.toString(), endpoint) } }
        : {}),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    if (beginClaimed && !registrationStarted && leaseId) await abortLease(config.url, config.serviceRoleKey, orderId, tokenHash, leaseId);
    return fail("一時アップロード権限を発行できませんでした。同じ画面から再試行してください。", 502);
  }
}
