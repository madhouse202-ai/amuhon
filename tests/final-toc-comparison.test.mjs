import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { calculateWorkStartPages } from "../lib/book-layout.ts";
import {
  FOUR_WORK_TOC_PREVIEW_BODY_PAGE_COUNTS,
  FOUR_WORK_TOC_PREVIEW_WORKS,
  TOC_PREVIEW_STRESS_BODY_PAGE_COUNTS,
  TOC_PREVIEW_STRESS_WORKS,
  calculateRefinedTocLayout,
  calculateShiftedVerticalTocLayout,
  calculateTocPreviewPair,
  calculateVerticalTocLayout,
  estimateShiftedVerticalTocEntryWidthMm,
  estimateRefinedTocEntryHeightMm,
  estimateVerticalTocEntryWidthMm,
  getShiftedVerticalTocTextGeometry,
} from "../lib/final-toc-preview.ts";

test("four familiar work labels retain order and A/B/C/D previews calculate sample start pages", () => {
  const pair = calculateTocPreviewPair(FOUR_WORK_TOC_PREVIEW_WORKS, [...FOUR_WORK_TOC_PREVIEW_BODY_PAGE_COUNTS]);
  assert.deepEqual(FOUR_WORK_TOC_PREVIEW_WORKS.map(({ title }) => title), [
    "注文の多い料理店", "蜜柑", "走れメロス", "山月記",
  ]);
  assert.deepEqual(pair.current.pages.flat().map(({ workIndex }) => workIndex), [0, 1, 2, 3]);
  assert.deepEqual(pair.refined.pages.flat().map(({ workIndex }) => workIndex), [0, 1, 2, 3]);
  assert.deepEqual(pair.vertical.pages.flat().map(({ workIndex }) => workIndex), [0, 1, 2, 3]);
  assert.deepEqual(pair.vertical40.pages.flat().map(({ workIndex }) => workIndex), [0, 1, 2, 3]);
  assert.deepEqual(pair.vertical45.pages.flat().map(({ workIndex }) => workIndex), [0, 1, 2, 3]);
  assert.deepEqual(pair.current.pageNumbers, pair.refined.pageNumbers);
  assert.deepEqual(pair.current.pageNumbers, pair.vertical.pageNumbers);
  assert.deepEqual(pair.vertical.pageNumbers, pair.vertical40.pageNumbers);
  assert.deepEqual(pair.vertical40.pageNumbers, pair.vertical45.pageNumbers);
  assert.deepEqual(pair.refined.pageNumbers, [3, 24, 26, 46]);
  assert.equal(pair.vertical.pages.length, 1, "four vertical entries should leave generous space on one A6 TOC page");
  assert.equal(pair.vertical40.pages.length, 1);
  assert.equal(pair.vertical45.pages.length, 1);
  assert.equal(pair.refined.colophonPageNumber, 61);
});

