import { createHmac, randomUUID } from "node:crypto";

import {
  assertDeclaredPdfPageCount,
  MAX_ORDER_ASSET_BYTES,
  MAX_ORDER_UPLOAD_BODY_BYTES,
  validateBodyPdf,
  validateCoverPng,
} from "../../../../../lib/order-assets.ts";
import { equalHexDigest, hashOrderUploadToken } from "../../../../../lib/order-upload-token.ts";
import { readOrderUploadCookie } from "../../../../../lib/order-upload-cookie.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BUCKET = "amuhon-order-files";
const REQUEST_READ_TIMEOUT_MS = 30_000;
const STORAGE_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 12_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RpcResult = { response: Response; data: Record<string, unknown> | null };

function fail(message: string, status: number, extraHeaders: HeadersInit = {}) {
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store", ...extraHeaders },
  });
}

function getTrustedIp(request: Request): string | null {
  const ip = request.headers.get("x-real-ip")?.trim() || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return ip && ip.length <= 100 ? ip : null;
}

function validOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const expectedOrigin = process.env.ORDER_APP_ORIGIN || new URL(request.url).origin;
  return Boolean(origin && origin === expectedOrigin);
}

function getSupabaseConfig(): { url: URL; key: string; rateLimitSecret: string } | null {
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const rateLimitSecret = process.env.ORDER_RATE_LIMIT_SECRET;
  if (!rawUrl || !key || !rateLimitSecret || rateLimitSecret.length < 32) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
    return { url, key, rateLimitSecret };
  } catch {
    return null;
  }
}

async function rpc(
  baseUrl: URL,
  key: string,
  name: string,
  args: Record<string, unknown>,
): Promise<RpcResult> {
  const response = await fetch(`${baseUrl.origin}/rest/v1/rpc/${name}`, {
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
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  return { response, data };
}

async function readLimitedBody(request: Request): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) throw new Error("bad_length");
    if (parsedLength > MAX_ORDER_UPLOAD_BODY_BYTES) throw new Error("too_large");
  }
  if (!request.body) throw new Error("invalid_body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, REQUEST_READ_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new Error("timeout");
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ORDER_UPLOAD_BODY_BYTES) {
        void reader.cancel();
        throw new Error("too_large");
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function parseUploadForm(request: Request): Promise<{ bodyPdf: Uint8Array; coverPng: Uint8Array }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;") || !/;\s*boundary=/i.test(contentType)) {
    throw new Error("invalid_multipart");
  }
  const bytes = await readLimitedBody(request);
  const headers = new Headers({ "Content-Type": contentType });
  const bodyBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(bodyBuffer).set(bytes);
  const replay = new Request(request.url, { method: "POST", headers, body: bodyBuffer });
  const form = await replay.formData();
  if (form.getAll("bodyPdf").length !== 1 || form.getAll("coverPng").length !== 1 ||
      [...form.keys()].some((key) => key !== "bodyPdf" && key !== "coverPng")) {
    throw new Error("invalid_fields");
  }
  const body = form.get("bodyPdf");
  const cover = form.get("coverPng");
  if (!(body instanceof File) || !(cover instanceof File)) throw new Error("missing_files");
  if (body.size < 8 || cover.size < 33 || body.size > MAX_ORDER_ASSET_BYTES || cover.size > MAX_ORDER_ASSET_BYTES) {
    throw new Error("file_size");
  }
  return {
    bodyPdf: new Uint8Array(await body.arrayBuffer()),
    coverPng: new Uint8Array(await cover.arrayBuffer()),
  };
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function uploadObject(baseUrl: URL, key: string, path: string, contentType: string, bytes: Uint8Array) {
  return fetch(`${baseUrl.origin}/storage/v1/object/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "x-upsert": "true",
    },
    body: new Blob([asArrayBuffer(bytes)], { type: contentType }),
    cache: "no-store",
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
}

async function deleteObjects(baseUrl: URL, key: string, paths: string[]) {
  if (!paths.length) return;
  try {
    await fetch(`${baseUrl.origin}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefixes: paths }),
      cache: "no-store",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch {
    // The deterministic per-order paths can be retried or removed by operations cleanup.
  }
}

