import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { PDFDocument } from "pdf-lib";

import { findFinalPdfChromiumExecutable } from "../lib/local-final-pdf.ts";
import { resolveFinalPdfRendererConfig } from "../lib/final-pdf-renderer-config.ts";
import {
  FOUR_WORK_TOC_PREVIEW_BODY_PAGE_COUNTS,
  FOUR_WORK_TOC_PREVIEW_WORKS,
  FINAL_TOC_PREVIEW_ENTRY_GAP_MM,
  FINAL_TOC_PREVIEW_LIST_HEIGHT_MM,
  FINAL_TOC_PREVIEW_PAGE_HEIGHT_MM,
  FINAL_TOC_PREVIEW_PAGE_WIDTH_MM,
  FINAL_TOC_VERTICAL_AUTHOR_CHARS_PER_COLUMN,
  FINAL_TOC_VERTICAL_AUTHOR_COLUMN_WIDTH_MM,
  FINAL_TOC_VERTICAL_BOTTOM_MARGIN_MM,
  FINAL_TOC_VERTICAL_COLUMN_GAP_MM,
  FINAL_TOC_VERTICAL_LIST_TOP_MM,
  FINAL_TOC_VERTICAL_NUMBER_COLUMN_WIDTH_MM,
  FINAL_TOC_VERTICAL_PAGE_NUMBER_TOP_MM,
  FINAL_TOC_VERTICAL_TITLE_CHARS_PER_COLUMN,
  FINAL_TOC_VERTICAL_TITLE_COLUMN_WIDTH_MM,
  FINAL_TOC_SHIFT_RATIOS,
  TOC_PREVIEW_STRESS_BODY_PAGE_COUNTS,
  TOC_PREVIEW_STRESS_WORKS,
  calculateTocPreviewPair,
  estimateShiftedVerticalTocEntryWidthMm,
  estimateRefinedTocEntryHeightMm,
  estimateVerticalTocEntryWidthMm,
  getShiftedVerticalTocTextGeometry,
} from "../lib/final-toc-preview.ts";

