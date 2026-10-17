import assert from "node:assert/strict";
import test from "node:test";
import {
  canTransitionOrderStatus,
  isReadyForPayment,
  validateOrderCustomer,
} from "../lib/order.ts";

const validCustomer = {
  name: "山田 花子",
  postalCode: "1000001",
  prefecture: "東京都",
  city: "千代田区千代田",
  address: "1-1",
  phone: "03-1234-5678",
  email: "reader@example.jp",
};

test("server customer validation normalizes postal code and phone", () => {
  const result = validateOrderCustomer(validCustomer);
  assert.deepEqual(result.errors, {});
  assert.equal(result.customer.postalCode, "100-0001");
  assert.equal(result.customer.phone, "0312345678");
});

test("required contact fields and formats are rejected", () => {
  const result = validateOrderCustomer({ ...validCustomer, name: "", postalCode: "12", prefecture: "東京", phone: "123", email: "bad" });
  assert.equal(result.customer, null);
  for (const field of ["name", "postalCode", "prefecture", "phone", "email"]) assert.ok(result.errors[field]);
});

test("order state transitions are constrained", () => {
  assert.equal(canTransitionOrderStatus("draft", "preparing"), true);
  assert.equal(canTransitionOrderStatus("preparing", "ready_for_payment"), true);
  assert.equal(canTransitionOrderStatus("draft", "paid"), false);
  assert.equal(canTransitionOrderStatus("paid", "draft"), false);
});

test("draft or incomplete assets cannot be payment-ready", () => {
  const draft = {
    status: "draft",
    bodyPdfPageCount: null,
    bodyPdfStoragePath: null,
    coverPngStoragePath: null,
    amountMinor: null,
    currency: null,
    filesValidatedAt: null,
  };
  assert.equal(isReadyForPayment(draft), false);
  assert.equal(isReadyForPayment({
    ...draft,
    status: "ready_for_payment",
    bodyPdfPageCount: 104,
    bodyPdfStoragePath: "order/body.pdf",
    coverPngStoragePath: "order/cover.png",
    amountMinor: 1000,
    currency: "JPY",
    filesValidatedAt: new Date().toISOString(),
  }), true);
  assert.equal(isReadyForPayment({
    ...draft,
    status: "ready_for_payment",
    bodyPdfPageCount: 104,
    amountMinor: 1000,
    currency: "JPY",
  }), false);
});