async function abortLease(baseUrl: URL, key: string, orderId: string, tokenHash: string, leaseId: string) {
  try {
    await rpc(baseUrl, key, "abort_amuhon_order_asset_upload", {
      p_order_id: orderId,
      p_upload_token_hash: tokenHash,
      p_lease_id: leaseId,
    });
  } catch {
    // The lease expires automatically and can be reclaimed after five minutes.
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!validOrigin(request)) return fail("送信元を確認できませんでした。画面を再読み込みしてください。", 403);
  const { id: orderId } = await context.params;
  if (!UUID_PATTERN.test(orderId)) return fail("注文情報を確認できません。", 404);
  const config = getSupabaseConfig();
  if (!config) return fail("注文保存サービスが未設定です。ファイルは保存されていません。", 503);
  const token = readOrderUploadCookie(request, orderId);
  if (!token) return fail("アップロード権限を確認できません。", 403);
  const clientIp = getTrustedIp(request);
  if (!clientIp) return fail("安全な送信元情報を確認できません。", 503);

  const tokenHash = hashOrderUploadToken(token);
  const leaseId = randomUUID();
  const rateLimitKeyHash = createHmac("sha256", config.rateLimitSecret)
    .update(`asset-upload\0${clientIp}`).digest("hex");
  let begin: RpcResult;
  try {
    begin = await rpc(config.url, config.key, "begin_amuhon_order_asset_upload", {
      p_order_id: orderId,
      p_upload_token_hash: tokenHash,
      p_rate_limit_key_hash: rateLimitKeyHash,
      p_lease_id: leaseId,
    });
  } catch {
    return fail("注文のアップロード状態を確認できませんでした。時間をおいて再試行してください。", 502);
  }
  if (!begin.response.ok) {
    const detail = typeof begin.data?.message === "string" ? begin.data.message : "";
    if (detail === "UPLOAD_NOT_AUTHORIZED") return fail("アップロード権限を確認できません。", 403);
    if (detail === "ORDER_FILE_RATE_LIMITED") return fail("ファイル送信回数が上限に達しました。15分ほど待ってください。", 429);
    return fail("この注文ではファイルを受け付けられません。", 409);
  }
  if (begin.data?.state === "busy") {
    return fail("この注文のファイル処理が進行中です。しばらく待ってから再試行してください。", 409, { "Retry-After": "30" });
  }
  if (begin.data?.state !== "claimed" && begin.data?.state !== "complete") {
    return fail("注文のアップロード状態を確認できませんでした。", 502);
  }

  let files: { bodyPdf: Uint8Array; coverPng: Uint8Array };
  let bodyValidation: Awaited<ReturnType<typeof validateBodyPdf>>;
  let coverValidation: Awaited<ReturnType<typeof validateCoverPng>>;
  try {
    files = await parseUploadForm(request);
    bodyValidation = await validateBodyPdf(files.bodyPdf);
    coverValidation = await validateCoverPng(files.coverPng, bodyValidation.pageCount);
    assertDeclaredPdfPageCount(bodyValidation.pageCount, begin.data.declaredPageCount);
  } catch (error) {
    if (begin.data.state === "claimed") await abortLease(config.url, config.key, orderId, tokenHash, leaseId);
    const message = error instanceof Error ? error.message : "ファイルを検証できませんでした。";
    const status = ["too_large", "file_size"].includes(message) ? 413 : message === "timeout" ? 408 : 400;
    if (["invalid_multipart", "invalid_fields", "missing_files", "bad_length", "invalid_body", "timeout"].includes(message)) {
      return fail(message === "too_large"
        ? "送信サイズが上限を超えています（各ファイル40,000,000バイト／40MBまで）。"
        : message === "timeout"
          ? "ファイル送信がタイムアウトしました。"
          : "本文PDFとカバーPNGの2ファイルを選択してください。各ファイルは40,000,000バイト／40MB以下です。", message === "too_large" ? 413 : 400);
    }
    if (message === "file_size") return fail("各ファイルは40,000,000バイト／40MB以下である必要があります。", 413);
    return fail(message, status);
  }

  if (begin.data.state === "complete") {
    const sameAssets = begin.data.pageCount === bodyValidation.pageCount &&
      typeof begin.data.bodyPdfSha256 === "string" && equalHexDigest(begin.data.bodyPdfSha256, bodyValidation.sha256) &&
      typeof begin.data.coverPngSha256 === "string" && equalHexDigest(begin.data.coverPngSha256, coverValidation.sha256);
    if (!sameAssets) return fail("この注文には別のファイルが確定済みです。ファイルを置き換えることはできません。", 409);
    return Response.json({ order: { id: orderId, status: "preparing", bodyPdfPageCount: bodyValidation.pageCount }, duplicate: true }, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const bodyPath = `${orderId}/body.pdf`;
  const coverPath = `${orderId}/cover.png`;
  let finalizationStarted = false;
  try {
    const bodyResponse = await uploadObject(config.url, config.key, bodyPath, "application/pdf", files.bodyPdf);
    if (!bodyResponse.ok) throw new Error("storage_upload_failed");
    const coverResponse = await uploadObject(config.url, config.key, coverPath, "image/png", files.coverPng);
    if (!coverResponse.ok) throw new Error("storage_upload_failed");

    const finishArgs = {
      p_order_id: orderId,
      p_upload_token_hash: tokenHash,
      p_lease_id: leaseId,
      p_body_pdf_page_count: bodyValidation.pageCount,
      p_body_pdf_sha256: bodyValidation.sha256,
      p_cover_png_sha256: coverValidation.sha256,
    };
    finalizationStarted = true;
    let finished: RpcResult | null = null;
    // Retry the idempotent finalizer after transport errors and 5xx responses:
    // the database may have committed even if its response was lost upstream.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        finished = await rpc(config.url, config.key, "finish_amuhon_order_asset_upload", finishArgs);
      } catch {
        finished = null;
      }
      if (finished?.response.ok || (finished && finished.response.status < 500)) break;
    }
    if (finished?.response.ok && finished.data?.state === "complete") {
      return Response.json({
        order: { id: orderId, status: "preparing", bodyPdfPageCount: bodyValidation.pageCount },
        duplicate: false,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    // A definitive 4xx from PostgREST means the RPC statement was rejected and
    // rolled back. A 5xx, transport failure, or malformed success is ambiguous:
    // never delete objects that may already be referenced by a committed row.
    if (finished && !finished.response.ok && finished.response.status < 500) {
      await deleteObjects(config.url, config.key, [bodyPath, coverPath]);
      await abortLease(config.url, config.key, orderId, tokenHash, leaseId);
      const detail = typeof finished.data?.message === "string" ? finished.data.message : "";
      return fail(detail === "UPLOAD_LEASE_EXPIRED"
        ? "ファイル処理に時間がかかりました。もう一度アップロードしてください。"
        : "ファイルを注文に紐付けできませんでした。もう一度アップロードしてください。", 502);
    }
    return fail("保存結果を確認できませんでした。同じファイルで再試行してください。処理中の場合は数分待ってください。", 503, { "Retry-After": "30" });
  } catch {
    if (!finalizationStarted) {
      await deleteObjects(config.url, config.key, [bodyPath, coverPath]);
      await abortLease(config.url, config.key, orderId, tokenHash, leaseId);
      return fail("ファイルを非公開ストレージへ保存できませんでした。時間をおいて再試行してください。", 502);
    }
    // An ambiguous database timeout may have committed. Keep the deterministic objects for safe retry.
    return fail("保存結果を確認できませんでした。同じファイルで再試行してください。処理中の場合は数分待ってください。", 503, { "Retry-After": "30" });
  }
}
