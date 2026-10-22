import {
  MAX_ORDER_ASSET_BYTES,
  validateBodyPdf,
  validateCoverPng,
} from "./order-assets.ts";

/**
 * Dependency-injected validation worker core.
 *
 * This module deliberately has no Supabase client, environment access, network
 * adapter, polling loop, or process entry point. A production adapter must
 * implement the interfaces below and must not use the existing
 * complete_amuhon_order_validation_job RPC as order/file finalization: that RPC
 * only marks the job succeeded. The future commitValidatedAssets operation
 * must atomically record validated file metadata and mark the job succeeded,
 * using the current unexpired lease as a compare-and-set condition.
 */

export const TEMP_ORDER_FILES_BUCKET = "amuhon-order-temp-files";
export const FINAL_ORDER_FILES_BUCKET = "amuhon-order-files";
export const DEFAULT_VALIDATION_LEASE_SECONDS = 300;

export type SafeValidationErrorCode =
  | "invalid_pdf"
  | "invalid_cover"
  | "file_too_large"
  | "storage_unavailable"
  | "worker_unavailable"
  | "internal_error";

export type ClaimedValidationJob = {
  orderId: string;
  attemptId: string;
  leaseId: string;
  leaseExpiresAt: string;
  bodyObjectKey: string;
  coverObjectKey: string;
};

export type DownloadedAsset = {
  /** Size counted by the storage adapter while reading the object. */
  sizeBytes: number;
  bytes: Uint8Array;
};

export type FinalAssetInput = {
  bucket: typeof FINAL_ORDER_FILES_BUCKET;
  key: string;
  bytes: Uint8Array;
  sha256: string;
  contentType: "application/pdf" | "image/png";
};

export type ValidatedAssetCommit = {
  orderId: string;
  attemptId: string;
  leaseId: string;
  /** Immutable, attempt-specific keys in the private final bucket. */
  bodyObjectKey: string;
  coverObjectKey: string;
  bodyPdfPageCount: number;
  bodyPdfSha256: string;
  coverPngSha256: string;
  bodyPdfBytes: number;
  coverPngBytes: number;
};

export type AssetCommitState = "committed" | "not_committed" | "unknown";

export interface ValidationWorkerRpc {
  claim(input: { leaseSeconds: number }): Promise<ClaimedValidationJob | null>;
  fail(input: {
    attemptId: string;
    leaseId: string;
    errorCode: SafeValidationErrorCode;
  }): Promise<boolean>;
  /**
   * Future atomic DB operation. It must validate the active lease, persist the
   * file paths/page count/hashes, and mark the validation job succeeded in one
   * transaction. It must leave the order preparing until pricing is defined.
   */
  commitValidatedAssets(input: ValidatedAssetCommit): Promise<void>;
  /** Resolve an ambiguous commit response without deleting the saved files. */
  readAssetCommitState(input: { attemptId: string }): Promise<AssetCommitState>;
}

export interface ValidationWorkerStorage {
  /**
   * Implementations must enforce the byte limit while reading, before
   * buffering the whole response. A 404 is treated as a retryable storage
   * availability error because the current RPC error allowlist has no
   * dedicated missing-object code.
   */
  downloadTemporaryObject(input: {
    bucket: typeof TEMP_ORDER_FILES_BUCKET;
    key: string;
  }): Promise<DownloadedAsset>;
  /**
   * Must be create-only/idempotent: an existing key is accepted only when its
   * digest matches. A conflicting object must never be overwritten.
   */
  saveFinalObjectIfAbsent(input: FinalAssetInput): Promise<void>;
}

export type ValidationWorkerResult =
  | { status: "idle" | "busy" | "succeeded" }
  | { status: "validation_failed" | "retryable_failure"; errorCode: SafeValidationErrorCode }
  | { status: "failure_recording_pending"; errorCode: SafeValidationErrorCode }
  | { status: "lease_expired" | "lease_lost" | "finalization_pending" | "finalization_unknown" }
  | { status: "internal_failure" };

export type ValidationWorkerOptions = {
  leaseSeconds?: number;
  /** Local clock is only a conservative early-stop hint; DB lease checks are authoritative. */
  now?: () => number;
};

export type ValidationWorker = { runOnce(): Promise<ValidationWorkerResult> };

/** Thrown by the future finalization adapter when the DB rejects a stale lease. */
export class ValidationLeaseLostError extends Error {
  constructor() {
    super("validation_lease_lost");
    this.name = "ValidationLeaseLostError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class FileTooLargeError extends Error {}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function finalKey(orderId: string, attemptId: string, asset: "body.pdf" | "cover.png"): string {
  return `${orderId}/${attemptId}/${asset}`;
}

function matchesClaimedObjectKeys(job: ClaimedValidationJob): boolean {
  return job.bodyObjectKey === `${job.orderId}/${job.attemptId}/body.pdf` &&
    job.coverObjectKey === `${job.orderId}/${job.attemptId}/cover.png`;
}

function leaseHasExpired(job: ClaimedValidationJob, now: () => number): boolean {
  const expiry = Date.parse(job.leaseExpiresAt);
  return !Number.isFinite(expiry) || expiry <= now();
}

export function createOrderValidationWorker(
  rpc: ValidationWorkerRpc,
  storage: ValidationWorkerStorage,
  options: ValidationWorkerOptions = {},
): ValidationWorker {
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_VALIDATION_LEASE_SECONDS;
  const now = options.now ?? Date.now;
  let running = false;

  async function recordFailure(
    job: ClaimedValidationJob,
    errorCode: SafeValidationErrorCode,
    category: "validation" | "system",
  ): Promise<ValidationWorkerResult> {
    try {
      const recorded = await rpc.fail({ attemptId: job.attemptId, leaseId: job.leaseId, errorCode });
      if (!recorded) return { status: "lease_lost" };
      return category === "validation"
        ? { status: "validation_failed", errorCode }
        : { status: "retryable_failure", errorCode };
    } catch {
      // Keep the error safe and let the DB lease expire if it cannot be recorded.
      return { status: "failure_recording_pending", errorCode };
    }
  }

  async function download(key: string): Promise<DownloadedAsset> {
    const asset = await storage.downloadTemporaryObject({ bucket: TEMP_ORDER_FILES_BUCKET, key });
    if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 0) {
      throw new Error("storage_unavailable");
    }
    if (asset.sizeBytes > MAX_ORDER_ASSET_BYTES) throw new FileTooLargeError();
    if (asset.sizeBytes !== asset.bytes.byteLength) throw new Error("storage_unavailable");
    return asset;
  }

