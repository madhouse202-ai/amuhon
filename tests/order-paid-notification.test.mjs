import assert from "node:assert/strict";
import test from "node:test";
import {
  createOrderPaidEmailPayload,
  createCustomerOrderEmailPayload,
  isValidOrderPaidNotificationOrder,
  isValidCustomerOrderNotificationOrder,
  resolveOrderPaidNotificationConfig,
  resolveCustomerOrderNotificationConfig,
  sendOrderPaidEmail,
  sendCustomerOrderEmail,
} from "../lib/order-paid-notification.ts";

const order = {
  id: "d9d71ea0-115c-4b26-8c1d-86bead2aecc4",
  orderNumber: "AMU-20261123-D9D71EA0",
  title: "『<script>alert(1)</script>』",
  pageCount: 72,
  amountYen: 1980,
};
const config = { apiKey: "re_test_only_mock_key_12345678", appOrigin: "https://amuhon.jp" };
const customerOrder = {
  id: order.id,
  orderNumber: order.orderNumber,
  title: "『<短編集>』",
  amountYen: 1980,
  recipientEmail: "tester@example.net",
};

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

test("customer notifications require an explicit environment mode and staging project binding", () => {
  const base = { RESEND_API_KEY: config.apiKey, NODE_ENV: "production" };
  assert.equal(resolveCustomerOrderNotificationConfig(base), null);
  assert.equal(resolveCustomerOrderNotificationConfig({
    ...base, AMUHON_CUSTOMER_NOTIFICATION_MODE: "staging",
    SUPABASE_URL: "https://other-project.supabase.co",
  }), null);
  assert.deepEqual(resolveCustomerOrderNotificationConfig({
    ...base, AMUHON_CUSTOMER_NOTIFICATION_MODE: "staging",
    SUPABASE_URL: "https://ahxnmkuvdpzctcwcyadl.supabase.co",
    AMUHON_STAGING_CUSTOMER_EMAIL_ALLOWLIST: " Tester@example.net, second@example.net ",
  }), {
    apiKey: config.apiKey, mode: "staging",
    stagingRecipientAllowlist: ["tester@example.net", "second@example.net"],
  });
  assert.equal(resolveCustomerOrderNotificationConfig({
    ...base, AMUHON_CUSTOMER_NOTIFICATION_MODE: "production",
    SUPABASE_URL: "https://ahxnmkuvdpzctcwcyadl.supabase.co",
  }), null);
  assert.equal(resolveCustomerOrderNotificationConfig({
    ...base, AMUHON_CUSTOMER_NOTIFICATION_MODE: "staging",
    SUPABASE_URL: "https://ahxnmkuvdpzctcwcyadl.supabase.co",
    AMUHON_STAGING_CUSTOMER_EMAIL_ALLOWLIST: "bad address",
  }), null);
});

test("customer templates distinguish paid confirmation from first shipment and use stable event keys", () => {
  assert.equal(isValidCustomerOrderNotificationOrder(customerOrder), true);
  assert.equal(isValidCustomerOrderNotificationOrder({ ...customerOrder, recipientEmail: "bad" }), false);
  const confirmation = createCustomerOrderEmailPayload("order_confirmed", customerOrder);
  const shipment = createCustomerOrderEmailPayload("order_shipped", customerOrder);
  assert.deepEqual(confirmation.to, [customerOrder.recipientEmail]);
  assert.match(confirmation.subject, /ご注文 .* を承りました/);
  assert.match(confirmation.text, /注文番号：AMU-/);
  assert.match(confirmation.text, /書名：/);
  assert.match(confirmation.text, /お支払い金額：1,980円/);
  assert.match(confirmation.text, /お問い合わせ先：amuhon\.jp@gmail\.com/);
  assert.match(confirmation.text, /注文番号をお知らせください/);
  assert.match(confirmation.html, /&lt;短編集&gt;/);
  assert.equal(confirmation.idempotencyKey, `amuhon/customer/order_confirmed/${order.id}`);
  assert.equal(shipment.idempotencyKey, `amuhon/customer/order_shipped/${order.id}`);
  assert.match(shipment.text, /発送しました/);
  assert.match(shipment.text, /お問い合わせ先：amuhon\.jp@gmail\.com/);
  assert.doesNotMatch(shipment.text, /1,980円|配達予定|追跡番号/);
});

test("staging refuses non-allowlisted customers before Resend and sends only to an allowlisted recipient", async () => {
  const stagingConfig = {
    apiKey: config.apiKey, mode: "staging", stagingRecipientAllowlist: ["tester@example.net"],
  };
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    assert.deepEqual(JSON.parse(String(init.body)).to, ["tester@example.net"]);
    return Response.json({ id: "email_customer_test_1" }, { status: 200 });
  };
  try {
    assert.deepEqual(await sendCustomerOrderEmail("order_confirmed", {
      ...customerOrder, recipientEmail: "real-customer@example.org",
    }, stagingConfig), { ok: false, errorCode: "customer_recipient_not_allowlisted" });
    assert.equal(calls, 0);
    assert.deepEqual(await sendCustomerOrderEmail("order_shipped", customerOrder, stagingConfig), {
      ok: true, emailId: "email_customer_test_1",
    });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