test("refined TOC recalculates page starts after multi-page pagination stabilizes", () => {
  const bodyCounts = [...TOC_PREVIEW_STRESS_BODY_PAGE_COUNTS];
  const layout = calculateRefinedTocLayout(TOC_PREVIEW_STRESS_WORKS, bodyCounts);
  const verticalLayout = calculateVerticalTocLayout(TOC_PREVIEW_STRESS_WORKS, bodyCounts);
  assert.ok(layout.pages.length > 1);
  assert.ok(verticalLayout.pages.length > 1);
  assert.ok(layout.pageNumbers.some((pageNumber) => pageNumber >= 100));
  assert.ok(verticalLayout.pageNumbers.some((pageNumber) => pageNumber >= 100));
  assert.deepEqual(layout.pages.flat().map(({ workIndex }) => workIndex), TOC_PREVIEW_STRESS_WORKS.map((_work, index) => index));
  assert.deepEqual(
    layout.pageNumbers,
    calculateWorkStartPages(bodyCounts, layout.pages.length).workStartPages,
  );
  assert.deepEqual(
    verticalLayout.pageNumbers,
    calculateWorkStartPages(bodyCounts, verticalLayout.pages.length).workStartPages,
  );
  assert.notDeepEqual(verticalLayout.pageNumbers, layout.pageNumbers, "a different TOC page count must shift subsequent work starts");
  const d40Layout = calculateShiftedVerticalTocLayout(TOC_PREVIEW_STRESS_WORKS, bodyCounts, 0.4);
  const d45Layout = calculateShiftedVerticalTocLayout(TOC_PREVIEW_STRESS_WORKS, bodyCounts, 0.45);
  assert.ok(d40Layout.pages.length >= verticalLayout.pages.length);
  assert.ok(d45Layout.pages.length >= d40Layout.pages.length);
  assert.deepEqual(d40Layout.pageNumbers, calculateWorkStartPages(bodyCounts, d40Layout.pages.length).workStartPages);
  assert.deepEqual(d45Layout.pageNumbers, calculateWorkStartPages(bodyCounts, d45Layout.pages.length).workStartPages);
  assert.ok(layout.pages.every((entries) => entries.length > 0));
  assert.ok(verticalLayout.pages.every((entries) => entries.length > 0));
  for (const entries of layout.pages) {
    const estimatedHeight = entries.reduce((sum, { workIndex }) => sum + estimateRefinedTocEntryHeightMm(TOC_PREVIEW_STRESS_WORKS[workIndex]), 0) +
      Math.max(0, entries.length - 1) * 3;
    assert.ok(estimatedHeight <= 88 + 0.001);
  }
  for (const page of verticalLayout.pages) {
    const estimatedWidth = page.reduce((sum, { workIndex }) => sum + estimateVerticalTocEntryWidthMm(TOC_PREVIEW_STRESS_WORKS[workIndex]), 0) +
      Math.max(0, page.length - 1) * 3;
    assert.ok(estimatedWidth <= 81 + 0.001);
  }
});

test("long title/author pairs receive taller rows than short entries", () => {
  const short = estimateRefinedTocEntryHeightMm({ id: "short", title: "蜜柑", author: "芥川龍之介" });
  const long = estimateRefinedTocEntryHeightMm({
    id: "long",
    title: "目次組版を確認するための長い作品名・題名の折り返し位置を検証",
    author: "著者名の表示幅も確認するための長い名前",
  });
  assert.ok(long > short);
  assert.ok(long < 88);
  const shortVertical = estimateVerticalTocEntryWidthMm({ id: "short", title: "蜜柑", author: "芥川龍之介" });
  const longVertical = estimateVerticalTocEntryWidthMm({
    id: "long",
    title: "目次組版を確認するための長い作品名・題名の折り返し位置を検証",
    author: "著者名の表示幅も確認するための長い名前",
  });
  assert.ok(longVertical > shortVertical, "long vertical labels should reserve additional columns");
});

test("D40 and D45 align title tops at fixed page ratios and reserve the lower margin", () => {
  const d40 = getShiftedVerticalTocTextGeometry(0.4);
  const d45 = getShiftedVerticalTocTextGeometry(0.45);
  assert.ok(Math.abs(d40.titleStartMm - 59.2) < 0.001);
  assert.ok(Math.abs(d45.titleStartMm - 66.6) < 0.001);
  assert.equal(d40.textBottomMm, 127);
  assert.equal(d45.textBottomMm, 127);
  assert.ok(d45.textHeightMm < d40.textHeightMm);
  assert.ok(d45.titleCharsPerColumn < d40.titleCharsPerColumn);
  assert.throws(() => getShiftedVerticalTocTextGeometry(0.42));

  const work = TOC_PREVIEW_STRESS_WORKS[0];
  assert.ok(estimateShiftedVerticalTocEntryWidthMm(work, 0.45) >= estimateShiftedVerticalTocEntryWidthMm(work, 0.4));
  const d45Layout = calculateShiftedVerticalTocLayout(TOC_PREVIEW_STRESS_WORKS, [...TOC_PREVIEW_STRESS_BODY_PAGE_COUNTS], 0.45);
  assert.deepEqual(
    d45Layout.pageNumbers,
    calculateWorkStartPages([...TOC_PREVIEW_STRESS_BODY_PAGE_COUNTS], d45Layout.pages.length).workStartPages,
  );
  assert.deepEqual(d45Layout.pages.flat().map(({ workIndex }) => workIndex), TOC_PREVIEW_STRESS_WORKS.map((_entry, index) => index));
});

