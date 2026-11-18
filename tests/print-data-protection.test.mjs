import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isLegacyBuyerAssetFlowEnabled } from "../lib/order-production-gate.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("buyer screens do not expose print downloads and production checkout remains closed", async () => {
  const [finalPage, coverPage, orderPage, orderRoute, checkoutRoute] = await Promise.all([
    read("../app/final/page.tsx"),
    read("../app/cover/page.tsx"),
    read("../app/order/page.tsx"),
    read("../app/api/orders/route.ts"),
    read("../app/api/orders/[id]/checkout/route.ts"),
  ]);

  assert.doesNotMatch(finalPage, /window\.print\(|本文データを保存|表紙データを保存|開発者向け：/);
  assert.match(coverPage, /rendererInternalMode && <button/);
  assert.doesNotMatch(orderPage.slice(orderPage.indexOf("if (!AUTO_FILE_GENERATION_ENABLED)"), orderPage.indexOf("function updateCustomer")), /type="file"/);
  assert.equal(isLegacyBuyerAssetFlowEnabled({ NODE_ENV: "production" }), false);
  assert.equal(isLegacyBuyerAssetFlowEnabled({ NODE_ENV: "development" }), true);
  assert.match(orderRoute, /if \(!isLegacyBuyerAssetFlowEnabled\(\)\)[\s\S]{0,80}return errorResponse/);
  assert.match(checkoutRoute, /if \(!isLegacyBuyerAssetFlowEnabled\(\)\) return fail/);
});

test("local Chromium PDF APIs require the development localhost origin", async () => {
  const [bodyPdf, previewPdf, font] = await Promise.all([
    read("../app/api/dev/order-pdf/route.ts"),
    read("../app/api/dev/final-preview-pdf/route.ts"),
    read("../app/api/dev/final-typography-font/route.ts"),
  ]);
  for (const source of [bodyPdf, previewPdf, font]) {
    assert.match(source, /process\.env\.NODE_ENV !== "development"/);
    assert.match(source, /http:\/\/localhost:3000/);
  }
});
