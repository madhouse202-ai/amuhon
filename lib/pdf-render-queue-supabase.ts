import {
  createSupabaseServiceHeaders,
  getSupabaseServiceCredential,
} from "./supabase-service-credential.ts";
import type {
  ClaimedPdfRenderJob,
  PdfRenderCommit,
  PdfRenderErrorCode,
  PdfRenderQueueRpc,
  PdfRenderQueueStorage,
} from "./pdf-render-queue-worker.ts";

export const PDF_RENDER_STORAGE_BUCKET = "amuhon-order-files";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_REF = /^[a-z0-9]{20}$/;
// The order draft API caps the complete book snapshot at 256 KiB; allow JSON
// encoding overhead without accepting an unbounded PostgREST response.
const RPC_LIMIT = 512 * 1024;
const RPC_TIMEOUT_MS = 15_000;
const STORAGE_TIMEOUT_MS = 60_000;

type QueueEnvironment = Record<string, string | undefined>;
type QueueConfig = { origin: string; projectRef: string; credential: NonNullable<ReturnType<typeof getSupabaseServiceCredential>> };

export class PdfRenderQueueAdapterError extends Error {
  constructor() {
    super("pdf_render_queue_adapter_error");
    this.name = "PdfRenderQueueAdapterError";
  }
}

export function parsePdfRenderQueueConfig(env: QueueEnvironment): QueueConfig | null {
  const rawUrl = env.SUPABASE_URL;
  const projectRef = env.AMUHON_PDF_QUEUE_PROJECT_REF;
  const credential = getSupabaseServiceCredential(env);
  if (!rawUrl || !projectRef || !PROJECT_REF.test(projectRef) || !credential) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== `${projectRef}.supabase.co` ||
        url.origin !== rawUrl.replace(/\/$/, "") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return { origin: url.origin, projectRef, credential };
  } catch {
    return null;
  }
}

async function readJsonBounded(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > RPC_LIMIT) {
    await response.body?.cancel().catch(() => undefined);
    throw new PdfRenderQueueAdapterError();
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RPC_LIMIT) {
        await reader.cancel().catch(() => undefined);
        throw new PdfRenderQueueAdapterError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8")) as unknown;
  } catch {
    throw new PdfRenderQueueAdapterError();
  }
}

function parseClaim(value: unknown): ClaimedPdfRenderJob | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PdfRenderQueueAdapterError();
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "orderId", "leaseId", "leaseExpiresAt", "attemptCount", "expectedBodyPdfPageCount", "bookSnapshot",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key)) ||
      typeof record.orderId !== "string" || !UUID.test(record.orderId) ||
      typeof record.leaseId !== "string" || !UUID.test(record.leaseId) ||
      typeof record.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(record.leaseExpiresAt)) ||
      !Number.isSafeInteger(record.attemptCount) || (record.attemptCount as number) < 1 || (record.attemptCount as number) > 5 ||
      !Number.isSafeInteger(record.expectedBodyPdfPageCount) || (record.expectedBodyPdfPageCount as number) < 24 ||
      (record.expectedBodyPdfPageCount as number) > 300 || (record.expectedBodyPdfPageCount as number) % 8 !== 0 ||
      !record.bookSnapshot || typeof record.bookSnapshot !== "object" || Array.isArray(record.bookSnapshot)) {
    throw new PdfRenderQueueAdapterError();
  }
  return record as unknown as ClaimedPdfRenderJob;
}

function objectUrl(config: QueueConfig, key: string): string {
  const segments = key.split("/");
  if (segments.length !== 3 || !UUID.test(segments[0]) || !UUID.test(segments[1]) ||
      !["body.pdf", "cover.png"].includes(segments[2])) throw new PdfRenderQueueAdapterError();
  return `${config.origin}/storage/v1/object/${PDF_RENDER_STORAGE_BUCKET}/${segments.map(encodeURIComponent).join("/")}`;
}

