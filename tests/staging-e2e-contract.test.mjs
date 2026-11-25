import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { POST as stripeWebhookPost } from "../app/api/webhooks/stripe/route.ts";
import { createPdfRenderQueueWorker } from "../lib/pdf-render-queue-worker.ts";
import { createSupabasePdfRenderQueueAdapter } from "../lib/pdf-render-queue-supabase.ts";

const ORDER_ID = "54f81d59-76a8-47a0-9f57-9d9a9c3d22b8";
const ATTEMPT_ID = "5c8c89d2-1000-4f6e-8db2-2bda904b5710";
const LEASE_ID = "e27205c2-ff9a-4b45-a2e7-29c462af70e4";
const WEBHOOK_SECRET = "whsec_mock_contract_only";
const SUPABASE_REF = "abcdefghijklmnopqrst";
const envKeys = ["STRIPE_MODE", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "AMUHON_PDF_QUEUE_PROJECT_REF"];
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

const selectedWork = {
  id: "000015",
  title: "作品一",
  author: "作者一",
  cardUrl: "https://www.aozora.gr.jp/cards/000000/card15.html",
  textUrl: "https://www.aozora.gr.jp/cards/000000/files/15_1.txt",
  xhtmlUrl: "https://www.aozora.gr.jp/cards/000000/files/15_1.html",
};
const bookSnapshot = {
  title: "合成E2E検証本",
  editor: "試験用",
  coverStyle: "classic",
  coverColor: "blue",
  works: [selectedWork],
};
const workTexts = [{ ...selectedWork, text: "｜試験《しけん》用の縦書き本文。" }];
const bodyBytes = new TextEncoder().encode("mock-rendered-body-pdf");
const coverBytes = new TextEncoder().encode("mock-rendered-cover-png");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const renderAssets = {
  bodyPdfBytes: bodyBytes,
  coverPngBytes: coverBytes,
  bodyPdfPageCount: 88,
  bodyPdfSha256: sha256(bodyBytes),
  coverPngSha256: sha256(coverBytes),
};

function createSignedEvent() {
  return {
    id: "evt_mockcontract001",
    type: "checkout.session.completed",
    livemode: false,
    data: { object: {
      id: "cs_test_mockcontract001",
      object: "checkout.session",
      mode: "payment",
      livemode: false,
      payment_status: "paid",
      currency: "jpy",
      amount_total: 1980,
      expires_at: Math.floor(Date.now() / 1000) + 1800,
      client_reference_id: ORDER_ID,
      payment_intent: "pi_testmockcontract001",
      metadata: { order_id: ORDER_ID, checkout_attempt_id: ATTEMPT_ID },
    } },
  };
}

