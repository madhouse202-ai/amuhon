import { createHash } from "node:crypto";

import {
  FINAL_ORDER_FILES_BUCKET,
  OrderAssetTooLargeError,
  TEMP_ORDER_FILES_BUCKET,
  ValidationClaimContractError,
  ValidationLeaseLostError,
  type AssetCommitState,
  type ClaimedValidationJob,
  type DownloadedAsset,
  type FinalAssetInput,
  type SafeValidationErrorCode,
  type ValidatedAssetCommit,
  type ValidationWorkerRpc,
  type ValidationWorkerStorage,
} from "./order-validation-worker.ts";
import { MAX_ORDER_ASSET_BYTES } from "./order-assets.ts";

const RPC_TIMEOUT_MS = 15_000;
const STORAGE_TIMEOUT_MS = 60_000;
const MAX_RPC_RESPONSE_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type AdapterOptions = { fetchImpl?: typeof fetch };
type SupabaseConfig = { origin: string; serviceRoleKey: string };

class SupabaseAdapterError extends Error {
  constructor(message = "supabase_adapter_error") {
    super(message);
    this.name = "SupabaseAdapterError";
  }
}

class FinalObjectConflictError extends Error {
  constructor() {
    super("final_object_digest_conflict");
    this.name = "FinalObjectConflictError";
  }
}

function serverConfig(): SupabaseConfig {
  if (typeof window !== "undefined") throw new Error("server_only_module");
  const rawUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !serviceRoleKey) throw new Error("order_validation_worker_not_configured");

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("order_validation_worker_not_configured");
  }
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password) {
    throw new Error("order_validation_worker_not_configured");
  }
  return { origin: url.origin, serviceRoleKey };
}

function validateAttemptObjectKey(key: string, bucket: string): void {
  if (bucket !== TEMP_ORDER_FILES_BUCKET && bucket !== FINAL_ORDER_FILES_BUCKET) {
    throw new SupabaseAdapterError();
  }
  const match = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/(body\.pdf|cover\.png)$/i.exec(key);
  if (!match || !UUID_PATTERN.test(match[1]) || !UUID_PATTERN.test(match[2])) {
    throw new SupabaseAdapterError();
  }
}

