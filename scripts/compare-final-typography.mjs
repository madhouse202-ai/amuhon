import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import {
  COMPARISON_BODY_FONT_SIZE_PT,
  COMPARISON_BODY_TOP_MM,
  COMPARISON_COLUMN_WIDTH_MM,
  COMPARISON_CONTENT_HEIGHT_MM,
  COMPARISON_CONTENT_WIDTH_MM,
  COMPARISON_PAGE_HEIGHT_MM,
  COMPARISON_PAGE_WIDTH_MM,
  LONG_TYPOGRAPHY_VARIANTS,
  TYPOGRAPHY_VARIANTS,
  createLongTypographyFixture,
  getTypographyComparisonLayouts,
  renderTypographyColumnHtml,
} from "../lib/final-typography-comparison.ts";
import { findFinalPdfChromiumExecutable } from "../lib/local-final-pdf.ts";
import { resolveFinalPdfRendererConfig } from "../lib/final-pdf-renderer-config.ts";

if (process.env.NODE_ENV === "production") {
  throw new Error("Typography comparison is available only outside production.");
}

const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--short")) {
  throw new Error("Only the optional --short switch is supported; paths and source text are fixed.");
}
const shortMode = args.includes("--short");
const fixture = shortMode ? null : createLongTypographyFixture();
const text = fixture?.text;
const variants = shortMode ? TYPOGRAPHY_VARIANTS : LONG_TYPOGRAPHY_VARIANTS;
const layouts = getTypographyComparisonLayouts({ text: text ?? undefined, variants });
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputModeSuffix = shortMode ? "short" : "long";
const OUTPUT_DIRECTORY = path.resolve(scriptDirectory, `../tmp/final-typography-comparison/${shortMode ? "phase-1-short" : "phase-2-long"}`);

function buildVariantPage(layout, pageIndex) {
  const pageColumns = layout.pages[pageIndex] ?? [];
  const paddedColumns = [...pageColumns, ...Array(Math.max(0, 16 - pageColumns.length)).fill(null)];
  const columnsHtml = paddedColumns.map((column) => renderTypographyColumnHtml(column, layout.trackingEm)).join("");
  return `<section class="sheet" data-variant="${layout.id}" data-page="${pageIndex + 1}">
    <div class="variant-label">${layout.label}｜本文 ${pageIndex + 1}/${layout.pageCount}頁</div>
    <div class="body-content" style="width:${COMPARISON_CONTENT_WIDTH_MM}mm;height:${layout.requiredColumnHeightMm}mm">
      ${columnsHtml}
    </div>
  </section>`;
}

const css = `
  @page { size: ${COMPARISON_PAGE_WIDTH_MM}mm ${COMPARISON_PAGE_HEIGHT_MM}mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  .sheet {
    position: relative; width: ${COMPARISON_PAGE_WIDTH_MM}mm; height: ${COMPARISON_PAGE_HEIGHT_MM}mm;
    overflow: hidden; background: #f8f3df; break-after: page; page-break-after: always;
  }
  .sheet:last-child { break-after: auto; page-break-after: auto; }
  .variant-label {
    position: absolute; top: 3mm; left: 3mm; font: 6pt Arial, sans-serif; color: #666;
  }
  .body-content {
    position: absolute; top: ${COMPARISON_BODY_TOP_MM}mm; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: row-reverse; align-items: flex-start; justify-content: flex-start;
    overflow: visible;
  }
  .column {
    position: relative; flex: 0 0 ${COMPARISON_COLUMN_WIDTH_MM}mm; width: ${COMPARISON_COLUMN_WIDTH_MM}mm;
    height: inherit; writing-mode: vertical-rl; text-orientation: mixed; font-size: ${COMPARISON_BODY_FONT_SIZE_PT}pt;
    line-height: 1; letter-spacing: 0; line-break: strict; word-break: normal; overflow-wrap: normal;
    white-space: nowrap; overflow: visible;
  }
  .sheet[data-variant="D"] .column { font-family: "Noto Serif JP", serif; }
  .print-character-cell {
    position: absolute; block-size: 1em; box-sizing: border-box; line-height: 1; text-align: center; white-space: nowrap;
  }
  .print-character-cell__ruby {
    position: absolute; left: 100%; top: 50%; display: block; inline-size: max-content; block-size: max-content;
    transform: translateY(-50%); writing-mode: vertical-rl; font-size: 0.5em; line-height: 1; text-align: center; white-space: nowrap;
  }
  @media print {
    html, body { display: block; width: ${COMPARISON_PAGE_WIDTH_MM}mm; height: auto; background: #fff; }
    .sheet { width: ${COMPARISON_PAGE_WIDTH_MM}mm; height: ${COMPARISON_PAGE_HEIGHT_MM}mm; break-after: page; page-break-after: always; }
    .column { line-height: 1 !important; letter-spacing: 0 !important; }
  }
`;