function signature(rawBody) {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.`).update(rawBody).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function requestForWebhook(rawBody, stripeSignature) {
  return new Request("https://amuhon-staging.test/api/webhooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": stripeSignature },
    body: rawBody,
  });
}

test("queue migration only enqueues a new paid transition and keeps one job per order", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261115000200_order_pdf_render_jobs.sql", import.meta.url), "utf8");
  assert.match(sql, /order_id uuid primary key[\s\S]*?references public\.amuhon_orders\s*\(id\) on delete restrict/i);
  assert.match(sql, /if old\.status is distinct from new\.status and new\.status = 'paid' then[\s\S]*?on conflict \(order_id\) do nothing/i);
  assert.match(sql, /after update of status on public\.amuhon_orders[\s\S]*?when \(old\.status is distinct from new\.status and new\.status = 'paid'\)/i);
  assert.doesNotMatch(sql, /insert\s+into\s+public\.amuhon_order_pdf_render_jobs\s*\([^)]*\)\s*select/i);
});

test("signed paid webhook, duplicate delivery, queue claim, private create-only assets, and completion agree at the mocked boundaries", async () => {
  const previousFetch = globalThis.fetch;
  for (const [key, value] of [
    ["STRIPE_MODE", "test"],
    ["STRIPE_SECRET_KEY", "sk_test_mock-contract-only"],
    ["STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET],
    ["SUPABASE_URL", `https://${SUPABASE_REF}.supabase.co`],
    ["SUPABASE_SECRET_KEY", "sb_secret_mock_contract_only"],
    ["AMUHON_PDF_QUEUE_PROJECT_REF", SUPABASE_REF],
  ]) process.env[key] = value;

  const state = {
    paid: false,
    jobState: "absent",
    notificationState: "absent",
    notificationsEnabled: false,
    customerNotificationState: "absent",
    webhookEventIds: new Set(),
    claimCount: 0,
    completionCount: 0,
    objects: new Map(),
    rpcCalls: [],
  };
  const expectedLeaseExpiry = new Date(Date.now() + 20 * 60_000).toISOString();

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    assert.equal(url.origin, `https://${SUPABASE_REF}.supabase.co`);
    assert.equal(headers.get("apikey"), "sb_secret_mock_contract_only");
    assert.equal(headers.has("authorization"), false);
    assert.equal(init.redirect, "error");

    if (url.pathname === "/rest/v1/rpc/apply_amuhon_stripe_checkout_paid_v2") {
      const args = JSON.parse(String(init.body));
      state.rpcCalls.push("payment");
      assert.equal(args.p_order_id, ORDER_ID);
      assert.equal(args.p_checkout_attempt_id, ATTEMPT_ID);
      assert.equal(args.p_amount_total, 1980);
      assert.equal(args.p_currency, "jpy");
      assert.equal(args.p_livemode, false);
      if (state.webhookEventIds.has(args.p_event_id)) return Response.json({ state: "duplicate" });

      state.webhookEventIds.add(args.p_event_id);
      const newlyPaid = !state.paid;
      state.paid = true;
      // Model the SQL after-update trigger's transaction boundary and unique order key.
      if (newlyPaid && state.jobState === "absent") state.jobState = "queued";
      if (newlyPaid && state.notificationState === "absent") {
        state.notificationState = state.notificationsEnabled ? "queued" : "suppressed";
      }
      if (newlyPaid && state.customerNotificationState === "absent") state.customerNotificationState = "suppressed";
      return Response.json({ state: "paid" });
    }

    if (url.pathname === "/rest/v1/rpc/get_amuhon_order_paid_notification_webhook_status_v1") {
      state.rpcCalls.push("notification_status");
      assert.deepEqual(JSON.parse(String(init.body)), { p_order_id: ORDER_ID });
      return Response.json({ state: state.notificationState, customerState: state.customerNotificationState });
    }

    if (url.pathname === "/rest/v1/rpc/claim_amuhon_order_pdf_render_job") {
      state.rpcCalls.push("claim");
      assert.equal(JSON.parse(String(init.body)).p_lease_seconds, 1800);
      if (!state.paid || state.jobState !== "queued") return Response.json(null);
      state.claimCount += 1;
      state.jobState = "rendering";
      return Response.json({
        orderId: ORDER_ID,
        leaseId: LEASE_ID,
        leaseExpiresAt: expectedLeaseExpiry,
        attemptCount: 1,
        expectedBodyPdfPageCount: 88,
        bookSnapshot,
      });
    }

    if (url.pathname.startsWith(`/storage/v1/object/amuhon-order-files/${ORDER_ID}/${LEASE_ID}/`)) {
      state.rpcCalls.push("storage");
      assert.equal(init.method, "POST");
      assert.equal(headers.get("x-upsert"), "false");
      const key = decodeURIComponent(url.pathname.split("/storage/v1/object/amuhon-order-files/")[1]);
      if (state.objects.has(key)) return new Response(null, { status: 409 });
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      state.objects.set(key, bytes);
      return new Response(null, { status: 200 });
    }

    if (url.pathname === "/rest/v1/rpc/complete_amuhon_order_pdf_render_job") {
      state.rpcCalls.push("complete");
      const args = JSON.parse(String(init.body));
      assert.equal(state.paid, true);
      assert.equal(state.jobState, "rendering");
      assert.equal(state.objects.has(`${ORDER_ID}/${LEASE_ID}/body.pdf`), true);
      assert.equal(state.objects.has(`${ORDER_ID}/${LEASE_ID}/cover.png`), true);
      assert.equal(args.p_body_pdf_page_count, 88);
      assert.equal(args.p_body_pdf_sha256, sha256(bodyBytes));
      assert.equal(args.p_cover_png_sha256, sha256(coverBytes));
      state.completionCount += 1;
      state.jobState = "succeeded";
      return Response.json({ state: "succeeded" });
    }

    throw new Error("unexpected_mock_request");
  };

  try {
    const event = createSignedEvent();
    const rawBody = JSON.stringify(event);
    const stripeSignature = signature(rawBody);
    const firstWebhook = await stripeWebhookPost(requestForWebhook(rawBody, stripeSignature));
    const duplicateWebhook = await stripeWebhookPost(requestForWebhook(rawBody, stripeSignature));
    assert.equal(firstWebhook.status, 200);
    assert.equal(duplicateWebhook.status, 200);
    assert.equal(state.paid, true);
    assert.equal(state.jobState, "queued");
    assert.equal(state.notificationState, "suppressed");
    assert.equal(state.customerNotificationState, "suppressed");
    assert.equal(state.webhookEventIds.size, 1);

    const adapter = createSupabasePdfRenderQueueAdapter(process.env);
    const worker = createPdfRenderQueueWorker({
      rpc: adapter,
      storage: adapter,
      loadWorkTexts: async () => workTexts,
      render: async ({ expectedPageCount }) => {
        assert.equal(expectedPageCount, 88);
        return renderAssets;
      },
    });
    assert.deepEqual(await worker.runOnce(), { status: "succeeded" });
    assert.equal(state.claimCount, 1);
    assert.equal(state.completionCount, 1);
    assert.equal(state.jobState, "succeeded");
    assert.deepEqual([...state.objects.keys()].sort(), [
      `${ORDER_ID}/${LEASE_ID}/body.pdf`,
      `${ORDER_ID}/${LEASE_ID}/cover.png`,
    ]);
    assert.deepEqual(state.rpcCalls, [
      "payment", "notification_status",
      "payment", "notification_status",
      "claim", "storage", "storage", "complete",
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
