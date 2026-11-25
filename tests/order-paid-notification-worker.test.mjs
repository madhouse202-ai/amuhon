import assert from "node:assert/strict";
import test from "node:test";
import {
  createPaidNotificationQueueAdapter,
  parsePaidNotificationQueueConfig,
} from "../lib/order-paid-notification-queue-supabase.ts";
import { createOrderPaidEmailPayload, createCustomerOrderEmailPayload } from "../lib/order-paid-notification.ts";
import { runPaidNotificationWorkerOnce } from "../lib/order-paid-notification-worker.ts";

const ORDER = {
  id: "d9d71ea0-115c-4b26-8c1d-86bead2aecc4",
  orderNumber: "AMU-20261123-D9D71EA0",
  title: "合成テスト作品",
  pageCount: 72,
  amountYen: 1980,
};
const LEASE_ID = "6ea4cc75-ccad-4f3f-bedd-f57d408ad6a3";
const CONFIG = { apiKey: "re_test_only_mock_key_12345678", appOrigin: "https://amuhon.jp" };

function claimed() {
  return { state: "claimed", notificationType: "operator_paid", order: ORDER, leaseId: LEASE_ID };
}

test("queue adapter is pinned to the staging project and sends the secret only as apikey", async () => {
  const env = {
    SUPABASE_URL: "https://ahxnmkuvdpzctcwcyadl.supabase.co",
    AMUHON_NOTIFICATION_QUEUE_PROJECT_REF: "ahxnmkuvdpzctcwcyadl",
    SUPABASE_SECRET_KEY: "sb_secret_mock_only_for_tests",
  };
  assert.ok(parsePaidNotificationQueueConfig(env));
  assert.equal(parsePaidNotificationQueueConfig({ ...env, SUPABASE_URL: "https://attacker.example" }), null);
  let request;
  const adapter = createPaidNotificationQueueAdapter(env, async (url, init) => {
    request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
    return Response.json({ state: "idle" });
  });
  assert.deepEqual(await adapter.claimNext(90), { state: "idle" });
  assert.match(request.url, /claim_next_amuhon_email_notification_v1$/);
  assert.equal(request.headers.get("apikey"), env.SUPABASE_SECRET_KEY);
  assert.equal(request.headers.get("authorization"), null);
  assert.equal(request.body.p_lease_seconds, 90);
});

