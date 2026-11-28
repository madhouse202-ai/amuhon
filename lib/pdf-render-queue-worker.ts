import { createHash } from "node:crypto";

import type { BookData } from "./book.ts";
import { parseLocalOrderPdfRequest } from "./local-order-pdf-request.ts";
import { parseFinalPreviewWorkTexts, type FinalPreviewWorkText } from "./final-typography-preview.ts";
import { MAX_ORDER_ASSET_BYTES } from "./order-assets.ts";
import { isSubmissionPageCount } from "./production.ts";

export const PDF_RENDER_LEASE_SECONDS = 1800;
export const PDF_RENDER_MAX_ATTEMPTS = 5;
export const PDF_RENDER_BUCKET = "amuhon-order-files" as const;

export type PdfRenderErrorCode =
  | "aozora_unavailable" | "storage_unavailable" | "processing_timeout"
  | "worker_unavailable" | "invalid_snapshot" | "invalid_render"
  | "page_count_mismatch" | "internal_error" | "rights_ineligible";

export type PdfRenderCompletionResult = "succeeded" | "rights_stopped" | "rights_ineligible";

export type ClaimedPdfRenderJob = {
  orderId: string;
  leaseId: string;
  leaseExpiresAt: string;
  attemptCount: number;
  expectedBodyPdfPageCount: number;
  bookSnapshot: unknown;
};

export type PdfRenderAssets = {
  bodyPdfBytes: Uint8Array;
  coverPngBytes: Uint8Array;
  bodyPdfPageCount: number;
  bodyPdfSha256: string;
  coverPngSha256: string;
};

export type PdfRenderCommit = {
  orderId: string;
  leaseId: string;
  bodyObjectKey: string;
  coverObjectKey: string;
  bodyPdfPageCount: number;
  bodyPdfSha256: string;
  coverPngSha256: string;
  bodyPdfSizeBytes: number;
  coverPngSizeBytes: number;
};

export interface PdfRenderQueueRpc {
  claim(leaseSeconds: number): Promise<ClaimedPdfRenderJob | null>;
  fail(orderId: string, leaseId: string, errorCode: PdfRenderErrorCode): Promise<boolean>;
  complete(input: PdfRenderCommit): Promise<PdfRenderCompletionResult>;
}

export interface PdfRenderQueueStorage {
  putIfAbsent(input: {
    key: string;
    bytes: Uint8Array;
    contentType: "application/pdf" | "image/png";
  }): Promise<void>;
  removeIfPresent(input: { key: string }): Promise<void>;
}

export type PdfRenderQueueDependencies = {
  rpc: PdfRenderQueueRpc;
  storage: PdfRenderQueueStorage;
  loadWorkTexts(book: BookData): Promise<FinalPreviewWorkText[]>;
  render(input: { book: BookData; works: FinalPreviewWorkText[]; expectedPageCount: number }): Promise<PdfRenderAssets>;
  now?: () => number;
};