if (process.env.NODE_ENV === "production") {
  throw new Error("TOC comparison is available only outside production.");
}
if (process.argv.length !== 2) {
  throw new Error("This fixed local comparison accepts no arguments or external work data.");
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(scriptDirectory, "../tmp/final-toc-comparison");
const A6_WIDTH_PT = FINAL_TOC_PREVIEW_PAGE_WIDTH_MM / 25.4 * 72;
const A6_HEIGHT_PT = FINAL_TOC_PREVIEW_PAGE_HEIGHT_MM / 25.4 * 72;
const A6_TOLERANCE_PT = 1.5;

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function renderCurrentPage(works, entries, pageIndex, pageCount) {
  const items = entries.map(({ workIndex, pageNumber }) => {
    const work = works[workIndex];
    const author = work.author?.trim() ? `　${escapeHtml(work.author.trim())}` : "";
    return `<div class="legacy-entry" data-work-index="${workIndex}" data-start-page="${pageNumber}">
      <span class="legacy-title-author">${escapeHtml(work.title)}${author}　</span>
      <span class="legacy-page-number">${pageNumber}</span>
    </div>`;
  }).join("");
  return `<section class="sheet legacy-sheet" data-page="${pageIndex + 1}" data-page-count="${pageCount}" data-label="A｜現行">
    <div class="legacy-toc"><div class="legacy-entry-group">${items}</div></div>
  </section>`;
}

function renderRefinedPage(works, entries, pageIndex, pageCount) {
  const items = entries.map(({ workIndex, pageNumber }) => {
    const work = works[workIndex];
    return `<li class="refined-entry" data-work-index="${workIndex}" data-start-page="${pageNumber}"
      data-estimated-height-mm="${estimateRefinedTocEntryHeightMm(work)}">
      <div class="refined-work-copy">
        <div class="refined-title">${escapeHtml(work.title)}</div>
        ${work.author?.trim() ? `<div class="refined-author">${escapeHtml(work.author.trim())}</div>` : ""}
      </div>
      <div class="refined-page-number" aria-label="${pageNumber}ページ">
        <span>${pageNumber}</span><small>頁</small>
      </div>
    </li>`;
  }).join("");

  return `<section class="sheet refined-sheet" data-page="${pageIndex + 1}" data-page-count="${pageCount}" data-label="B｜改善案">
    <main class="refined-main">
      <header class="refined-heading"><h1>目次</h1><div class="refined-rule"></div></header>
      <ol class="refined-list">${items}</ol>
    </main>
  </section>`;
}

function splitVerticalText(value, capacity) {
  const characters = Array.from(value);
  const columns = [];
  for (let index = 0; index < characters.length; index += capacity) {
    columns.push(characters.slice(index, index + capacity).join(""));
  }
  return columns.length ? columns : [""];
}

function renderVerticalPage(works, entries, pageIndex, pageCount, variant = "C") {
  const isShifted = variant !== "C";
  const geometry = isShifted ? getShiftedVerticalTocTextGeometry(variant === "D40" ? 0.4 : 0.45) : null;
  const titleCapacity = geometry?.titleCharsPerColumn ?? FINAL_TOC_VERTICAL_TITLE_CHARS_PER_COLUMN;
  const authorCapacity = geometry?.authorCharsPerColumn ?? FINAL_TOC_VERTICAL_AUTHOR_CHARS_PER_COLUMN;
  const topOffsetMm = geometry ? geometry.titleStartMm - FINAL_TOC_VERTICAL_LIST_TOP_MM : 0;
  const widthFor = (work) => geometry
    ? estimateShiftedVerticalTocEntryWidthMm(work, geometry.startRatio)
    : estimateVerticalTocEntryWidthMm(work);
  const sheetClass = isShifted ? `vertical-sheet shifted-vertical-sheet ${variant.toLowerCase()}-sheet` : "vertical-sheet";
  const label = isShifted ? `D｜${Math.round(geometry.startRatio * 100)}%下方` : "C｜現行縦書き";
  const items = entries.map(({ workIndex, pageNumber }) => {
    const work = works[workIndex];
    const titleColumns = splitVerticalText(work.title.trim(), titleCapacity)
      .map((column) => `<span class="c-title-column">${escapeHtml(column)}</span>`).join("");
    const authorColumns = work.author?.trim()
      ? splitVerticalText(work.author.trim(), authorCapacity)
        .map((column) => `<span class="c-author-column">${escapeHtml(column)}</span>`).join("")
      : "";
    const divider = `<span class="c-entry-divider" aria-hidden="true"></span>`;
    const authorDivider = authorColumns ? `<span class="c-entry-divider" aria-hidden="true"></span>` : "";
    return `<li class="c-entry" data-work-index="${workIndex}" data-start-page="${pageNumber}"
      data-estimated-width-mm="${widthFor(work)}">
      ${titleColumns}${divider}${authorColumns}${authorDivider}
      <span class="c-number-column"><span class="c-page-reference">
        <span class="c-page-number">${pageNumber}</span><small class="c-page-label">頁</small>
      </span></span>
    </li>`;
  }).join("");

  const geometryStyle = geometry
    ? `style="--shifted-text-top:${topOffsetMm}mm;--shifted-text-height:${geometry.textHeightMm}mm"`
    : "";
  return `<section class="sheet ${sheetClass}" data-page="${pageIndex + 1}" data-page-count="${pageCount}" data-label="${label}"
    data-title-start-ratio="${geometry?.startRatio ?? ""}" ${geometryStyle}>
    <main class="vertical-main">
      <header class="vertical-heading"><h1>目次</h1><span class="vertical-heading-rule" aria-hidden="true"></span></header>
      <ol class="c-list">${items}</ol>
    </main>
  </section>`;
}

const css = `
  @page { size: ${FINAL_TOC_PREVIEW_PAGE_WIDTH_MM}mm ${FINAL_TOC_PREVIEW_PAGE_HEIGHT_MM}mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { color: #3f3a32; font-family: serif; }
  .sheet { position: relative; width: ${FINAL_TOC_PREVIEW_PAGE_WIDTH_MM}mm; height: ${FINAL_TOC_PREVIEW_PAGE_HEIGHT_MM}mm; overflow: hidden; background: #f8f3df; }
  .screen-preview { display: grid; grid-template-columns: repeat(3, ${FINAL_TOC_PREVIEW_PAGE_WIDTH_MM}mm); gap: 8mm; width: max-content; margin: 0 auto; padding: 10mm; background: #dedbd2; }
  .preview-sheet { box-shadow: 0 1mm 4mm rgb(40 34 25 / 20%); }
  .preview-sheet::before { content: attr(data-label); position: absolute; z-index: 2; top: 3mm; left: 3mm; padding: 1mm 2mm; background: rgb(248 243 223 / 90%); color: #62594c; font: 6.5pt Arial, sans-serif; }
  .pdf-pages { display: none; }

  /* A: mirrors the existing /final TableOfContents CSS and flow. */
  .legacy-toc { position: absolute; inset: 0; display: flex; flex-direction: row-reverse; align-items: center; justify-content: center; gap: 3mm; writing-mode: vertical-rl; text-orientation: upright; font-family: serif; box-sizing: border-box; padding: 12mm; }
  .legacy-entry-group { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3mm; flex-shrink: 0; }
  .legacy-entry { height: 124mm; flex: 0 0 auto; overflow-wrap: anywhere; white-space: normal; font-size: 8.5pt; line-height: 1.6; writing-mode: vertical-rl; text-orientation: upright; }
  .legacy-title-author { }
  .legacy-page-number { font-size: 7.5pt; color: #a15b46; }

  /* B: horizontal rows make each title/author pair and its page number explicit. */
  .refined-main { position: absolute; inset: 0 12mm 0; }
  .refined-heading { position: absolute; top: 21mm; left: 0; right: 0; text-align: center; }
  .refined-heading h1 { margin: 0; color: #51483d; font-size: 11pt; font-weight: 500; letter-spacing: .16em; }
  .refined-rule { width: 9mm; margin: 3mm auto 0; border-top: .3mm solid #a9987a; }
  .refined-list { position: absolute; top: 42mm; bottom: 24mm; left: 0; right: 0; display: flex; flex-direction: column; justify-content: center; gap: 3mm; margin: 0; padding: 0; list-style: none; }
  .refined-entry { display: grid; grid-template-columns: minmax(0, 1fr) 14mm; column-gap: 3mm; align-items: center; min-height: 11.5mm; flex: 0 0 auto; padding: 1.6mm 0; border-bottom: .2mm solid #d8cfbe; }
  .refined-work-copy { min-width: 0; }
  .refined-title { color: #3f3a32; font-size: 9pt; line-height: 1.25; overflow-wrap: anywhere; }
  .refined-author { margin-top: 1mm; color: #7b7163; font-size: 7.2pt; line-height: 1.25; overflow-wrap: anywhere; }
  .refined-page-number { display: flex; justify-content: flex-end; align-items: baseline; gap: 1mm; color: #8c523e; font-size: 9pt; font-variant-numeric: tabular-nums; white-space: nowrap; writing-mode: horizontal-tb; text-align: right; }
  .refined-page-number span { display: inline-block; min-width: 7mm; white-space: nowrap; }
  .refined-page-number small { color: #897f70; font-size: 6.5pt; }

  /* C: vertical Japanese groups flow from right to left; title, author, and page stay in one group. */
  .vertical-main { position: absolute; inset: 0; color: #3f3a32; writing-mode: vertical-rl; text-orientation: upright; }
  .vertical-heading { position: absolute; top: 19mm; right: 17mm; display: flex; flex-direction: row; align-items: center; gap: 2.5mm; writing-mode: vertical-rl; text-orientation: upright; }
  .vertical-heading h1 { margin: 0; color: #51483d; font-size: 11pt; font-weight: 500; letter-spacing: .12em; }
  .vertical-heading-rule { display: inline-block; height: 8mm; border-left: .3mm solid #a9987a; }
  .c-list { position: absolute; top: ${FINAL_TOC_VERTICAL_LIST_TOP_MM}mm; bottom: ${FINAL_TOC_VERTICAL_BOTTOM_MARGIN_MM}mm; left: 12mm; right: 12mm; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${FINAL_TOC_PREVIEW_ENTRY_GAP_MM}mm; margin: 0; padding: 0; list-style: none; writing-mode: vertical-rl; text-orientation: upright; }
  .c-entry { position: relative; display: flex; flex-direction: column; align-items: center; flex: 0 0 auto; height: ${FINAL_TOC_PREVIEW_LIST_HEIGHT_MM}mm; margin: 0; padding: 0; writing-mode: vertical-rl; text-orientation: upright; }
  .c-title-column { display: inline-block; flex: 0 0 ${FINAL_TOC_VERTICAL_TITLE_COLUMN_WIDTH_MM}mm; width: ${FINAL_TOC_VERTICAL_TITLE_COLUMN_WIDTH_MM}mm; height: ${FINAL_TOC_PREVIEW_LIST_HEIGHT_MM}mm; overflow: hidden; color: #3f3a32; font-size: 8.5pt; line-height: 1.45; white-space: nowrap; writing-mode: vertical-rl; text-orientation: upright; }
  .c-author-column { display: inline-block; flex: 0 0 ${FINAL_TOC_VERTICAL_AUTHOR_COLUMN_WIDTH_MM}mm; width: ${FINAL_TOC_VERTICAL_AUTHOR_COLUMN_WIDTH_MM}mm; height: ${FINAL_TOC_PREVIEW_LIST_HEIGHT_MM}mm; overflow: hidden; color: #7b7163; font-size: 7pt; line-height: 1.35; white-space: nowrap; writing-mode: vertical-rl; text-orientation: upright; }
  .c-entry-divider { display: inline-block; flex: 0 0 ${FINAL_TOC_VERTICAL_COLUMN_GAP_MM}mm; width: ${FINAL_TOC_VERTICAL_COLUMN_GAP_MM}mm; height: 12mm; border-left: .2mm solid #d8cfbe; }
  .c-number-column { position: relative; display: inline-block; flex: 0 0 ${FINAL_TOC_VERTICAL_NUMBER_COLUMN_WIDTH_MM}mm; width: ${FINAL_TOC_VERTICAL_NUMBER_COLUMN_WIDTH_MM}mm; height: ${FINAL_TOC_PREVIEW_LIST_HEIGHT_MM}mm; }
  .c-page-reference { position: absolute; top: ${FINAL_TOC_VERTICAL_PAGE_NUMBER_TOP_MM - FINAL_TOC_VERTICAL_LIST_TOP_MM}mm; left: 0; display: flex; flex-direction: row; align-items: center; justify-content: flex-start; gap: 1mm; width: ${FINAL_TOC_VERTICAL_NUMBER_COLUMN_WIDTH_MM}mm; height: 14mm; color: #8c523e; font-size: 7.2pt; white-space: nowrap; writing-mode: vertical-rl; text-orientation: upright; }
  .c-page-number { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; inline-size: 6mm; block-size: ${FINAL_TOC_VERTICAL_NUMBER_COLUMN_WIDTH_MM}mm; border: .2mm solid #a9987a; border-radius: 1.5mm; color: #8c523e; font-size: 7.2pt; font-variant-numeric: tabular-nums; line-height: 1; text-combine-upright: all; writing-mode: vertical-rl; text-orientation: mixed; }
  .c-page-label { color: #897f70; font-size: 6.2pt; writing-mode: vertical-rl; text-orientation: upright; }
  .shifted-vertical-sheet .c-entry { align-items: flex-start; }
  .shifted-vertical-sheet .c-title-column, .shifted-vertical-sheet .c-author-column { position: relative; top: var(--shifted-text-top); height: var(--shifted-text-height); }
  .shifted-vertical-sheet .c-entry-divider { position: relative; top: var(--shifted-text-top); }

  @media print {
    html, body { width: ${FINAL_TOC_PREVIEW_PAGE_WIDTH_MM}mm; margin: 0; padding: 0; background: #fff; }
  .screen-preview { display: none; }
    .pdf-pages { display: block; }
    #stress-pdf-pages { display: none !important; }
    #four-work-d-pdf-pages, #stress-d-pdf-pages { display: none !important; }
    .pdf-pages .sheet { break-after: page; page-break-after: always; }
    .pdf-pages .sheet:last-child { break-after: auto; page-break-after: auto; }
  }
`;

function renderPages(works, layout, renderPage) {
  return layout.pages.map((entries, index) => renderPage(works, entries, index, layout.pages.length)).join("\n");
}

function renderDPage(works, entries, pageIndex, pageCount, ratio) {
  return renderVerticalPage(works, entries, pageIndex, pageCount, ratio === 0.4 ? "D40" : "D45");
}

function documentHtml(previewWorks, previewPair, stressWorks, stressPair, includeScreenPreview) {
  const screenPreview = includeScreenPreview
    ? `<div id="screen-preview" class="screen-preview">
        ${renderCurrentPage(previewWorks, previewPair.current.pages[0], 0, previewPair.current.pages.length).replace("class=\"sheet ", "class=\"sheet preview-sheet ")}
        ${renderRefinedPage(previewWorks, previewPair.refined.pages[0], 0, previewPair.refined.pages.length).replace("class=\"sheet ", "class=\"sheet preview-sheet ")}
        ${renderVerticalPage(previewWorks, previewPair.vertical.pages[0], 0, previewPair.vertical.pages.length).replace("class=\"sheet ", "class=\"sheet preview-sheet ")}
      </div>`
    : "";

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${css}</style></head><body>
    ${screenPreview}
    <div class="pdf-pages" id="pdf-pages">
      ${renderPages(previewWorks, previewPair.current, renderCurrentPage)}
      ${renderPages(previewWorks, previewPair.refined, renderRefinedPage)}
      ${renderPages(previewWorks, previewPair.vertical, renderVerticalPage)}
    </div>
    <div class="pdf-pages" id="stress-pdf-pages">
      ${renderPages(stressWorks, stressPair.current, renderCurrentPage)}
      ${renderPages(stressWorks, stressPair.refined, renderRefinedPage)}
      ${renderPages(stressWorks, stressPair.vertical, renderVerticalPage)}
    </div>
    ${includeScreenPreview ? `<div id="d-screen-preview" class="screen-preview">
      ${renderVerticalPage(previewWorks, previewPair.vertical.pages[0], 0, previewPair.vertical.pages.length, "C").replace("class=\"sheet ", "class=\"sheet preview-sheet ")}
      ${renderDPage(previewWorks, previewPair.vertical40.pages[0], 0, previewPair.vertical40.pages.length, 0.4).replace("class=\"sheet ", "class=\"sheet preview-sheet ")}
      ${renderDPage(previewWorks, previewPair.vertical45.pages[0], 0, previewPair.vertical45.pages.length, 0.45).replace("class=\"sheet ", "class=\"sheet preview-sheet ")}
    </div>` : ""}
    <div class="pdf-pages" id="four-work-d-pdf-pages">
      ${renderPages(previewWorks, previewPair.vertical, renderVerticalPage)}
      ${renderPages(previewWorks, previewPair.vertical40, (works, entries, pageIndex, pageCount) => renderDPage(works, entries, pageIndex, pageCount, 0.4))}
      ${renderPages(previewWorks, previewPair.vertical45, (works, entries, pageIndex, pageCount) => renderDPage(works, entries, pageIndex, pageCount, 0.45))}
    </div>
    <div class="pdf-pages" id="stress-d-pdf-pages">
      ${renderPages(stressWorks, stressPair.vertical, renderVerticalPage)}
      ${renderPages(stressWorks, stressPair.vertical40, (works, entries, pageIndex, pageCount) => renderDPage(works, entries, pageIndex, pageCount, 0.4))}
      ${renderPages(stressWorks, stressPair.vertical45, (works, entries, pageIndex, pageCount) => renderDPage(works, entries, pageIndex, pageCount, 0.45))}
    </div>
  </body></html>`;
}

async function validatePdf(pdfBytes, expectedPageCount, label) {
  const pdf = await PDFDocument.load(pdfBytes);
  assert.equal(pdf.getPageCount(), expectedPageCount, `${label} page count`);
  const pageSizesPt = pdf.getPages().map((page) => [page.getWidth(), page.getHeight()]);
  for (const [width, height] of pageSizesPt) {
    assert.ok(Math.abs(width - A6_WIDTH_PT) <= A6_TOLERANCE_PT, `${label} A6 width`);
    assert.ok(Math.abs(height - A6_HEIGHT_PT) <= A6_TOLERANCE_PT, `${label} A6 height`);
  }
  return { pages: pdf.getPageCount(), firstPageSizePt: pageSizesPt[0], tolerancePt: A6_TOLERANCE_PT };
}

function layoutSummary(works, bodyPageCounts, pair) {
  return Object.fromEntries(["current", "refined", "vertical", "vertical40", "vertical45"].map((variant) => [variant, {
    tocPageCount: pair[variant].pages.length,
    workStartPages: pair[variant].pageNumbers,
    entriesInOrder: pair[variant].pages.flat().map((entry) => entry.workIndex),
    pageEntries: pair[variant].pages.map((page) => page.map((entry) => ({
      workIndex: entry.workIndex,
      title: works[entry.workIndex].title,
      author: works[entry.workIndex].author ?? "",
      pageNumber: entry.pageNumber,
    }))),
    colophonPageNumber: pair[variant].colophonPageNumber,
    bodyPageCounts,
  }]));
}

async function measureShiftedVerticalPages(page, selector) {
  return page.evaluate((pageSelector) => {
    const mmPerPx = 25.4 / 96;
    return [...document.querySelectorAll(pageSelector)].map((sheet) => {
      const pageBox = sheet.getBoundingClientRect();
      const list = sheet.querySelector(".c-list");
      if (!list) throw new Error("missing vertical TOC list");
      const listBox = list.getBoundingClientRect();
      const entries = [...list.querySelectorAll(".c-entry")].map((entry) => {
        const box = entry.getBoundingClientRect();
        const titleColumns = [...entry.querySelectorAll(".c-title-column")];
        const authorColumns = [...entry.querySelectorAll(".c-author-column")];
        const numberColumn = entry.querySelector(".c-number-column");
        const numberReference = entry.querySelector(".c-page-reference");
        const number = entry.querySelector(".c-page-number");
        const numberStyle = number ? getComputedStyle(number) : null;
        const textColumns = [...titleColumns, ...authorColumns];
        const boxesOverlap = (first, second) => first.left < second.right && first.right > second.left &&
          first.top < second.bottom && first.bottom > second.top;
        const numberBox = numberColumn?.getBoundingClientRect();
        return {
          page: Number(sheet.dataset.page),
          titleStartRatio: Number(sheet.dataset.titleStartRatio),
          index: Number(entry.dataset.workIndex),
          pageNumber: Number(entry.dataset.startPage),
          leftMm: (box.left - pageBox.left) * mmPerPx,
          rightMm: (box.right - pageBox.left) * mmPerPx,
          topMm: (box.top - pageBox.top) * mmPerPx,
          bottomMm: (box.bottom - pageBox.top) * mmPerPx,
          measuredWidthMm: box.width * mmPerPx,
          estimatedWidthMm: Number(entry.dataset.estimatedWidthMm),
          title: titleColumns.map((column) => column.textContent).join(""),
          author: authorColumns.map((column) => column.textContent).join(""),
          titleTopsMm: titleColumns.map((column) => (column.getBoundingClientRect().top - pageBox.top) * mmPerPx),
          authorTopsMm: authorColumns.map((column) => (column.getBoundingClientRect().top - pageBox.top) * mmPerPx),
          textBottomMm: Math.max(0, ...textColumns.map((column) => (column.getBoundingClientRect().bottom - pageBox.top) * mmPerPx)),
          textHeightMm: titleColumns[0] ? titleColumns[0].getBoundingClientRect().height * mmPerPx : 0,
          titleColumnsOverflow: titleColumns.some((column) => column.scrollHeight > column.clientHeight || column.scrollWidth > column.clientWidth),
          authorColumnsOverflow: authorColumns.some((column) => column.scrollHeight > column.clientHeight || column.scrollWidth > column.clientWidth),
          titleAuthorNumberOverlap: Boolean(numberBox && textColumns.some((column) => boxesOverlap(column.getBoundingClientRect(), numberBox))),
          numberReferenceTopMm: numberReference ? (numberReference.getBoundingClientRect().top - pageBox.top) * mmPerPx : -1,
          displayedPageNumber: number?.textContent ?? "",
          numberBoxWidthMm: (number?.getBoundingClientRect().width ?? 0) * mmPerPx,
          numberOverflow: number ? number.scrollWidth > number.clientWidth || number.scrollHeight > number.clientHeight : true,
          numberWritingMode: numberStyle?.writingMode ?? "missing",
          numberTextCombine: numberStyle?.textCombineUpright ?? "missing",
        };
      });
      return {
        page: Number(sheet.dataset.page),
        variant: sheet.classList.contains("d40-sheet") ? "D40" : "D45",
        titleStartRatio: Number(sheet.dataset.titleStartRatio),
        listLeftMm: (listBox.left - pageBox.left) * mmPerPx,
        listRightMm: (listBox.right - pageBox.left) * mmPerPx,
        listTopMm: (listBox.top - pageBox.top) * mmPerPx,
        listBottomMm: (listBox.bottom - pageBox.top) * mmPerPx,
        entries,
      };
    });
  }, selector);
}

function assertShiftedVerticalMetrics(metrics, works, layoutByRatio, label) {
  const entries = metrics.flatMap((metric) => metric.entries);
  assert.ok(metrics.length > 0, `${label} should contain shifted pages`);
  for (const ratio of FINAL_TOC_SHIFT_RATIOS) {
    const variantMetrics = metrics.filter((metric) => metric.titleStartRatio === ratio);
    const variantEntries = variantMetrics.flatMap((metric) => metric.entries);
    const layout = layoutByRatio.get(ratio);
    assert.ok(variantMetrics.length > 0, `${label} is missing D${ratio * 100}`);
    assert.deepEqual(variantEntries.map((entry) => entry.index), layout.pages.flat().map((entry) => entry.workIndex));
    assert.deepEqual(variantEntries.map((entry) => entry.pageNumber), layout.pageNumbers);
    const expectedTopMm = FINAL_TOC_PREVIEW_PAGE_HEIGHT_MM * ratio;
    for (const metric of variantMetrics) {
      assert.ok(metric.listLeftMm >= 11.9 && metric.listRightMm <= 93.1, `${label} D${ratio * 100} side margins`);
      assert.ok(Math.abs(metric.listTopMm - FINAL_TOC_VERTICAL_LIST_TOP_MM) < 0.15 && metric.listBottomMm <= FINAL_TOC_PREVIEW_PAGE_HEIGHT_MM - FINAL_TOC_VERTICAL_BOTTOM_MARGIN_MM + 0.15, `${label} D${ratio * 100} list bounds`);
      let previousLeftMm = metric.listRightMm + 0.1;
      for (const entry of metric.entries) {
        const work = works[entry.index];
        assert.equal(entry.title, work.title);
        assert.equal(entry.author, work.author ?? "");
        assert.equal(entry.displayedPageNumber, String(entry.pageNumber));
        assert.ok(entry.titleTopsMm.length > 0);
        assert.ok(entry.titleTopsMm.every((top) => Math.abs(top - expectedTopMm) < 0.15), `${label} title tops are not aligned at D${ratio * 100}`);
        assert.ok(entry.authorTopsMm.every((top) => Math.abs(top - expectedTopMm) < 0.15), `${label} author top does not align with title at D${ratio * 100}`);
        assert.ok(entry.textBottomMm <= FINAL_TOC_PREVIEW_PAGE_HEIGHT_MM - FINAL_TOC_VERTICAL_BOTTOM_MARGIN_MM + 0.15, `${label} D${ratio * 100} text reaches the bottom margin`);
        assert.ok(Math.abs(entry.numberReferenceTopMm - FINAL_TOC_VERTICAL_PAGE_NUMBER_TOP_MM) < 0.15, `${label} page number moved at D${ratio * 100}`);
        assert.ok(entry.measuredWidthMm <= entry.estimatedWidthMm + 0.15, `${label} D${ratio * 100} item exceeds its width estimate`);
        assert.ok(entry.rightMm <= previousLeftMm + 0.1, `${label} D${ratio * 100} order is not right-to-left`);
        assert.equal(entry.titleColumnsOverflow, false, `${label} D${ratio * 100} title overflow`);
        assert.equal(entry.authorColumnsOverflow, false, `${label} D${ratio * 100} author overflow`);
        assert.equal(entry.titleAuthorNumberOverlap, false, `${label} D${ratio * 100} text overlaps the page number`);
        assert.equal(entry.numberOverflow, false, `${label} D${ratio * 100} page number overflow`);
        assert.equal(entry.numberWritingMode, "vertical-rl");
        assert.equal(entry.numberTextCombine, "all");
        previousLeftMm = entry.leftMm - FINAL_TOC_PREVIEW_ENTRY_GAP_MM;
      }
    }
  }
  return entries;
}

const fourWorkPair = calculateTocPreviewPair(FOUR_WORK_TOC_PREVIEW_WORKS, [...FOUR_WORK_TOC_PREVIEW_BODY_PAGE_COUNTS]);
const stressPair = calculateTocPreviewPair(TOC_PREVIEW_STRESS_WORKS, [...TOC_PREVIEW_STRESS_BODY_PAGE_COUNTS]);
assert.ok(fourWorkPair.current.pages.length >= 1 && fourWorkPair.refined.pages.length >= 1);
assert.ok(fourWorkPair.vertical.pages.length >= 1);
assert.ok(fourWorkPair.vertical40.pages.length >= 1 && fourWorkPair.vertical45.pages.length >= 1);
assert.ok(stressPair.current.pages.length > 1, "current TOC stress scenario must span multiple pages");
assert.ok(stressPair.refined.pages.length > 1, "refined TOC stress scenario must span multiple pages");
assert.ok(stressPair.vertical.pages.length > 1, "vertical TOC stress scenario must span multiple pages");
assert.ok(stressPair.vertical40.pages.length > 1 && stressPair.vertical45.pages.length > 1, "D variants must paginate stress entries");
assert.ok(stressPair.refined.pageNumbers.some((pageNumber) => pageNumber >= 100), "stress scenario must include three-digit start pages");
assert.ok(stressPair.vertical.pageNumbers.some((pageNumber) => pageNumber >= 100), "vertical stress scenario must include three-digit start pages");
assert.ok(stressPair.vertical40.pageNumbers.some((pageNumber) => pageNumber >= 100), "D40 stress scenario must include three-digit start pages");
assert.ok(stressPair.vertical45.pageNumbers.some((pageNumber) => pageNumber >= 100), "D45 stress scenario must include three-digit start pages");

await mkdir(outputDirectory, { recursive: true });
const config = resolveFinalPdfRendererConfig({ NODE_ENV: "development" });
const executablePath = await findFinalPdfChromiumExecutable(config);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, locale: "ja-JP" });
  page.setDefaultTimeout(30_000);
  const html = documentHtml(FOUR_WORK_TOC_PREVIEW_WORKS, fourWorkPair, TOC_PREVIEW_STRESS_WORKS, stressPair, true);
  await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const fourWorkPairPageCount = fourWorkPair.current.pages.length + fourWorkPair.refined.pages.length + fourWorkPair.vertical.pages.length;
  const fourWorkPdfBytes = await page.pdf({
    preferCSSPageSize: true,
    printBackground: true,
    displayHeaderFooter: false,
    timeout: 60_000,
  });
  const fourWorkPdf = await validatePdf(fourWorkPdfBytes, fourWorkPairPageCount, "four-work comparison");
  const fourWorkPdfPath = path.join(outputDirectory, "four-works-A-B-C-A6.pdf");
  await writeFile(fourWorkPdfPath, fourWorkPdfBytes);

  const screenshot = await page.locator("#screen-preview").screenshot({ animations: "disabled" });
  const comparisonPngPath = path.join(outputDirectory, "four-works-A-B-C.png");
  await writeFile(comparisonPngPath, screenshot);
  const shiftedScreenshot = await page.locator("#d-screen-preview").screenshot({ animations: "disabled" });
  const shiftedComparisonPngPath = path.join(outputDirectory, "four-works-C-D40-D45.png");
  await writeFile(shiftedComparisonPngPath, shiftedScreenshot);

  await page.evaluate(() => {
    document.querySelector("#pdf-pages")?.remove();
    document.querySelector("#d-screen-preview")?.remove();
    const preview = document.querySelector("#screen-preview");
    if (preview) preview.remove();
    document.querySelector("#stress-pdf-pages")?.classList.add("active-stress");
  });
  await page.addStyleTag({ content: "@media print { #pdf-pages { display: none !important; } #stress-pdf-pages { display: block !important; } }" });
  await page.emulateMedia({ media: "print" });
  const stressPageCount = stressPair.current.pages.length + stressPair.refined.pages.length + stressPair.vertical.pages.length;
  const stressMetrics = await page.evaluate(() => {
    const mmPerPx = 25.4 / 96;
    const pages = [...document.querySelectorAll("#stress-pdf-pages .refined-sheet")];
    const result = pages.map((sheet) => {
      const pageBox = sheet.getBoundingClientRect();
      const list = sheet.querySelector(".refined-list");
      if (!list) throw new Error("missing refined list");
      const listBox = list.getBoundingClientRect();
      const entries = [...list.querySelectorAll(".refined-entry")].map((entry) => {
        const box = entry.getBoundingClientRect();
        const number = entry.querySelector(".refined-page-number");
        const numberStyle = number ? getComputedStyle(number) : null;
        return {
          page: Number(sheet.dataset.page),
          index: Number(entry.dataset.workIndex),
          pageNumber: Number(entry.dataset.startPage),
          topMm: (box.top - pageBox.top) * mmPerPx,
          bottomMm: (box.bottom - pageBox.top) * mmPerPx,
          estimatedHeightMm: Number(entry.dataset.estimatedHeightMm),
          measuredHeightMm: box.height * mmPerPx,
          displayedPageNumber: number?.querySelector("span")?.textContent ?? "",
          pageNumberWidthMm: (number?.getBoundingClientRect().width ?? 0) * mmPerPx,
          pageNumberOverflow: number ? number.scrollWidth > number.clientWidth : true,
          numberWritingMode: numberStyle?.writingMode ?? "missing",
          numberWhiteSpace: numberStyle?.whiteSpace ?? "missing",
          numberFontVariant: numberStyle?.fontVariantNumeric ?? "missing",
        };
      });
      return {
        page: Number(sheet.dataset.page),
        listTopMm: (listBox.top - pageBox.top) * mmPerPx,
        listBottomMm: (listBox.bottom - pageBox.top) * mmPerPx,
        entries,
      };
    });
    return result;
  });

  const refinedStressEntries = stressMetrics.flatMap((metric) => metric.entries);
  assert.deepEqual(refinedStressEntries.map((entry) => entry.index), TOC_PREVIEW_STRESS_WORKS.map((_work, index) => index));
  assert.deepEqual(refinedStressEntries.map((entry) => entry.pageNumber), [...stressPair.refined.pageNumbers]);
  assert.ok(stressMetrics.every((metric) => metric.entries.length > 0));
  for (const metric of stressMetrics) {
    assert.ok(metric.listBottomMm > metric.listTopMm, `refined list has zero height on page ${metric.page}`);
    assert.ok(metric.listTopMm >= 40 && metric.listBottomMm <= 135, `refined list bounds are outside the A6 content area on page ${metric.page}`);
    let priorBottom = metric.listTopMm - 0.05;
    for (const entry of metric.entries) {
      assert.ok(entry.measuredHeightMm > 8, `refined entry ${entry.index} has zero or implausible height`);
      assert.equal(entry.displayedPageNumber, String(entry.pageNumber));
      assert.ok(entry.pageNumberWidthMm <= 14.1, `page number ${entry.pageNumber} exceeds its fixed column`);
      assert.equal(entry.pageNumberOverflow, false, `page number ${entry.pageNumber} overflows its column`);
      assert.ok(entry.topMm >= metric.listTopMm - 0.1, `refined entry ${entry.index} starts before list area`);
      assert.ok(entry.bottomMm <= metric.listBottomMm + 0.1, `refined entry ${entry.index} overflows list area`);
      assert.ok(entry.topMm >= priorBottom - 0.1, `refined entries overlap on page ${metric.page}`);
      assert.equal(entry.numberWritingMode, "horizontal-tb");
      assert.equal(entry.numberWhiteSpace, "nowrap");
      assert.equal(entry.numberFontVariant, "tabular-nums");
      priorBottom = entry.bottomMm;
    }
  }

  const verticalStressMetrics = await page.evaluate(() => {
    const mmPerPx = 25.4 / 96;
    return [...document.querySelectorAll("#stress-pdf-pages .vertical-sheet")].map((sheet) => {
      const pageBox = sheet.getBoundingClientRect();
      const list = sheet.querySelector(".c-list");
      if (!list) throw new Error("missing vertical TOC list");
      const listBox = list.getBoundingClientRect();
      const entries = [...list.querySelectorAll(".c-entry")].map((entry) => {
        const box = entry.getBoundingClientRect();
        const number = entry.querySelector(".c-page-number");
        const numberStyle = number ? getComputedStyle(number) : null;
        const titleColumns = [...entry.querySelectorAll(".c-title-column")];
        const authorColumns = [...entry.querySelectorAll(".c-author-column")];
        return {
          page: Number(sheet.dataset.page),
          index: Number(entry.dataset.workIndex),
          pageNumber: Number(entry.dataset.startPage),
          leftMm: (box.left - pageBox.left) * mmPerPx,
          rightMm: (box.right - pageBox.left) * mmPerPx,
          topMm: (box.top - pageBox.top) * mmPerPx,
          bottomMm: (box.bottom - pageBox.top) * mmPerPx,
          estimatedWidthMm: Number(entry.dataset.estimatedWidthMm),
          measuredWidthMm: box.width * mmPerPx,
          title: titleColumns.map((column) => column.textContent).join(""),
          titleColumnCount: titleColumns.length,
          titleColumnsOverflow: titleColumns.some((column) => column.scrollHeight > column.clientHeight || column.scrollWidth > column.clientWidth),
          author: authorColumns.map((column) => column.textContent).join(""),
          authorColumnCount: authorColumns.length,
          authorColumnsOverflow: authorColumns.some((column) => column.scrollHeight > column.clientHeight || column.scrollWidth > column.clientWidth),
          displayedPageNumber: number?.textContent ?? "",
          numberBoxWidthMm: (number?.getBoundingClientRect().width ?? 0) * mmPerPx,
          numberOverflow: number ? number.scrollWidth > number.clientWidth || number.scrollHeight > number.clientHeight : true,
          numberWritingMode: numberStyle?.writingMode ?? "missing",
          numberTextCombine: numberStyle?.textCombineUpright ?? "missing",
          titleWritingMode: titleColumns[0] ? getComputedStyle(titleColumns[0]).writingMode : "missing",
          listLeftMm: (listBox.left - pageBox.left) * mmPerPx,
          listRightMm: (listBox.right - pageBox.left) * mmPerPx,
        };
      });
      return {
        page: Number(sheet.dataset.page),
        listLeftMm: (listBox.left - pageBox.left) * mmPerPx,
        listRightMm: (listBox.right - pageBox.left) * mmPerPx,
        listTopMm: (listBox.top - pageBox.top) * mmPerPx,
        listBottomMm: (listBox.bottom - pageBox.top) * mmPerPx,
        entries,
      };
    });
  });

  const verticalStressEntries = verticalStressMetrics.flatMap((metric) => metric.entries);
  assert.deepEqual(verticalStressEntries.map((entry) => entry.index), TOC_PREVIEW_STRESS_WORKS.map((_work, index) => index));
  assert.deepEqual(verticalStressEntries.map((entry) => entry.pageNumber), [...stressPair.vertical.pageNumbers]);
  assert.ok(verticalStressMetrics.every((metric) => metric.entries.length > 0));
  for (const metric of verticalStressMetrics) {
    assert.ok(metric.listRightMm > metric.listLeftMm, `vertical list has zero width on page ${metric.page}`);
    assert.ok(metric.listLeftMm >= 11.9 && metric.listRightMm <= 93.1, `vertical list exceeds the 12mm side margins on page ${metric.page}`);
    assert.ok(metric.listTopMm >= 38 && metric.listBottomMm <= 128, `vertical list bounds are outside the A6 content area on page ${metric.page}`);
    let previousLeftMm = metric.listRightMm + 0.1;
    for (const entry of metric.entries) {
      const work = TOC_PREVIEW_STRESS_WORKS[entry.index];
      assert.equal(entry.title, work.title);
      assert.equal(entry.author, work.author ?? "");
      assert.equal(entry.displayedPageNumber, String(entry.pageNumber));
      assert.ok(entry.measuredWidthMm <= entry.estimatedWidthMm + 0.15, `vertical entry ${entry.index} exceeds estimated width`);
      assert.ok(entry.measuredWidthMm > 10, `vertical entry ${entry.index} has implausible width`);
      assert.ok(entry.topMm >= metric.listTopMm - 0.1 && entry.bottomMm <= metric.listBottomMm + 0.1, `vertical entry ${entry.index} overflows vertically`);
      assert.ok(entry.rightMm <= previousLeftMm + 0.1, `vertical entries are not ordered right-to-left on page ${metric.page}`);
      assert.ok(entry.numberBoxWidthMm <= 9.1, `page number ${entry.pageNumber} exceeds its fixed column`);
      assert.equal(entry.numberOverflow, false, `page number ${entry.pageNumber} overflows its tate-chu-yoko box`);
      assert.equal(entry.numberWritingMode, "vertical-rl");
      assert.equal(entry.numberTextCombine, "all");
      assert.equal(entry.titleWritingMode, "vertical-rl");
      assert.equal(entry.titleColumnsOverflow, false, `title for entry ${entry.index} overflows its vertical columns`);
      assert.equal(entry.authorColumnsOverflow, false, `author for entry ${entry.index} overflows its vertical columns`);
      previousLeftMm = entry.leftMm - FINAL_TOC_PREVIEW_ENTRY_GAP_MM;
    }
  }

  const stressPdfBytes = await page.pdf({
    preferCSSPageSize: true,
    printBackground: true,
    displayHeaderFooter: false,
    timeout: 60_000,
  });
  const stressPdf = await validatePdf(stressPdfBytes, stressPageCount, "pagination stress comparison");
  const stressPdfPath = path.join(outputDirectory, "pagination-stress-A-B-C-A6.pdf");
  await writeFile(stressPdfPath, stressPdfBytes);

  await page.evaluate(() => {
    document.querySelector("#stress-pdf-pages")?.remove();
    document.querySelector("#screen-preview")?.remove();
  });
  await page.addStyleTag({ content: "@media print { #four-work-d-pdf-pages { display: block !important; } #stress-d-pdf-pages { display: none !important; } }" });
  const dFourMetrics = await measureShiftedVerticalPages(page, "#four-work-d-pdf-pages .shifted-vertical-sheet");
  const dLayoutsByRatio = new Map([[0.4, fourWorkPair.vertical40], [0.45, fourWorkPair.vertical45]]);
  const dFourEntries = assertShiftedVerticalMetrics(dFourMetrics, FOUR_WORK_TOC_PREVIEW_WORKS, dLayoutsByRatio, "four-work comparison");
  const dFourWorkPageCount = fourWorkPair.vertical.pages.length + fourWorkPair.vertical40.pages.length + fourWorkPair.vertical45.pages.length;
  const dFourWorkPdfBytes = await page.pdf({
    preferCSSPageSize: true,
    printBackground: true,
    displayHeaderFooter: false,
    timeout: 60_000,
  });
  const dFourWorkPdf = await validatePdf(dFourWorkPdfBytes, dFourWorkPageCount, "four-work C/D comparison");
  const dFourWorkPdfPath = path.join(outputDirectory, "four-works-C-D40-D45-A6.pdf");
  await writeFile(dFourWorkPdfPath, dFourWorkPdfBytes);

  await page.evaluate(() => document.querySelector("#four-work-d-pdf-pages")?.remove());
  await page.addStyleTag({ content: "@media print { #stress-d-pdf-pages { display: block !important; } #four-work-d-pdf-pages { display: none !important; } }" });
  const dStressMetrics = await measureShiftedVerticalPages(page, "#stress-d-pdf-pages .shifted-vertical-sheet");
  const dStressLayoutsByRatio = new Map([[0.4, stressPair.vertical40], [0.45, stressPair.vertical45]]);
  const dStressEntries = assertShiftedVerticalMetrics(dStressMetrics, TOC_PREVIEW_STRESS_WORKS, dStressLayoutsByRatio, "pagination stress comparison");
  const dStressPageCount = stressPair.vertical.pages.length + stressPair.vertical40.pages.length + stressPair.vertical45.pages.length;
  const dStressPdfBytes = await page.pdf({
    preferCSSPageSize: true,
    printBackground: true,
    displayHeaderFooter: false,
    timeout: 60_000,
  });
  const dStressPdf = await validatePdf(dStressPdfBytes, dStressPageCount, "pagination stress C/D comparison");
  const dStressPdfPath = path.join(outputDirectory, "pagination-stress-C-D40-D45-A6.pdf");
  await writeFile(dStressPdfPath, dStressPdfBytes);

  const report = {
    generatedAt: new Date().toISOString(),
    note: "Four familiar title/author pairs are shown with deterministic sample body-page counts; the live anthology and its actual starts were not accessed.",
    outputs: {
      fourWorkPdf: fourWorkPdfPath,
      fourWorkComparisonPng: comparisonPngPath,
      paginationStressPdf: stressPdfPath,
      fourWorkShiftedPdf: dFourWorkPdfPath,
      fourWorkShiftedComparisonPng: shiftedComparisonPngPath,
      paginationStressShiftedPdf: dStressPdfPath,
    },
    fourWorks: {
      works: FOUR_WORK_TOC_PREVIEW_WORKS,
      sampleBodyPageCounts: [...FOUR_WORK_TOC_PREVIEW_BODY_PAGE_COUNTS],
      current: layoutSummary(FOUR_WORK_TOC_PREVIEW_WORKS, FOUR_WORK_TOC_PREVIEW_BODY_PAGE_COUNTS, fourWorkPair).current,
      refined: layoutSummary(FOUR_WORK_TOC_PREVIEW_WORKS, FOUR_WORK_TOC_PREVIEW_BODY_PAGE_COUNTS, fourWorkPair).refined,
      vertical: layoutSummary(FOUR_WORK_TOC_PREVIEW_WORKS, FOUR_WORK_TOC_PREVIEW_BODY_PAGE_COUNTS, fourWorkPair).vertical,
      vertical40: {
        ...layoutSummary(FOUR_WORK_TOC_PREVIEW_WORKS, FOUR_WORK_TOC_PREVIEW_BODY_PAGE_COUNTS, fourWorkPair).vertical40,
        titleStartMm: getShiftedVerticalTocTextGeometry(0.4).titleStartMm,
        textBottomMm: getShiftedVerticalTocTextGeometry(0.4).textBottomMm,
        measuredEntries: dFourEntries.filter((entry) => entry.titleStartRatio === 0.4),
      },
      vertical45: {
        ...layoutSummary(FOUR_WORK_TOC_PREVIEW_WORKS, FOUR_WORK_TOC_PREVIEW_BODY_PAGE_COUNTS, fourWorkPair).vertical45,
        titleStartMm: getShiftedVerticalTocTextGeometry(0.45).titleStartMm,
        textBottomMm: getShiftedVerticalTocTextGeometry(0.45).textBottomMm,
        measuredEntries: dFourEntries.filter((entry) => entry.titleStartRatio === 0.45),
      },
      pdf: fourWorkPdf,
      shiftedPdf: dFourWorkPdf,
    },
    paginationStress: {
      workCount: TOC_PREVIEW_STRESS_WORKS.length,
      current: {
        tocPageCount: stressPair.current.pages.length,
        workStartPages: stressPair.current.pageNumbers,
        colophonPageNumber: stressPair.current.colophonPageNumber,
      },
      refined: {
        tocPageCount: stressPair.refined.pages.length,
        workStartPages: stressPair.refined.pageNumbers,
        colophonPageNumber: stressPair.refined.colophonPageNumber,
        measuredPages: stressMetrics,
      },
      vertical: {
        tocPageCount: stressPair.vertical.pages.length,
        workStartPages: stressPair.vertical.pageNumbers,
        colophonPageNumber: stressPair.vertical.colophonPageNumber,
        measuredPages: verticalStressMetrics,
      },
      pdf: stressPdf,
      vertical40: {
        tocPageCount: stressPair.vertical40.pages.length,
        workStartPages: stressPair.vertical40.pageNumbers,
        colophonPageNumber: stressPair.vertical40.colophonPageNumber,
        measuredEntries: dStressEntries.filter((entry) => entry.titleStartRatio === 0.4),
      },
      vertical45: {
        tocPageCount: stressPair.vertical45.pages.length,
        workStartPages: stressPair.vertical45.pageNumbers,
        colophonPageNumber: stressPair.vertical45.colophonPageNumber,
        measuredEntries: dStressEntries.filter((entry) => entry.titleStartRatio === 0.45),
      },
      shiftedPdf: dStressPdf,
    },
  };
  await writeFile(path.join(outputDirectory, "measurements.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`TOC comparison generated: ${outputDirectory}`);
  console.log(`Four works A/B/C PDF: ${fourWorkPdfPath} (${fourWorkPdf.pages} A6 pages)`);
  console.log(`Four works preview: ${comparisonPngPath}`);
  console.log(`Four works C/D40/D45 PDF: ${dFourWorkPdfPath} (${dFourWorkPdf.pages} A6 pages)`);
  console.log(`Four works C/D40/D45 preview: ${shiftedComparisonPngPath}`);
  console.log(`Pagination stress A/B/C PDF: ${stressPdfPath} (${stressPair.current.pages.length} A + ${stressPair.refined.pages.length} B + ${stressPair.vertical.pages.length} C A6 pages)`);
  console.log(`Pagination stress C/D40/D45 PDF: ${dStressPdfPath} (${stressPair.vertical.pages.length} C + ${stressPair.vertical40.pages.length} D40 + ${stressPair.vertical45.pages.length} D45 A6 pages)`);
  console.log(`Vertical C sample starts: ${fourWorkPair.vertical.pageNumbers.join(", ")}`);
  console.log(`Vertical D40 sample starts: ${fourWorkPair.vertical40.pageNumbers.join(", ")}`);
  console.log(`Vertical D45 sample starts: ${fourWorkPair.vertical45.pageNumbers.join(", ")}`);
} finally {
  await browser.close();
}
