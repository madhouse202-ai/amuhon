import assert from "node:assert/strict";
import test from "node:test";
import {
  createOrderPaidEmailPayload,
  isValidOrderPaidNotificationOrder,
  resolveOrderPaidNotificationConfig,
  sendOrderPaidEmail,
} from "../lib/order-paid-notification.ts";

const order = {
  id: "d9d71ea0-115c-4b26-8c1d-86bead2aecc4",
  orderNumber: "AMU-20261123-D9D71EA0",
  title: "『<script>alert(1)</script>』",
  pageCount: 72,
  amountYen: 1980,
};
const config = { apiKey: "re_test_only_mock_key_12345678", appOrigin: "https://amuhon.jp" };

test("notification delivery configuration is validated independently from the database enable switch", () => {
  assert.equal(resolveOrderPaidNotificationConfig({}), null);
  assert.deepEqual(resolveOrderPaidNotificationConfig({
    RESEND_API_KEY: config.apiKey,
    AMUHON_PUBLIC_ORIGIN: config.appOrigin, NODE_ENV: "production",
  }), config);
  for (const invalid of [
    { ...config, appOrigin: "https://attacker.example" },
    { ...config, appOrigin: "https://amuhon.jp.evil.example" },
    { ...config, appOrigin: "http://amuhon.jp" },
    { ...config, apiKey: "" },
  ]) {
    assert.equal(resolveOrderPaidNotificationConfig({
      RESEND_API_KEY: invalid.apiKey,
      AMUHON_PUBLIC_ORIGIN: invalid.appOrigin, NODE_ENV: "production",
    }), null);
  }
  assert.deepEqual(resolveOrderPaidNotificationConfig({
    RESEND_API_KEY: config.apiKey,
    AMUHON_PUBLIC_ORIGIN: "http://localhost:3000", NODE_ENV: "development",
  }), { ...config, appOrigin: "http://localhost:3000" });
});

test("staging notifications omit management links even if the production origin is configured", () => {
  const stagingConfig = resolveOrderPaidNotificationConfig({
    RESEND_API_KEY: config.apiKey,
    SUPABASE_URL: "https://ahxnmkuvdpzctcwcyadl.supabase.co",
    AMUHON_PUBLIC_ORIGIN: "https://amuhon.jp",
    NODE_ENV: "production",
  });
  assert.deepEqual(stagingConfig, { apiKey: config.apiKey, appOrigin: null });

  const payload = createOrderPaidEmailPayload(order, stagingConfig);
  assert.doesNotMatch(payload.text, /https:\/\/amuhon\.jp/);
  assert.doesNotMatch(payload.html, /href=/);
  assert.match(payload.text, /注文管理画面で注文番号 AMU-20261123-D9D71EA0 を検索/);
  assert.match(payload.html, /注文管理画面で注文番号 AMU-20261123-D9D71EA0 を検索/);
});

test("email payload contains only required order summary and escapes HTML", () => {
  assert.equal(isValidOrderPaidNotificationOrder(order), true);
  assert.equal(isValidOrderPaidNotificationOrder({ ...order, pageCount: 0 }), false);
  assert.equal(isValidOrderPaidNotificationOrder({ ...order, orderNumber: "forged" }), false);
  const payload = createOrderPaidEmailPayload(order, config);
  assert.equal(payload.to[0], "amuhon.jp@gmail.com");
  assert.equal(payload.from, "編む本 <notice@amuhon.jp>");
  assert.match(payload.text, /ページ数：72ページ/);
  assert.match(payload.text, /金額：1,980円/);
  assert.equal(payload.idempotencyKey, `amuhon/order-paid/${order.id}`);
  assert.match(payload.html, /&lt;script&gt;/);
  assert.doesNotMatch(payload.html, /<script>/);
  assert.match(payload.html, /\/admin\/orders\/d9d71ea0-115c-4b26-8c1d-86bead2aecc4/);
});

test("Resend uses a fixed endpoint, stable idempotency key, and returns only safe classifications", async () => {
  const oldFetch = globalThis.fetch;
  let received;
  globalThis.fetch = async (input, init) => {
    received = { url: String(input), init };
    return Response.json({ id: "email_test_abc123" }, { status: 200 });
  };
  try {
    const result = await sendOrderPaidEmail(order, config);
    assert.deepEqual(result, { ok: true, emailId: "email_test_abc123" });
    assert.equal(received.url, "https://api.resend.com/emails");
    assert.equal(received.init.redirect, "error");
    assert.equal(new Headers(received.init.headers).get("Idempotency-Key"), `amuhon/order-paid/${order.id}`);
    assert.equal(new Headers(received.init.headers).get("Authorization"), `Bearer ${config.apiKey}`);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Resend failures expose no provider response detail", async () => {
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ secret: "provider detail" }, { status: 503 });
    assert.deepEqual(await sendOrderPaidEmail(order, config), { ok: false, errorCode: "resend_retryable_failure" });
    globalThis.fetch = async () => Response.json({ secret: "provider detail" }, { status: 401 });
    assert.deepEqual(await sendOrderPaidEmail(order, config), { ok: false, errorCode: "resend_rejected" });
    globalThis.fetch = async () => { throw new Error("secret network detail"); };
    assert.deepEqual(await sendOrderPaidEmail(order, config), { ok: false, errorCode: "resend_outcome_unknown" });
  } finally {
    globalThis.fetch = oldFetch;
  }
});
