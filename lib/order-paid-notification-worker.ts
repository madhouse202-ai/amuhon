import {
  sendOrderPaidEmail,
  type OrderPaidNotificationConfig,
} from "./order-paid-notification.ts";
import type { PaidNotificationClaim, PaidNotificationQueue } from "./order-paid-notification-queue-supabase.ts";

export type PaidNotificationWorkerResult =
  | { state: "idle" | "disabled" | "sent" | "retry_queued" | "needs_review" }
  | { state: "failure_recording_pending" | "completion_unknown" | "worker_failed" };

export async function runPaidNotificationWorkerOnce(input: {
  queue: PaidNotificationQueue;
  config: OrderPaidNotificationConfig;
  send?: typeof sendOrderPaidEmail;
}): Promise<PaidNotificationWorkerResult> {
  const send = input.send ?? sendOrderPaidEmail;
  let claim: PaidNotificationClaim;
  try {
    claim = await input.queue.claimNext(90);
  } catch {
    return { state: "worker_failed" };
  }
  if (claim.state === "idle") return { state: "idle" };
  if (claim.state === "disabled") return { state: "disabled" };
  if (claim.state !== "claimed") return { state: "worker_failed" };

  let delivery;
  try {
    delivery = await send(claim.order, input.config);
  } catch {
    delivery = { ok: false as const, errorCode: "resend_outcome_unknown" as const };
  }

  if (!delivery.ok) {
    try {
      const failureState = await input.queue.fail(claim.order.id, claim.leaseId, delivery.errorCode);
      return failureState === "queued" ? { state: "retry_queued" } :
        failureState === "needs_review" ? { state: "needs_review" } : { state: "worker_failed" };
    } catch {
      // The lease expires and the next poll will retry with the same Resend idempotency key.
      return { state: "failure_recording_pending" };
    }
  }

  try {
    const completed = await input.queue.complete(claim.order.id, claim.leaseId, delivery.emailId);
    return completed ? { state: "sent" } : { state: "completion_unknown" };
  } catch {
    // Resend's stable idempotency key makes a lease-expiry retry safe if this
    // completion result is ambiguous after the provider accepted the message.
    return { state: "completion_unknown" };
  }
}