function objectUrl(config: SupabaseConfig, bucket: string, key: string): string {
  validateAttemptObjectKey(key, bucket);
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${config.origin}/storage/v1/object/${encodeURIComponent(bucket)}/${path}`;
}

function serviceHeaders(config: SupabaseConfig, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("apikey", config.serviceRoleKey);
  headers.set("authorization", `Bearer ${config.serviceRoleKey}`);
  return headers;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SupabaseAdapterError();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SupabaseAdapterError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

async function parseRpcResponse(response: Response): Promise<unknown> {
  const text = await readBoundedText(response, MAX_RPC_RESPONSE_BYTES);
  if (!response.ok) {
    let code = "";
    try {
      const body: unknown = JSON.parse(text);
      if (body && typeof body === "object") {
        const record = body as Record<string, unknown>;
        const candidate = record.message ?? record.code;
        if (typeof candidate === "string") code = candidate;
      }
    } catch {
      // Keep all remote error details out of logs and user-visible errors.
    }
    if (/VALIDATION_LEASE_STALE|ORDER_UPLOAD_LEASE_STALE|UPLOAD_ATTEMPT_NOT_ACTIVE/.test(code)) {
      throw new ValidationLeaseLostError();
    }
    throw new SupabaseAdapterError();
  }
  try {
    return text ? JSON.parse(text) as unknown : null;
  } catch {
    throw new SupabaseAdapterError();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function claimedJob(value: unknown): ClaimedValidationJob | null {
  if (value === null) return null;
  const record = asRecord(value);
  if (!record || !Object.prototype.hasOwnProperty.call(record, "declaredPageCount")) {
    throw new ValidationClaimContractError();
  }
  const declaredPageCount = record.declaredPageCount;
  if (declaredPageCount !== null &&
      (typeof declaredPageCount !== "number" || !Number.isSafeInteger(declaredPageCount) || declaredPageCount <= 0)) {
    throw new ValidationClaimContractError();
  }
  if (!record ||
      typeof record.orderId !== "string" || !UUID_PATTERN.test(record.orderId) ||
      typeof record.attemptId !== "string" || !UUID_PATTERN.test(record.attemptId) ||
      typeof record.leaseId !== "string" || !UUID_PATTERN.test(record.leaseId) ||
      typeof record.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(record.leaseExpiresAt)) ||
      typeof record.bodyObjectKey !== "string" ||
      typeof record.coverObjectKey !== "string") {
    throw new SupabaseAdapterError();
  }
  const job: ClaimedValidationJob = {
    orderId: record.orderId,
    attemptId: record.attemptId,
    leaseId: record.leaseId,
    leaseExpiresAt: record.leaseExpiresAt,
    declaredPageCount,
    bodyObjectKey: record.bodyObjectKey,
    coverObjectKey: record.coverObjectKey,
  };
  if (job.bodyObjectKey !== `${job.orderId}/${job.attemptId}/body.pdf` ||
      job.coverObjectKey !== `${job.orderId}/${job.attemptId}/cover.png`) {
    throw new SupabaseAdapterError();
  }
  return job;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createSupabaseOrderValidationAdapters(options: AdapterOptions = {}): {
  rpc: ValidationWorkerRpc;
  storage: ValidationWorkerStorage;
} {
  const config = serverConfig();
  const fetchImpl = options.fetchImpl ?? fetch;

  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${config.origin}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: serviceHeaders(config, { "content-type": "application/json" }),
        body: JSON.stringify(args),
        cache: "no-store",
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
    } catch {
      throw new SupabaseAdapterError();
    }
    return parseRpcResponse(response);
  }

  async function readObject(bucket: string, key: string): Promise<DownloadedAsset> {
    let response: Response;
    try {
      response = await fetchImpl(objectUrl(config, bucket, key), {
        method: "GET",
        headers: serviceHeaders(config),
        cache: "no-store",
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      });
    } catch {
      throw new SupabaseAdapterError();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SupabaseAdapterError();
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_ORDER_ASSET_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new OrderAssetTooLargeError();
    }
    if (!response.body) throw new SupabaseAdapterError();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_ORDER_ASSET_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new OrderAssetTooLargeError();
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof OrderAssetTooLargeError) throw error;
      throw new SupabaseAdapterError();
    } finally {
      reader.releaseLock();
    }
    return { sizeBytes: total, bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total) };
  }

  async function saveFinalObject(input: FinalAssetInput): Promise<void> {
    if (input.bucket !== FINAL_ORDER_FILES_BUCKET || input.bytes.byteLength < 1 ||
        input.bytes.byteLength > MAX_ORDER_ASSET_BYTES || !SHA256_PATTERN.test(input.sha256) ||
        sha256(input.bytes) !== input.sha256 ||
        (input.key.endsWith("/body.pdf") && input.contentType !== "application/pdf") ||
        (input.key.endsWith("/cover.png") && input.contentType !== "image/png")) {
      throw new SupabaseAdapterError();
    }
    validateAttemptObjectKey(input.key, FINAL_ORDER_FILES_BUCKET);

    let response: Response | null = null;
    let requestFailed = false;
    try {
      // Node's undici accepts Buffer as a request body; the project uses DOM
      // fetch typings, which do not include Node's Buffer-specific overload.
      const requestBody = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
      response = await fetchImpl(objectUrl(config, FINAL_ORDER_FILES_BUCKET, input.key), {
        method: "POST",
        headers: serviceHeaders(config, {
          "content-type": input.contentType,
          "x-upsert": "false",
        }),
        body: requestBody as unknown as BodyInit,
        cache: "no-store",
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      });
    } catch {
      requestFailed = true;
    }
    if (response?.ok) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    if (response?.body) await response.body.cancel().catch(() => undefined);

    // A conflict or lost response may mean the immutable object already exists.
    // Reuse only after downloading it under the same byte cap and matching its digest.
    let existing: DownloadedAsset;
    try {
      existing = await readObject(FINAL_ORDER_FILES_BUCKET, input.key);
    } catch {
      if (requestFailed || response?.status === 409 || response?.status === 400) {
        throw new SupabaseAdapterError();
      }
      throw new SupabaseAdapterError();
    }
    if (existing.sizeBytes !== input.bytes.byteLength || sha256(existing.bytes) !== input.sha256) {
      throw new FinalObjectConflictError();
    }
  }

  const workerRpc: ValidationWorkerRpc = {
    async claimForAttempt({ orderId, attemptId, leaseSeconds }) {
      if (!UUID_PATTERN.test(orderId) || !UUID_PATTERN.test(attemptId)) throw new SupabaseAdapterError();
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
        throw new SupabaseAdapterError();
      }
      const job = claimedJob(await rpc("claim_amuhon_order_validation_job_for_attempt", {
        p_order_id: orderId,
        p_attempt_id: attemptId,
        p_lease_seconds: leaseSeconds,
      }));
      if (job && (job.orderId.toLowerCase() !== orderId.toLowerCase() ||
          job.attemptId.toLowerCase() !== attemptId.toLowerCase())) {
        throw new ValidationClaimContractError();
      }
      return job;
    },
    async fail({ attemptId, leaseId, errorCode }) {
      if (!UUID_PATTERN.test(attemptId) || !UUID_PATTERN.test(leaseId)) throw new SupabaseAdapterError();
      const resultErrorCode: SafeValidationErrorCode = errorCode;
      try {
        const result = await rpc("fail_amuhon_order_validation_job", {
          p_attempt_id: attemptId,
          p_lease_id: leaseId,
          p_error_code: resultErrorCode,
        });
        return result === true;
      } catch (error) {
        if (error instanceof ValidationLeaseLostError) return false;
        throw error;
      }
    },
    async commitValidatedAssets(input: ValidatedAssetCommit) {
      const result = asRecord(await rpc("commit_amuhon_order_validation_assets", {
        p_order_id: input.orderId,
        p_attempt_id: input.attemptId,
        p_lease_id: input.leaseId,
        p_body_pdf_page_count: input.bodyPdfPageCount,
        p_body_pdf_storage_path: input.bodyObjectKey,
        p_cover_png_storage_path: input.coverObjectKey,
        p_body_pdf_sha256: input.bodyPdfSha256,
        p_cover_png_sha256: input.coverPngSha256,
        p_body_pdf_size_bytes: input.bodyPdfBytes,
        p_cover_png_size_bytes: input.coverPngBytes,
      }));
      if (!result || result.state !== "committed" ||
          result.orderId !== input.orderId || result.attemptId !== input.attemptId) {
        throw new SupabaseAdapterError();
      }
    },
    async readAssetCommitState({ attemptId }): Promise<AssetCommitState> {
      if (!UUID_PATTERN.test(attemptId)) return "unknown";
      const result = asRecord(await rpc("get_amuhon_order_validation_asset_commit_status", {
        p_attempt_id: attemptId,
      }));
      if (!result || result.attemptId !== attemptId) return "unknown";
      if (result.state === "committed") return "committed";
      if (result.state === "not_committed") return "not_committed";
      return "unknown";
    },
  };

  const workerStorage: ValidationWorkerStorage = {
    async downloadTemporaryObject({ bucket, key }) {
      if (bucket !== TEMP_ORDER_FILES_BUCKET) throw new SupabaseAdapterError();
      return readObject(bucket, key);
    },
    saveFinalObjectIfAbsent: saveFinalObject,
  };

  return { rpc: workerRpc, storage: workerStorage };
}