export function createSupabasePdfRenderQueueAdapter(
  env: QueueEnvironment = process.env,
  fetchImpl: typeof fetch = fetch,
): PdfRenderQueueRpc & PdfRenderQueueStorage {
  const config = parsePdfRenderQueueConfig(env);
  if (!config) throw new PdfRenderQueueAdapterError();
  const validConfig: QueueConfig = config;

  async function rpc(name: string, args: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${validConfig.origin}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: createSupabaseServiceHeaders(validConfig.credential, {
          "content-type": "application/json",
          accept: "application/json",
        }),
        body: JSON.stringify(args),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new PdfRenderQueueAdapterError();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PdfRenderQueueAdapterError();
    }
    return readJsonBounded(response);
  }

  return {
    async claim(leaseSeconds) {
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 1800) throw new PdfRenderQueueAdapterError();
      return parseClaim(await rpc("claim_amuhon_order_pdf_render_job", { p_lease_seconds: leaseSeconds }));
    },
    async fail(orderId, leaseId, errorCode: PdfRenderErrorCode) {
      if (!UUID.test(orderId) || !UUID.test(leaseId)) throw new PdfRenderQueueAdapterError();
      const value = await rpc("fail_amuhon_order_pdf_render_job", {
        p_order_id: orderId,
        p_lease_id: leaseId,
        p_error_code: errorCode,
      });
      if (typeof value !== "boolean") throw new PdfRenderQueueAdapterError();
      return value;
    },
    async complete(input: PdfRenderCommit) {
      if (!UUID.test(input.orderId) || !UUID.test(input.leaseId)) throw new PdfRenderQueueAdapterError();
      const value = await rpc("complete_amuhon_order_pdf_render_job", {
        p_order_id: input.orderId,
        p_lease_id: input.leaseId,
        p_body_object_key: input.bodyObjectKey,
        p_cover_object_key: input.coverObjectKey,
        p_body_pdf_page_count: input.bodyPdfPageCount,
        p_body_pdf_sha256: input.bodyPdfSha256,
        p_cover_png_sha256: input.coverPngSha256,
        p_body_pdf_size_bytes: input.bodyPdfSizeBytes,
        p_cover_png_size_bytes: input.coverPngSizeBytes,
      });
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new PdfRenderQueueAdapterError();
      const state = (value as Record<string, unknown>).state;
      if (state !== "succeeded" && state !== "rights_stopped" && state !== "rights_ineligible") {
        throw new PdfRenderQueueAdapterError();
      }
      return state;
    },
    async putIfAbsent(input) {
      const expectedType = input.key.endsWith("/body.pdf") ? "application/pdf" : "image/png";
      if (input.contentType !== expectedType || input.bytes.byteLength < 1 || input.bytes.byteLength > 40_000_000) {
        throw new PdfRenderQueueAdapterError();
      }
      let response: Response;
      try {
      response = await fetchImpl(objectUrl(validConfig, input.key), {
          method: "POST",
          headers: createSupabaseServiceHeaders(validConfig.credential, {
            "content-type": input.contentType,
            "x-upsert": "false",
          }),
          body: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength) as unknown as BodyInit,
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
        });
      } catch {
        throw new PdfRenderQueueAdapterError();
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new PdfRenderQueueAdapterError();
      }
      await response.body?.cancel().catch(() => undefined);
    },
    async removeIfPresent(input) {
      // Validate the entire lease-scoped object key before issuing a delete.
      objectUrl(validConfig, input.key);
      let response: Response;
      try {
        response = await fetchImpl(`${validConfig.origin}/storage/v1/object/${PDF_RENDER_STORAGE_BUCKET}`, {
          method: "DELETE",
          headers: createSupabaseServiceHeaders(validConfig.credential, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({ prefixes: [input.key] }),
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
        });
      } catch {
        throw new PdfRenderQueueAdapterError();
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new PdfRenderQueueAdapterError();
      }
      await response.body?.cancel().catch(() => undefined);
    },
  };
}