test("comparison runner keeps the experiment outside production TOC/PDF files and uses fixed A6 output", async () => {
  const script = await readFile(new URL("../scripts/compare-final-toc-layout.mjs", import.meta.url), "utf8");
  const tocPage = await readFile(new URL("../app/final/page.tsx", import.meta.url), "utf8");
  const layout = await readFile(new URL("../lib/book-layout.ts", import.meta.url), "utf8");
  const orderPdfRoute = await readFile(new URL("../app/api/dev/order-pdf/route.ts", import.meta.url), "utf8");
  const previewPdfRoute = await readFile(new URL("../app/api/dev/final-preview-pdf/route.ts", import.meta.url), "utf8");
  const pdfRenderer = await readFile(new URL("../lib/local-final-pdf.ts", import.meta.url), "utf8");

  assert.match(script, /@page \{ size: \$\{FINAL_TOC_PREVIEW_PAGE_WIDTH_MM\}mm \$\{FINAL_TOC_PREVIEW_PAGE_HEIGHT_MM\}mm; margin: 0; \}/);
  assert.match(script, /preferCSSPageSize: true/);
  assert.match(script, /printBackground: true/);
  assert.match(script, /writing-mode: horizontal-tb/);
  assert.match(script, /\.vertical-main .*writing-mode: vertical-rl/);
  assert.match(script, /\.c-list .*writing-mode: vertical-rl/);
  assert.match(script, /text-combine-upright: all/);
  assert.match(script, /four-works-A-B-C-A6\.pdf/);
  assert.match(script, /pagination-stress-A-B-C-A6\.pdf/);
  assert.match(script, /four-works-C-D40-D45-A6\.pdf/);
  assert.match(script, /four-works-C-D40-D45\.png/);
  assert.match(script, /pagination-stress-C-D40-D45-A6\.pdf/);
  assert.match(script, /data-title-start-ratio/);
  assert.match(script, /title tops are not aligned/);
  assert.match(script, /author top does not align with title/);
  assert.match(script, /FINAL_TOC_VERTICAL_PAGE_NUMBER_TOP_MM/);
  assert.match(script, /FINAL_TOC_VERTICAL_BOTTOM_MARGIN_MM/);
  assert.match(script, /titleAuthorNumberOverlap, false/);
  assert.match(script, /right-to-left/);
  assert.match(script, /white-space: nowrap/);
  assert.match(script, /font-variant-numeric: tabular-nums/);
  assert.match(script, /data-start-page/);
  assert.doesNotMatch(script, /fetch\(|https?:\/\//);
  assert.match(script, /await page\.emulateMedia\(\{ media: "print" \}\)/);
  assert.match(script, /measuredHeightMm > 8/);
  assert.match(script, /pageNumberWidthMm <= 14\.1/);
  assert.match(script, /pageNumberOverflow, false/);
  assert.match(script, /verticalStressMetrics/);
  assert.match(script, /numberTextCombine, "all"/);
  assert.match(script, /titleColumnsOverflow, false/);
  assert.match(tocPage, /calculateTocLayout\(works, workPageData\.map\(\(item\) => item\.pages\.length\)\)/);
  assert.match(tocPage, /<TableOfContents/);
  assert.match(tocPage, /flexDirection: "row-reverse"/);
  assert.match(tocPage, /padding: "12mm"/);
  assert.match(tocPage, /fontSize: "8\.5pt"/);
  assert.match(tocPage, /lineHeight: 1\.6/);
  assert.match(tocPage, /height: "124mm"/);
  assert.match(tocPage, /fontSize: "7\.5pt"/);
  assert.match(script, /\.legacy-toc \{[^}]*flex-direction: row-reverse;[^}]*padding: 12mm/);
  assert.match(script, /\.legacy-entry \{[^}]*height: 124mm;[^}]*font-size: 8\.5pt;[^}]*line-height: 1\.6/);
  assert.match(script, /\.legacy-page-number \{ font-size: 7\.5pt; color: #a15b46; \}/);
  assert.match(layout, /calculateWorkStartPages/);
  assert.match(layout, /paginateTocEntries/);
  assert.match(orderPdfRoute, /renderLocalFinalBodyPdf\(input\.book, input\.bodyPdfPageCount\)/);
  assert.match(previewPdfRoute, /renderLocalFinalBodyPdf\(input\.book, input\.bodyPdfPageCount/);
  assert.match(pdfRenderer, /page\.goto\(rendererConfig\.renderUrl/);
});
