import { createPaidNotificationQueueAdapter } from "../lib/order-paid-notification-queue-supabase.ts";
import { resolveOrderPaidNotificationConfig } from "../lib/order-paid-notification.ts";
import { runPaidNotificationWorkerOnce } from "../lib/order-paid-notification-worker.ts";

if (!process.argv.includes("--run-queue-once") || process.argv.length !== 3) {
  console.error("PAID_NOTIFICATION_WORKER_INVALID_ARGUMENTS");
  process.exit(2);
}

if (process.env.NODE_ENV !== "production") {
  console.error("PAID_NOTIFICATION_WORKER_PRODUCTION_MODE_REQUIRED");
  process.exit(2);
}

const config = resolveOrderPaidNotificationConfig();
if (!config) {
  console.error("PAID_NOTIFICATION_WORKER_CONFIG_INVALID");
  process.exit(2);
}

let queue;
try {
  queue = createPaidNotificationQueueAdapter();
} catch {
  console.error("PAID_NOTIFICATION_WORKER_CONFIG_INVALID");
  process.exit(2);
}

const result = await runPaidNotificationWorkerOnce({ queue, config });
switch (result.state) {
  case "sent":
    console.log("PAID_NOTIFICATION_SENT");
    break;
  case "idle":
    console.log("PAID_NOTIFICATION_QUEUE_IDLE");
    break;
  case "disabled":
    console.log("PAID_NOTIFICATION_DISABLED");
    break;
  case "retry_queued":
    console.log("PAID_NOTIFICATION_RETRY_QUEUED");
    break;
  case "needs_review":
    console.error("PAID_NOTIFICATION_NEEDS_REVIEW");
    break;
  case "failure_recording_pending":
    console.error("PAID_NOTIFICATION_FAILURE_RECORDING_PENDING");
    process.exitCode = 1;
    break;
  case "completion_unknown":
    console.error("PAID_NOTIFICATION_COMPLETION_UNKNOWN");
    process.exitCode = 1;
    break;
  case "worker_failed":
    console.error("PAID_NOTIFICATION_WORKER_FAILED");
    process.exitCode = 1;
    break;
}
