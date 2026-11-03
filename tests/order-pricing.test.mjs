import assert from "node:assert/strict";
import test from "node:test";
import { quoteOrderPrice } from "../lib/order-pricing.ts";

test("server display quote mirrors the confirmed page bands exactly", () => {
  for (const [pages, amount] of [[24, 1980], [100, 1980], [101, 2280], [150, 2280], [151, 2580], [200, 2580], [201, 2880], [250, 2880], [251, 3180], [300, 3180]]) {
    assert.deepEqual(quoteOrderPrice(pages), { pageCount: pages, amountYen: amount, currency: "JPY" });
  }
  for (const pages of [0, 23, 301, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) assert.equal(quoteOrderPrice(pages), null);
});