test("queue adapter parses customer claims and dispatches lifecycle RPCs by event without exposing responses", async () => {
  const env = {
    SUPABASE_URL: "https://ahxnmkuvdpzctcwcyadl.supabase.co",
    AMUHON_NOTIFICATION_QUEUE_PROJECT_REF: "ahxnmkuvdpzctcwcyadl",
    SUPABASE_SECRET_KEY: "sb_secret_mock_only_for_tests",
  };
  const requests = [];
  const customer = {
    state: "claimed", notificationType: "customer_order_confirmed",
    orderId: ORDER.id, orderNumber: ORDER.orderNumber, title: ORDER.title,
    amountYen: ORDER.amountYen, recipientEmail: "tester@example.net", leaseId: LEASE_ID,
  };
  const adapter = createPaidNotificationQueueAdapter(env, async (url, init) => {
    const name = String(url).split("/rpc/").at(-1);
    requests.push({ name, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    return name === "claim_next_amuhon_email_notification_v1"
      ? Response.json(customer)
      : Response.json({ state: name.startsWith("complete_") ? "sent" : "needs_review" });
  });
  assert.deepEqual(await adapter.claimNext(90), {
    state: "claimed", notificationType: "customer_order_confirmed",
    order: { id: ORDER.id, orderNumber: ORDER.orderNumber, title: ORDER.title, amountYen: 1980, recipientEmail: "tester@example.net" },
    leaseId: LEASE_ID,
  });
  assert.equal(await adapter.complete(ORDER.id, LEASE_ID, "email_customer_1", "customer_order_confirmed"), true);
  assert.equal(await adapter.fail(ORDER.id, LEASE_ID, "customer_recipient_not_allowlisted", "customer_order_confirmed"), "needs_review");
  assert.deepEqual(requests.map((request) => request.name), [
    "claim_next_amuhon_email_notification_v1",
    "complete_amuhon_customer_order_notification_v1",
    "fail_amuhon_customer_order_notification_v1",
  ]);
  assert.deepEqual(requests[1].body, {
    p_order_id: ORDER.id, p_notification_type: "order_confirmed",
    p_lease_id: LEASE_ID, p_resend_email_id: "email_customer_1",
  });
  assert.equal(requests[2].body.p_error_code, "customer_recipient_not_allowlisted");
  assert.equal(requests[0].headers.get("apikey"), env.SUPABASE_SECRET_KEY);
  assert.equal(requests[0].headers.has("authorization"), false);
});

test("one transient delivery failure is persisted and a later poll retries with a stable provider key", async () => {
  let claimCount = 0;
  const failures = [];
  const completed = [];
  const idempotencyKeys = [];
  const queue = {
    async claimNext() { claimCount += 1; return claimed(); },
    async fail(orderId, leaseId, code) { failures.push({ orderId, leaseId, code }); return "queued"; },
    async complete(orderId, leaseId, emailId) { completed.push({ orderId, leaseId, emailId }); return true; },
  };
  let sends = 0;
  const send = async (order, config) => {
    idempotencyKeys.push(createOrderPaidEmailPayload(order, config).idempotencyKey);
    sends += 1;
    return sends === 1
      ? { ok: false, errorCode: "resend_retryable_failure" }
      : { ok: true, emailId: "email_synthetic_success" };
  };

  assert.deepEqual(await runPaidNotificationWorkerOnce({ queue, config: CONFIG, send }), { state: "retry_queued" });
  assert.deepEqual(failures, [{ orderId: ORDER.id, leaseId: LEASE_ID, code: "resend_retryable_failure" }]);
  assert.deepEqual(await runPaidNotificationWorkerOnce({ queue, config: CONFIG, send }), { state: "sent" });
  assert.equal(claimCount, 2);
  assert.equal(sends, 2);
  assert.deepEqual(idempotencyKeys, [
    `amuhon/order-paid/${ORDER.id}`,
    `amuhon/order-paid/${ORDER.id}`,
  ]);
  assert.deepEqual(completed, [{ orderId: ORDER.id, leaseId: LEASE_ID, emailId: "email_synthetic_success" }]);
});

test("expired completion ambiguity is retried with the same idempotency key, not sent twice by the process", async () => {
  let sendCount = 0;
  let completeCount = 0;
  const queue = {
    async claimNext() { return claimed(); },
    async fail() { assert.fail("failure RPC must not run after accepted send"); },
    async complete() { completeCount += 1; throw new Error("hidden RPC detail"); },
  };
  const result = await runPaidNotificationWorkerOnce({
    queue,
    config: CONFIG,
    send: async () => { sendCount += 1; return { ok: true, emailId: "email_synthetic_success" }; },
  });
  assert.deepEqual(result, { state: "completion_unknown" });
  assert.equal(sendCount, 1);
  assert.equal(completeCount, 1);
});

test("database disablement and empty queue never call the provider", async () => {
  for (const state of ["disabled", "idle"]) {
    let sends = 0;
    const queue = {
      async claimNext() { return { state }; },
      async fail() { assert.fail("no claim to fail"); },
      async complete() { assert.fail("no claim to complete"); },
    };
    assert.deepEqual(await runPaidNotificationWorkerOnce({
      queue, config: CONFIG,
      send: async () => { sends += 1; return { ok: true, emailId: "unused" }; },
    }), { state });
    assert.equal(sends, 0);
  }
});

test("failed retry recording leaves the leased row for safe expiry recovery", async () => {
  const queue = {
    async claimNext() { return claimed(); },
    async fail() { throw new Error("database detail is suppressed"); },
    async complete() { assert.fail("failed delivery cannot complete"); },
  };
  const result = await runPaidNotificationWorkerOnce({
    queue, config: CONFIG,
    send: async () => ({ ok: false, errorCode: "resend_outcome_unknown" }),
  });
  assert.deepEqual(result, { state: "failure_recording_pending" });
});

test("customer event claims use the customer template, per-event idempotency, and customer completion RPC path", async () => {
  const customer = {
    id: ORDER.id,
    orderNumber: ORDER.orderNumber,
    title: ORDER.title,
    amountYen: ORDER.amountYen,
    recipientEmail: "tester@example.net",
  };
  const queueCalls = [];
  const queue = {
    async claimNext() { return { state: "claimed", notificationType: "customer_order_shipped", order: customer, leaseId: LEASE_ID }; },
    async fail(...args) { queueCalls.push(["fail", ...args]); return "queued"; },
    async complete(...args) { queueCalls.push(["complete", ...args]); return true; },
  };
  const keys = [];
  const result = await runPaidNotificationWorkerOnce({
    queue,
    config: CONFIG,
    customerConfig: { apiKey: CONFIG.apiKey, mode: "staging", stagingRecipientAllowlist: ["tester@example.net"] },
    sendCustomer: async (type, order) => {
      keys.push(createCustomerOrderEmailPayload(type, order).idempotencyKey);
      return { ok: true, emailId: "email_customer_synthetic" };
    },
  });
  assert.deepEqual(result, { state: "sent" });
  assert.deepEqual(keys, [`amuhon/customer/order_shipped/${ORDER.id}`]);
  assert.deepEqual(queueCalls, [["complete", ORDER.id, LEASE_ID, "email_customer_synthetic", "customer_order_shipped"]]);
});

test("customer notification without an explicit delivery config is never sent and is sent to review", async () => {
  const customer = {
    id: ORDER.id,
    orderNumber: ORDER.orderNumber,
    title: ORDER.title,
    amountYen: ORDER.amountYen,
    recipientEmail: "tester@example.net",
  };
  const failures = [];
  let sends = 0;
  const queue = {
    async claimNext() { return { state: "claimed", notificationType: "customer_order_confirmed", order: customer, leaseId: LEASE_ID }; },
    async fail(...args) { failures.push(args); return "needs_review"; },
    async complete() { assert.fail("missing config cannot complete"); },
  };
  const result = await runPaidNotificationWorkerOnce({
    queue, config: CONFIG,
    sendCustomer: async () => { sends += 1; return { ok: true, emailId: "unexpected" }; },
  });
  assert.deepEqual(result, { state: "needs_review" });
  assert.equal(sends, 0);
  assert.deepEqual(failures, [[ORDER.id, LEASE_ID, "customer_delivery_configuration_invalid", "customer_order_confirmed"]]);
});