const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${css}</style></head><body>
${layouts.flatMap((layout) => layout.pages.map((_page, index) => buildVariantPage(layout, index))).join("\n")}
</body></html>`;

const config = resolveFinalPdfRendererConfig({ NODE_ENV: "development" });
const executablePath = await findFinalPdfChromiumExecutable(config);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1, locale: "ja-JP" });
  page.setDefaultTimeout(60_000);
  await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready.then(() => true));

  const notoSheet = page.locator('.sheet[data-variant="D"] .column').first();
  const fontLoaded = await notoSheet.evaluate(async (node) => {
    await document.fonts.ready;
    return document.fonts.check('8.5pt "Noto Serif JP"', node.textContent ?? "");
  });
  assert.equal(fontLoaded, true, "Noto Serif JP must be available locally; no fallback is accepted for D.");

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const getPlatformFonts = async (selector) => {
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    assert.ok(nodeId, `Missing font probe node: ${selector}`);
    return cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  };
  const notoFonts = await getPlatformFonts('.sheet[data-variant="D"] .column');
  const notoFont = notoFonts.fonts.find((entry) => /Noto Serif JP/i.test(entry.familyName));
  assert.ok(notoFont, "Chromium must confirm that D actually uses the installed Noto Serif JP font.");
  const baselineFonts = await getPlatformFonts('.sheet[data-variant="A"] .column');

  const measurement = await page.evaluate(() => {
    const rectsIntersect = (left, right) =>
      left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
    return [...document.querySelectorAll(".sheet")].map((sheet) => {
      const body = sheet.querySelector(".body-content");
      const columns = [...sheet.querySelectorAll(".column")];
      const bodyRect = body.getBoundingClientRect();
      const firstStyle = getComputedStyle(columns[0]);
      const fontSizePx = Number.parseFloat(firstStyle.fontSize);
      const bodyHeightMm = bodyRect.height * 25.4 / 96;
      let maxCoordinateErrorPx = 0;
      let maxColumnAdvancePx = 0;
      let cellOverflowCount = 0;
      let baseCellOverlapCount = 0;
      let rubyNeighborOverlapCount = 0;
      const cellsByColumn = [];
      const allRubies = [];

      for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
        const column = columns[columnIndex];
        const columnRect = column.getBoundingClientRect();
        const columnCells = [...column.querySelectorAll(".print-character-cell")];
        let maxEndPx = 0;
        let priorCellBottom = -Infinity;
        const cellBoxes = [];
        for (const cell of columnCells) {
          const rect = cell.getBoundingClientRect();
          const expectedStartPx = Number(cell.dataset.startEm) * fontSizePx;
          const expectedAdvancePx = Number(cell.dataset.advanceEm) * fontSizePx;
          maxCoordinateErrorPx = Math.max(maxCoordinateErrorPx, Math.abs((rect.top - columnRect.top) - expectedStartPx));
          maxCoordinateErrorPx = Math.max(maxCoordinateErrorPx, Math.abs(rect.height - expectedAdvancePx));
          maxEndPx = Math.max(maxEndPx, (rect.bottom - columnRect.top));

          const cellBox = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, columnIndex };
          cellBoxes.push(cellBox);
          if (rect.left < columnRect.left - 0.75 || rect.right > columnRect.right + 0.75 || rect.top < columnRect.top - 0.75 || rect.bottom > bodyRect.bottom + 0.75) cellOverflowCount += 1;
          if (rect.top < priorCellBottom - 0.75) baseCellOverlapCount += 1;
          priorCellBottom = Math.max(priorCellBottom, rect.bottom);

          const ruby = cell.querySelector(".print-character-cell__ruby");
          if (ruby) {
            const rubyRect = ruby.getBoundingClientRect();
            allRubies.push({ left: rubyRect.left, right: rubyRect.right, top: rubyRect.top, bottom: rubyRect.bottom, columnIndex });
          }
        }
        maxColumnAdvancePx = Math.max(maxColumnAdvancePx, maxEndPx);
        cellsByColumn.push(cellBoxes);
      }

      for (const ruby of allRubies) {
        for (const neighborIndex of [ruby.columnIndex - 1, ruby.columnIndex + 1]) {
          for (const neighborCell of cellsByColumn[neighborIndex] ?? []) {
            if (rectsIntersect(ruby, neighborCell)) rubyNeighborOverlapCount += 1;
          }
        }
      }

      const columnCharCounts = columns.map((column) => [...column.querySelectorAll(".print-character-cell")]
        .reduce((sum, cell) => sum + Number(cell.dataset.characterCount), 0));
      return {
        variant: sheet.dataset.variant,
        page: Number(sheet.dataset.page),
        sheetWidthMm: sheet.getBoundingClientRect().width * 25.4 / 96,
        sheetHeightMm: sheet.getBoundingClientRect().height * 25.4 / 96,
        bodyHeightMm,
        maxCoordinateErrorPx,
        maxColumnAdvancePx,
        rubyCount: sheet.querySelectorAll(".print-character-cell__ruby").length,
        cellCount: sheet.querySelectorAll(".print-character-cell").length,
        columnsOnPage: columns.length,
        maxCharactersInColumn: Math.max(0, ...columnCharCounts),
        cellOverflowCount,
        baseCellOverlapCount,
        rubyNeighborOverlapCount,
        requestedFont: firstStyle.fontFamily,
      };
    });
  });

  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const outputMeasurements = [];
  const featureNames = ["mikanPhrase", "rubyHeavy", "punctuation", "pageEnd"];
  const featurePageIndexes = fixture?.featurePageIndexes ?? {
    mikanPhrase: 0,
    rubyHeavy: 0,
    punctuation: 0,
    pageEnd: layouts[0].pageCount - 1,
  };

  for (const layout of layouts) {
    const selector = `.sheet[data-variant="${layout.id}"]`;
    const layoutMetrics = measurement.filter((entry) => entry.variant === layout.id);
    assert.equal(layoutMetrics.length, layout.pageCount);
    for (const metrics of layoutMetrics) {
      assert.ok(Math.abs(metrics.sheetWidthMm - COMPARISON_PAGE_WIDTH_MM) < 0.02);
      assert.ok(Math.abs(metrics.sheetHeightMm - COMPARISON_PAGE_HEIGHT_MM) < 0.02);
      assert.ok(metrics.bodyHeightMm <= COMPARISON_CONTENT_HEIGHT_MM);
      assert.ok(metrics.maxCoordinateErrorPx < 0.75);
      assert.ok(metrics.maxColumnAdvancePx <= (layout.fortyCharacterAdvanceMm / 25.4 * 96) + 0.75);
      assert.ok(metrics.columnsOnPage <= 16);
      assert.ok(metrics.maxCharactersInColumn <= 40);
      assert.equal(metrics.cellOverflowCount, 0, `cell overflow: ${layout.id} page ${metrics.page}`);
      assert.equal(metrics.baseCellOverlapCount, 0, `base cell overlap: ${layout.id} page ${metrics.page}`);
      assert.equal(metrics.rubyNeighborOverlapCount, 0, `ruby overlaps adjacent column: ${layout.id} page ${metrics.page}`);
    }

    const filesByFeature = {};
    for (const featureName of featureNames) {
      const pageIndex = featurePageIndexes[featureName];
      assert.ok(pageIndex >= 0 && pageIndex < layout.pageCount, `invalid ${featureName} page index`);
      const screenshotPath = path.join(OUTPUT_DIRECTORY, `typography-${featureName}-${layout.id}-page-${pageIndex + 1}.png`);
      await page.locator(`${selector}[data-page="${pageIndex + 1}"]`).screenshot({ path: screenshotPath, animations: "disabled" });
      filesByFeature[featureName] = screenshotPath;
    }
    outputMeasurements.push({
      id: layout.id,
      label: layout.label,
      fontFamily: layout.fontFamily,
      trackingEm: layout.trackingEm,
      charAdvanceMm: layout.charAdvanceMm,
      fortyCharacterAdvanceMm: layout.fortyCharacterAdvanceMm,
      requiredColumnHeightMm: layout.requiredColumnHeightMm,
      remainingBodyHeightMm: layout.remainingBodyHeightMm,
      pageCount: layout.pageCount,
      columnCount: layout.columnCount,
      maximumColumnCharacters: layout.maximumColumnCharacters,
      pages: layoutMetrics,
      featurePngPaths: filesByFeature,
    });
  }

  const combinedPdfBytes = await page.pdf({
    preferCSSPageSize: true,
    printBackground: true,
    displayHeaderFooter: false,
    timeout: 120_000,
  });
  const combinedPdf = await PDFDocument.load(combinedPdfBytes);
  const expectedCombinedPageCount = layouts.reduce((sum, variant) => sum + variant.pageCount, 0);
  assert.equal(combinedPdf.getPageCount(), expectedCombinedPageCount);
  for (const pdfPage of combinedPdf.getPages()) {
    assert.ok(Math.abs(pdfPage.getWidth() - COMPARISON_PAGE_WIDTH_MM / 25.4 * 72) <= 1.5);
    assert.ok(Math.abs(pdfPage.getHeight() - COMPARISON_PAGE_HEIGHT_MM / 25.4 * 72) <= 1.5);
  }
  const firstPdfPage = combinedPdf.getPage(0);
  const measuredPdfPageSizePt = [firstPdfPage.getWidth(), firstPdfPage.getHeight()];
  const measuredPdfPageSizeMm = measuredPdfPageSizePt.map((points) => points / 72 * 25.4);
  const combinedPdfPath = path.join(OUTPUT_DIRECTORY, `typography-comparison-${outputModeSuffix}-A6.pdf`);
  await writeFile(combinedPdfPath, combinedPdfBytes);

  let firstPageOffset = 0;
  const pdfPaths = {};
  for (const layout of layouts) {
    const variantPdf = await PDFDocument.create();
    const indexes = Array.from({ length: layout.pageCount }, (_, index) => firstPageOffset + index);
    const copiedPages = await variantPdf.copyPages(combinedPdf, indexes);
    for (const copiedPage of copiedPages) variantPdf.addPage(copiedPage);
    const variantPath = path.join(OUTPUT_DIRECTORY, `typography-${layout.id}-${outputModeSuffix}-A6.pdf`);
    await writeFile(variantPath, await variantPdf.save());
    assert.equal(variantPdf.getPageCount(), layout.pageCount);
    pdfPaths[layout.id] = variantPath;
    firstPageOffset += layout.pageCount;
  }

  const comparisonPngPaths = {};
  for (const featureName of featureNames) {
    const inputPaths = outputMeasurements.map((variant) => variant.featurePngPaths[featureName]);
    const inputs = await Promise.all(inputPaths.map(async (inputPath) => {
      const buffer = await readFile(inputPath);
      const metadata = await sharp(buffer).metadata();
      assert.ok(metadata.width && metadata.height);
      return { input: buffer, width: metadata.width, height: metadata.height };
    }));
    const width = inputs[0].width;
    // Chromium rasterizes fractional A6 CSS pixels to 560 or 561 px depending
    // on the font metrics. Normalize only the contact sheet; keep originals.
    const height = Math.ceil(COMPARISON_PAGE_HEIGHT_MM / 25.4 * 96);
    assert.ok(inputs.every((entry) => entry.width === width));
    const normalizedInputs = await Promise.all(inputs.map((entry) => sharp(entry.input)
      .resize(width, height, { fit: "fill" })
      .png()
      .toBuffer()));
    const variantSet = layouts.map(({ id }) => id).join("-");
    const contactPath = path.join(OUTPUT_DIRECTORY, `typography-${featureName}-${variantSet}-comparison.png`);
    await sharp({ create: { width: width * inputs.length, height, channels: 4, background: "#fff" } })
      .composite(normalizedInputs.map((input, index) => ({ input, left: width * index, top: 0 })))
      .png()
      .toFile(contactPath);
    comparisonPngPaths[featureName] = contactPath;
  }

  const fixtureHash = createHash("sha256").update(fixture?.text ?? "short-phase-1").digest("hex");
  const report = {
    generatedAt: new Date().toISOString(),
    mode: shortMode ? "phase-1-short" : "phase-2-long",
    source: fixture?.description ?? "short local review fixture",
    sourceWorks: fixture?.sources ?? [],
    fixtureSha256: fixtureHash,
    features: Object.fromEntries(featureNames.map((name) => [name, {
      page: featurePageIndexes[name] + 1,
      comparisonPng: comparisonPngPaths[name],
    }])),
    fonts: {
      noto: { familyName: notoFont.familyName, glyphCount: notoFont.glyphCount, isCustomFont: notoFont.isCustomFont },
      baseline: baselineFonts.fonts.map(({ familyName, glyphCount, isCustomFont }) => ({ familyName, glyphCount, isCustomFont })),
    },
    pdf: {
      combined: {
        path: combinedPdfPath,
        pages: combinedPdf.getPageCount(),
        expectedPageSizeMm: [COMPARISON_PAGE_WIDTH_MM, COMPARISON_PAGE_HEIGHT_MM],
        measuredPageSizePt: measuredPdfPageSizePt,
        measuredPageSizeMm: measuredPdfPageSizeMm,
        tolerancePt: 1.5,
      },
      variants: pdfPaths,
    },
    variants: outputMeasurements,
    visualReview: "PNG screenshots are generated for visual inspection. Numeric geometry checks do not replace human review of print appearance.",
  };
  await writeFile(path.join(OUTPUT_DIRECTORY, "measurements.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Typography comparison generated: ${OUTPUT_DIRECTORY}`);
  console.log(`Combined PDF: ${combinedPdfPath}`);
  for (const variant of outputMeasurements) {
    console.log(`${variant.id}: pages=${variant.pageCount}; 40-char=${variant.fortyCharacterAdvanceMm.toFixed(2)}mm; column=${variant.requiredColumnHeightMm.toFixed(2)}mm; remaining=${variant.remainingBodyHeightMm.toFixed(2)}mm; PDF=${pdfPaths[variant.id]}`);
  }
  console.log(`Feature comparison PNGs: ${Object.values(comparisonPngPaths).join(", ")}`);
  console.log(`Fixture SHA-256: ${fixtureHash}`);
  console.log(`Noto Serif JP confirmed by Chromium: ${notoFont.familyName} (${notoFont.glyphCount} glyphs)`);
} finally {
  await browser.close();
}
