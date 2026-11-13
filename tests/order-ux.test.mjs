import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the final review presents the actual composition, cover, pages, and a guarded order action", async () => {
  const finalPage = await source("../app/final/page.tsx");

  assert.match(finalPage, /本の完成を確認/);
  assert.match(finalPage, /actualWorkBodyPageCount/);
  assert.match(finalPage, /submissionPageCount/);
  assert.match(finalPage, /収録作品（この順番）/);
  assert.match(finalPage, /表紙を確認・変更/);
  assert.match(finalPage, /注文内容を確認して進む/);
  assert.match(finalPage, /onClick=\{openOrder\} disabled=\{isPrinting \|\| !submissionPageCountValid\}/);
  assert.match(finalPage, /if \(!canPrint \|\| !data \|\| !submissionPageCountValid\) return/);
  assert.match(finalPage, /印刷用データを保存（任意）/);
  assert.match(finalPage, /開発者向け：本文書体の検証/);
});

test("order review returns to final and shows server-confirmed price without persisting customer fields", async () => {
  const [orderPage, createPage, coverPage] = await Promise.all([
    source("../app/order/page.tsx"),
    source("../app/create/page.tsx"),
    source("../app/cover/page.tsx"),
  ]);

  assert.match(orderPage, /href="\/final"[^>]*>完成した本の確認に戻る/);
  assert.match(orderPage, /ORDER_FLOW_STEPS = \["本の確認", "配送先", "価格確定", "決済"\]/);
  assert.match(orderPage, /価格：\{priceLabel\}/);
  assert.match(orderPage, /checkoutSummary\?\.filesVerified && Number\.isSafeInteger\(checkoutSummary\.quotedAmountYen\)/);
  assert.match(orderPage, /確認中（ファイル検証後にサーバーで確定）/);
  assert.match(orderPage, /checkoutSummary\?\.canCheckout/);
  assert.match(orderPage, /api\/orders\/\$\{encodeURIComponent\(draft\.id\)\}\/checkout/);
  assert.doesNotMatch(orderPage, /localStorage\.(?:setItem|getItem)\([^)]*customer/i);
  assert.match(orderPage, /入力中の配送先情報はブラウザーへ保存しません/);
  assert.match(createPage, /if \(!flushDraft\(\{ \.\.\.draft, works: selectedWorks \}\)\) return;\s*router\.push\("\/cover"\)/);
  assert.match(coverPage, /if \(!flushDraft\(normalizedDraft\)\) return false/);
  assert.match(coverPage, /function handleSave\(\) \{\s*if \(!saveCoverSettings\(\)\) return;[\s\S]*?router\.push\("\/final"\)/);
  assert.match(orderPage, /const currentBook = loadBookData\(\)/);
});

test("the review and order steps remain usable on narrow screens", async () => {
  const [finalPage, orderPage] = await Promise.all([
    source("../app/final/page.tsx"),
    source("../app/order/page.tsx"),
  ]);

  assert.match(finalPage, /w-full break-words rounded-xl[\s\S]*注文内容を確認して進む/);
  assert.match(finalPage, /sm:grid-cols-\[minmax\(0,1fr\)_auto\]/);
  assert.match(orderPage, /grid grid-cols-4 gap-1\.5[\s\S]*sm:text-sm/);
  assert.match(orderPage, /min-h-12 w-full[\s\S]*sm:w-auto/);
  assert.match(orderPage, /break-words/);
});