  async function runOnce(): Promise<ValidationWorkerResult> {
    if (running) return { status: "busy" };
    running = true;
    try {
      let job: ClaimedValidationJob | null;
      try {
        job = await rpc.claim({ leaseSeconds });
      } catch {
        return { status: "retryable_failure", errorCode: "worker_unavailable" };
      }
      if (!job) return { status: "idle" };

      if (!isUuid(job.orderId) || !isUuid(job.attemptId) || !isUuid(job.leaseId) || !matchesClaimedObjectKeys(job)) {
        return recordFailure(job, "internal_error", "system");
      }
      if (leaseHasExpired(job, now)) return { status: "lease_expired" };

      let body: DownloadedAsset;
      try {
        body = await download(job.bodyObjectKey);
      } catch (error) {
        const code = error instanceof FileTooLargeError
          ? "file_too_large"
          : "storage_unavailable";
        return recordFailure(job, code, code === "file_too_large" ? "validation" : "system");
      }

      let validatedBody: Awaited<ReturnType<typeof validateBodyPdf>>;
      try {
        validatedBody = await validateBodyPdf(body.bytes);
      } catch {
        return recordFailure(job, "invalid_pdf", "validation");
      }

      let cover: DownloadedAsset;
      try {
        cover = await download(job.coverObjectKey);
      } catch (error) {
        const code = error instanceof FileTooLargeError
          ? "file_too_large"
          : "storage_unavailable";
        return recordFailure(job, code, code === "file_too_large" ? "validation" : "system");
      }

      let validatedCover: Awaited<ReturnType<typeof validateCoverPng>>;
      try {
        validatedCover = await validateCoverPng(cover.bytes, validatedBody.pageCount);
      } catch {
        return recordFailure(job, "invalid_cover", "validation");
      }

      // Do not write either final object until both temporary files validate.
      if (leaseHasExpired(job, now)) return { status: "lease_expired" };

      const finalBodyKey = finalKey(job.orderId, job.attemptId, "body.pdf");
      const finalCoverKey = finalKey(job.orderId, job.attemptId, "cover.png");
      try {
        await storage.saveFinalObjectIfAbsent({
          bucket: FINAL_ORDER_FILES_BUCKET,
          key: finalBodyKey,
          bytes: body.bytes,
          sha256: validatedBody.sha256,
          contentType: "application/pdf",
        });
        if (leaseHasExpired(job, now)) return { status: "lease_expired" };
        await storage.saveFinalObjectIfAbsent({
          bucket: FINAL_ORDER_FILES_BUCKET,
          key: finalCoverKey,
          bytes: cover.bytes,
          sha256: validatedCover.sha256,
          contentType: "image/png",
        });
      } catch {
        // A first upload may already exist. Leave it in place; deterministic
        // attempt-specific keys and digest checks make a later retry safe.
        return recordFailure(job, "storage_unavailable", "system");
      }

      if (leaseHasExpired(job, now)) return { status: "lease_expired" };
      const commitInput: ValidatedAssetCommit = {
        orderId: job.orderId,
        attemptId: job.attemptId,
        leaseId: job.leaseId,
        bodyObjectKey: finalBodyKey,
        coverObjectKey: finalCoverKey,
        bodyPdfPageCount: validatedBody.pageCount,
        bodyPdfSha256: validatedBody.sha256,
        coverPngSha256: validatedCover.sha256,
        bodyPdfBytes: body.sizeBytes,
        coverPngBytes: cover.sizeBytes,
      };

      try {
        await rpc.commitValidatedAssets(commitInput);
        return { status: "succeeded" };
      } catch (error) {
        if (error instanceof ValidationLeaseLostError) return { status: "lease_lost" };
        // The database may have committed while the response was lost. Never
        // delete files or mark the job failed until the authoritative state is
        // known. A retry can re-use same-digest final objects safely.
        let state: AssetCommitState = "unknown";
        try {
          state = await rpc.readAssetCommitState({ attemptId: job.attemptId });
        } catch {
          state = "unknown";
        }
        if (state === "committed") return { status: "succeeded" };
        return state === "not_committed"
          ? { status: "finalization_pending" }
          : { status: "finalization_unknown" };
      }
    } catch {
      return { status: "internal_failure" };
    } finally {
      running = false;
    }
  }

  return { runOnce };
}