export type PdfRenderQueueResult =
  | { status: "idle" | "succeeded" | "busy" | "lease_expired" | "lease_lost" | "finalization_unknown" | "rights_stopped" }
  | { status: "retry_queued" | "terminal_failure" | "failure_recording_pending"; errorCode: PdfRenderErrorCode }
  | { status: "artifact_cleanup_pending" }
  | { status: "claim_failed" | "claim_contract_mismatch" | "internal_failure" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseClaim(value: ClaimedPdfRenderJob): { book: BookData; job: ClaimedPdfRenderJob } | null {
  if (!value || !UUID.test(value.orderId) || !UUID.test(value.leaseId) ||
      !Number.isFinite(Date.parse(value.leaseExpiresAt)) ||
      !Number.isSafeInteger(value.attemptCount) || value.attemptCount < 1 || value.attemptCount > PDF_RENDER_MAX_ATTEMPTS ||
      !isSubmissionPageCount(value.expectedBodyPdfPageCount) || value.expectedBodyPdfPageCount > 300) return null;
  const parsed = parseLocalOrderPdfRequest({
    book: value.bookSnapshot,
    bodyPdfPageCount: value.expectedBodyPdfPageCount,
  });
  return parsed ? { book: parsed.book, job: value } : null;
}

export function createPdfRenderQueueWorker(dependencies: PdfRenderQueueDependencies) {
  const now = dependencies.now ?? Date.now;
  let running = false;

  async function recordFailure(job: ClaimedPdfRenderJob, code: PdfRenderErrorCode): Promise<PdfRenderQueueResult> {
    try {
      const recorded = await dependencies.rpc.fail(job.orderId, job.leaseId, code);
      if (!recorded) return { status: "lease_lost" };
      return code === "invalid_snapshot" || code === "invalid_render" || code === "page_count_mismatch" ||
          job.attemptCount >= PDF_RENDER_MAX_ATTEMPTS
        ? { status: "terminal_failure", errorCode: code }
        : { status: "retry_queued", errorCode: code };
    } catch {
      return { status: "failure_recording_pending", errorCode: code };
    }
  }

  async function removeUncommittedObjects(keys: string[]): Promise<boolean> {
    const results = await Promise.allSettled(keys.map((key) => dependencies.storage.removeIfPresent({ key })));
    return results.every((result) => result.status === "fulfilled");
  }

  async function runOnce(): Promise<PdfRenderQueueResult> {
    if (running) return { status: "busy" };
    running = true;
    try {
      let job: ClaimedPdfRenderJob | null;
      try {
        job = await dependencies.rpc.claim(PDF_RENDER_LEASE_SECONDS);
      } catch {
        return { status: "claim_failed" };
      }
      if (!job) return { status: "idle" };

      const claim = parseClaim(job);
      if (!claim) {
        if (job && UUID.test(job.orderId) && UUID.test(job.leaseId)) {
          return recordFailure(job, "invalid_snapshot");
        }
        return { status: "claim_contract_mismatch" };
      }
      const expired = () => Date.parse(job!.leaseExpiresAt) <= now();
      if (expired()) return { status: "lease_expired" };

      let works: FinalPreviewWorkText[];
      try {
        works = await dependencies.loadWorkTexts(claim.book);
      } catch (error) {
        if (error instanceof Error && error.message === "invalid_snapshot") {
          return recordFailure(job, "invalid_snapshot");
        }
        return recordFailure(job, "aozora_unavailable");
      }
      if (!parseFinalPreviewWorkTexts(works, claim.book)) return recordFailure(job, "invalid_snapshot");
      if (expired()) return { status: "lease_expired" };

      let assets: PdfRenderAssets;
      try {
        assets = await dependencies.render({
          book: claim.book,
          works,
          expectedPageCount: job.expectedBodyPdfPageCount,
        });
      } catch (error) {
        if (error instanceof Error && ["processing_timeout", "worker_unavailable"].includes(error.message)) {
          return recordFailure(job, error.message as "processing_timeout" | "worker_unavailable");
        }
        if (error instanceof Error && ["validated_page_count_mismatch", "composed_page_count_mismatch", "expected_page_count_invalid", "page_count_mismatch"].includes(error.message)) {
          return recordFailure(job, "page_count_mismatch");
        }
        return recordFailure(job, "invalid_render");
      }
      if (assets.bodyPdfPageCount !== job.expectedBodyPdfPageCount) {
        return recordFailure(job, "page_count_mismatch");
      }
      if (!(assets.bodyPdfBytes instanceof Uint8Array) || assets.bodyPdfBytes.byteLength < 1 ||
          assets.bodyPdfBytes.byteLength > MAX_ORDER_ASSET_BYTES ||
          !(assets.coverPngBytes instanceof Uint8Array) || assets.coverPngBytes.byteLength < 1 ||
          assets.coverPngBytes.byteLength > MAX_ORDER_ASSET_BYTES ||
          !SHA256.test(assets.bodyPdfSha256) || hash(assets.bodyPdfBytes) !== assets.bodyPdfSha256 ||
          !SHA256.test(assets.coverPngSha256) || hash(assets.coverPngBytes) !== assets.coverPngSha256) {
        return recordFailure(job, "invalid_render");
      }
      if (expired()) return { status: "lease_expired" };

      const bodyObjectKey = `${job.orderId}/${job.leaseId}/body.pdf`;
      const coverObjectKey = `${job.orderId}/${job.leaseId}/cover.png`;
      try {
        await dependencies.storage.putIfAbsent({ key: bodyObjectKey, bytes: assets.bodyPdfBytes, contentType: "application/pdf" });
      } catch {
        const failure = await recordFailure(job, "storage_unavailable");
        return await removeUncommittedObjects([bodyObjectKey, coverObjectKey])
          ? failure
          : { status: "artifact_cleanup_pending" };
      }
      if (expired()) return await removeUncommittedObjects([bodyObjectKey])
        ? { status: "lease_expired" }
        : { status: "artifact_cleanup_pending" };
      try {
        await dependencies.storage.putIfAbsent({ key: coverObjectKey, bytes: assets.coverPngBytes, contentType: "image/png" });
      } catch {
        const failure = await recordFailure(job, "storage_unavailable");
        return await removeUncommittedObjects([bodyObjectKey, coverObjectKey])
          ? failure
          : { status: "artifact_cleanup_pending" };
      }
      if (expired()) return await removeUncommittedObjects([bodyObjectKey, coverObjectKey])
        ? { status: "lease_expired" }
        : { status: "artifact_cleanup_pending" };

      const commit: PdfRenderCommit = {
        orderId: job.orderId,
        leaseId: job.leaseId,
        bodyObjectKey,
        coverObjectKey,
        bodyPdfPageCount: assets.bodyPdfPageCount,
        bodyPdfSha256: assets.bodyPdfSha256,
        coverPngSha256: assets.coverPngSha256,
        bodyPdfSizeBytes: assets.bodyPdfBytes.byteLength,
        coverPngSizeBytes: assets.coverPngBytes.byteLength,
      };
      try {
        const completion = await dependencies.rpc.complete(commit);
        if (completion === "succeeded") return { status: "succeeded" };
        if (completion !== "rights_stopped" && completion !== "rights_ineligible") {
          return { status: "finalization_unknown" };
        }
        if (!await removeUncommittedObjects([bodyObjectKey, coverObjectKey])) {
          return { status: "artifact_cleanup_pending" };
        }
        return completion === "rights_stopped"
          ? { status: "rights_stopped" }
          : { status: "terminal_failure", errorCode: "rights_ineligible" };
      } catch {
        // Commit may have succeeded even if its response was lost. Keep the
        // lease authoritative and let the next status/lease check reconcile.
        return { status: "finalization_unknown" };
      }
    } catch {
      return { status: "internal_failure" };
    } finally {
      running = false;
    }
  }

  return { runOnce };
}
