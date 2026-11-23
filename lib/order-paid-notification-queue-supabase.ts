import {
  createSupabaseServiceHeaders,
  getSupabaseServiceCredential,
} from "./supabase-service-credential.ts";
import {
  isValidOrderPaidNotificationOrder,
  type OrderPaidNotificationOrder,
} from "./order-paid-notification.ts";

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RPC_BYTES = 32_768;

export type PaidNotificationClaim =
  | { state: "idle" | "disabled" }
  | { state: "claimed"; order: OrderPaidNotificationOrder; leaseId: string };

export type PaidNotificationQueue = {
  claimNext(leaseSeconds: number): Promise<PaidNotificationClaim>;
  complete(orderId: string, leaseId: string, emailId: string): Promise<boolean>;
  fail(orderId: string, leaseId: string, errorCode: string): Promise<"queued" | "needs_review" | "lease_lost">;
};

type QueueEnvironment = Record<string, string | undefined>;
type QueueConfig = {
  origin: string;
  credential: NonNullable<ReturnType<typeof getSupabaseServiceCredential>>;
};

export class PaidNotificationQueueError extends Error {
  constructor() {
    super("paid_notification_queue_error");
    this.name = "PaidNotificationQueueError";
  }
}

export function parsePaidNotificationQueueConfig(env: QueueEnvironment): QueueConfig | null {
  const rawUrl = env.SUPABASE_URL;
  const projectRef = env.AMUHON_NOTIFICATION_QUEUE_PROJECT_REF;
  const credential = getSupabaseServiceCredential(env);
  if (!rawUrl || !projectRef || !PROJECT_REF_PATTERN.test(projectRef) || !credential) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== `${projectRef}.supabase.co` ||
        url.origin !== rawUrl.replace(/\/$/, "") || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) return null;
    return { origin: url.origin, credential };
  } catch {
    return null;
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RPC_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new PaidNotificationQueueError();
  }
  if (!response.body) throw new PaidNotificationQueueError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RPC_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PaidNotificationQueueError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8")) as unknown;
  } catch {
    throw new PaidNotificationQueueError();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PaidNotificationQueueError();
  return value as Record<string, unknown>;
}

function parseClaim(value: unknown): PaidNotificationClaim {
  const result = record(value);
  if (result.state === "idle" || result.state === "disabled") return { state: result.state };
  if (result.state !== "claimed" || !UUID_PATTERN.test(String(result.leaseId))) throw new PaidNotificationQueueError();
  const order = {
    id: result.orderId,
    orderNumber: result.orderNumber,
    title: result.title,
    pageCount: result.pageCount,
    amountYen: result.amountYen,
  };
  if (!isValidOrderPaidNotificationOrder(order)) throw new PaidNotificationQueueError();
  return { state: "claimed", order, leaseId: result.leaseId as string };
}

function parseState(value: unknown, allowed: readonly string[]): string {
  const result = record(value);
  if (typeof result.state !== "string" || !allowed.includes(result.state)) throw new PaidNotificationQueueError();
  return result.state;
}

export function createPaidNotificationQueueAdapter(
  env: QueueEnvironment = process.env,
  fetchImpl: typeof fetch = fetch,
): PaidNotificationQueue {
  const parsedConfig = parsePaidNotificationQueueConfig(env);
  if (!parsedConfig) throw new PaidNotificationQueueError();
  const config: QueueConfig = parsedConfig;

  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${config.origin}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: createSupabaseServiceHeaders(config.credential, {
          "content-type": "application/json",
          accept: "application/json",
        }),
        body: JSON.stringify(args),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PaidNotificationQueueError();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PaidNotificationQueueError();
    }
    return readBoundedJson(response);
  }

  return {
    async claimNext(leaseSeconds) {
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 300) throw new PaidNotificationQueueError();
      return parseClaim(await rpc("claim_next_amuhon_order_paid_notification_v1", { p_lease_seconds: leaseSeconds }));
    },
    async complete(orderId, leaseId, emailId) {
      if (!UUID_PATTERN.test(orderId) || !UUID_PATTERN.test(leaseId) || !/^[A-Za-z0-9_-]{1,128}$/.test(emailId)) {
        throw new PaidNotificationQueueError();
      }
      const result = await rpc("complete_amuhon_order_paid_notification_v1", {
        p_order_id: orderId, p_lease_id: leaseId, p_resend_email_id: emailId,
      });
      return parseState(result, ["sent"]) === "sent";
    },
    async fail(orderId, leaseId, errorCode) {
      if (!UUID_PATTERN.test(orderId) || !UUID_PATTERN.test(leaseId) ||
          !["resend_retryable_failure", "resend_rejected", "resend_outcome_unknown"].includes(errorCode)) {
        throw new PaidNotificationQueueError();
      }
      return parseState(await rpc("fail_amuhon_order_paid_notification_v1", {
        p_order_id: orderId, p_lease_id: leaseId, p_error_code: errorCode,
      }), ["queued", "needs_review", "lease_lost"]) as "queued" | "needs_review" | "lease_lost";
    },
  };
}
