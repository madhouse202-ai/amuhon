import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FINAL_PRELOADED_WORKS_SESSION_KEY,
  FINAL_TYPOGRAPHY_SESSION_KEY,
  NOTO_SERIF_JP_FONT_FAMILY,
  NOTO_SERIF_JP_UNAVAILABLE_MESSAGE,
  isFinalBodyTypography,
  parseFinalPreviewWorkTexts,
  parseFinalTypographyPreviewRequest,
} from "../lib/final-typography-preview.ts";
import { isNotoSerifJpFontFamily } from "../lib/noto-serif-jp-preview.ts";
import {
  LOCAL_FINAL_PDF_DIAGNOSTIC_CODES,
  runLocalFinalPdfDiagnosticStage,
} from "../lib/local-final-pdf.ts";

const book = {
  works: [{
    id: "work-1",
    title: "蜜柑",
    author: "芥川龍之介",
    cardUrl: "https://www.aozora.gr.jp/cards/000879/card430.html",
    textUrl: "https://www.aozora.gr.jp/cards/000879/files/430_ruby_173.zip",
    xhtmlUrl: "https://www.aozora.gr.jp/cards/000879/files/430_19793.html",
  }],
  title: "試作本",
  editor: "編者",
  coverStyle: "classic",
  coverColor: "red",
};

test("preview request accepts only the two fixed modes and exact selected-work text", () => {
  assert.equal(isFinalBodyTypography("serif"), true);
  assert.equal(isFinalBodyTypography("noto-serif-jp"), true);
  assert.equal(isFinalBodyTypography("https://example.com"), false);
  assert.equal(isFinalBodyTypography("custom-css"), false);

  const works = [{ id: "work-1", title: "蜜柑", author: "芥川龍之介", text: "不思議な｜文字《もじ》" }];
  assert.deepEqual(parseFinalPreviewWorkTexts(works, book), works);
  assert.equal(parseFinalPreviewWorkTexts([{ ...works[0], id: "another-work" }], book), null);
  assert.equal(parseFinalPreviewWorkTexts([{ ...works[0], title: "別の作品" }], book), null);
  assert.equal(parseFinalPreviewWorkTexts([{ ...works[0], text: " " }], book), null);
  assert.equal(parseFinalPreviewWorkTexts([{ ...works[0], text: "あ".repeat(4_000_001) }], book), null);

  const request = parseFinalTypographyPreviewRequest({
    book,
    bodyPdfPageCount: 24,
    bodyTypography: "noto-serif-jp",
    works,
  });
  assert.equal(request?.bodyTypography, "noto-serif-jp");
  assert.equal(request?.works[0].text, works[0].text);
  assert.equal(parseFinalTypographyPreviewRequest({ book, bodyPdfPageCount: 24, bodyTypography: "noto-serif-jp", works: [] }), null);
  assert.equal(parseFinalTypographyPreviewRequest({ book, bodyPdfPageCount: 24, bodyTypography: "custom-css", works }), null);
});

test("Noto Serif JP family matching accepts Chromium's quoted FontFace.family value only", () => {
  assert.equal(isNotoSerifJpFontFamily("Noto Serif JP"), true);
  assert.equal(isNotoSerifJpFontFamily('"Noto Serif JP"'), true);
  assert.equal(isNotoSerifJpFontFamily("'Noto Serif JP'"), true);
  assert.equal(isNotoSerifJpFontFamily('"Noto Serif JP Other"'), false);
  assert.equal(isNotoSerifJpFontFamily("serif"), false);
});

test("local PDF diagnostic stages emit only fixed start, success, and failure codes", async () => {
  const events = [];
  const codes = {
    start: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.chromiumStart,
    success: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.chromiumSuccess,
    failure: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.chromiumFailure,
  };

  assert.equal(await runLocalFinalPdfDiagnosticStage((code) => events.push(code), codes, async () => "ok"), "ok");
  assert.deepEqual(events, [codes.start, codes.success]);
  assert.equal(await runLocalFinalPdfDiagnosticStage(() => { throw new Error("diagnostic_callback_failed"); }, codes, async () => "unchanged"), "unchanged");

  events.length = 0;
  await assert.rejects(
    runLocalFinalPdfDiagnosticStage((code) => events.push(code), codes, async () => {
      throw new Error("do-not-log-this-detail");
    }),
    /do-not-log-this-detail/,
  );
  assert.deepEqual(events, [codes.start, codes.failure]);
  assert.equal(Object.values(LOCAL_FINAL_PDF_DIAGNOSTIC_CODES).some((code) => code.includes("do-not-log-this-detail")), false);

  const expectedStages = [
    "REQUEST_VALIDATION_START", "REQUEST_VALIDATION_SUCCESS", "REQUEST_VALIDATION_FAILURE",
    "CHROMIUM_START", "CHROMIUM_SUCCESS", "CHROMIUM_FAILURE",
    "PAGE_NAVIGATION_START", "PAGE_NAVIGATION_SUCCESS", "PAGE_NAVIGATION_FAILURE",
    "BODY_HANDOFF_SETUP_START", "BODY_HANDOFF_SETUP_SUCCESS", "BODY_HANDOFF_SETUP_FAILURE",
    "BODY_HANDOFF_VERIFY_START", "BODY_HANDOFF_VERIFY_SUCCESS", "BODY_HANDOFF_VERIFY_FAILURE",
    "LAYOUT_WAIT_START", "LAYOUT_WAIT_SUCCESS", "LAYOUT_WAIT_FAILURE",
    "LAYOUT_WAIT_TIMEOUT_FAILURE", "LAYOUT_NOTO_ALERT_FAILURE",
    "LAYOUT_WORK_TEXT_ALERT_FAILURE", "LAYOUT_SNAPSHOT_ALERT_FAILURE",
    "LAYOUT_EMPTY_BOOK_ALERT_FAILURE", "LAYOUT_PAGE_COUNT_RANGE_ALERT_FAILURE",
    "LAYOUT_MAIN_SCREEN_ALERT_FAILURE", "LAYOUT_TYPOGRAPHY_CONTROL_ALERT_FAILURE",
    "LAYOUT_OTHER_SCREEN_ALERT_FAILURE",
    "LAYOUT_PAGE_COUNT_FAILURE", "LAYOUT_SHEET_COUNT_FAILURE",
    "LAYOUT_RUBY_FAILURE", "LAYOUT_BODY_LAYOUT_FAILURE",
    "AOZORA_REQUEST_OBSERVED", "AOZORA_REQUEST_FAILED_OBSERVED", "AOZORA_HTTP_ERROR_OBSERVED",
    "BROWSER_PAGE_ERROR_OBSERVED", "BROWSER_CONSOLE_ERROR_OBSERVED",
    "NOTO_USAGE_CHECK_START", "NOTO_USAGE_CHECK_SUCCESS", "NOTO_USAGE_CHECK_FAILURE",
    "PDF_GENERATION_START", "PDF_GENERATION_SUCCESS", "PDF_GENERATION_FAILURE",
    "A6_PAGE_COUNT_VALIDATION_START", "A6_PAGE_COUNT_VALIDATION_SUCCESS", "A6_PAGE_COUNT_VALIDATION_FAILURE",
  ];
  const route = await readFile(new URL("../app/api/dev/final-preview-pdf/route.ts", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../lib/local-final-pdf.ts", import.meta.url), "utf8");
  for (const stage of expectedStages) {
    assert.ok(route.includes(stage) || renderer.includes(stage), `missing fixed diagnostic code: ${stage}`);
  }
  assert.match(route, /console\.info\(`\[final-preview-pdf\] \$\{code\}`\)/);
  assert.match(route, /diagnosticCode/);
  assert.match(route, /\{ error: message, diagnosticCode \}/);
  assert.match(route, /rendererFailureCode === null/);
  assert.doesNotMatch(route, /NOTO_SERIF_JP_UNAVAILABLE_MESSAGE,\s*503/);
  assert.doesNotMatch(route, /JSON\.stringify\(error\)|error\.stack|\$\{error\.message\}/);
  assert.match(renderer, /page\.on\("pageerror",/);
  assert.match(renderer, /page\.on\("console",/);
  assert.match(renderer, /page\.on\("request",/);
  assert.match(renderer, /page\.on\("requestfailed",/);
  assert.match(renderer, /page\.on\("response",/);
  assert.match(renderer, /new URL\(request\.url\(\)\)\.pathname/);
  assert.match(renderer, /page\.evaluate\(\(\) => \[\.\.\.document\.querySelectorAll\('\[role="alert"\]'\)\]/);
  assert.doesNotMatch(renderer, /page\.locator\('\[role="alert"\]'\)/);
  assert.doesNotMatch(renderer, /console\.(?:log|info|error)\([^\n]*(?:message\.text|request\.url|error\.message)/);
  assert.match(renderer, /selector: "\.body-content > div"/);
  assert.match(renderer, /const textColumnIndexes = await page\.evaluate/);
  assert.match(renderer, /CSS\.getPlatformFontsForNode/);
  assert.match(renderer, /page\.pdf\(\{\s*preferCSSPageSize: true,\s*printBackground: true,\s*displayHeaderFooter: false,/s);
});

test("D toggle is development-only, starts at serif, and keeps ordinary order PDF on the default path", async () => {
  const [page, renderer, orderPage, oldOrderRoute] = await Promise.all([
    readFile(new URL("../app/final/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-final-pdf.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/order/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dev/order-pdf/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /useState<FinalBodyTypography>\("serif"\)/);
  assert.match(page, /process\.env\.NODE_ENV === "development"/);
  assert.match(page, /開発用・本文書体検証/);
  assert.match(page, /let previewSessionSnapshot = previewSessionSnapshotRef\.current;[\s\S]*?if \(process\.env\.NODE_ENV === "development" && previewSessionSnapshot === null\)[\s\S]*?previewSessionSnapshotRef\.current = previewSessionSnapshot;[\s\S]*?sessionStorage\.removeItem\(FINAL_TYPOGRAPHY_SESSION_KEY\)/);
  assert.match(page, /bodyTypography === "noto-serif-jp" \? '\"Noto Serif JP\", serif' : "serif"/);
  assert.match(page, /works\.map\(\(\{ id, title, author, text \}\)/);
  assert.match(page, /X-Body-Pdf-Page-Count/);
  assert.match(page, /reportedRubyCount <= 0/);
  assert.match(renderer, /bodyTypography = options\.bodyTypography \?\? "serif"/);
  assert.match(renderer, /CSS\.getPlatformFontsForNode/);
  assert.match(renderer, /columnCount !== 16/);
  assert.match(renderer, /count > 40/);
  assert.match(renderer, /writingMode !== "vertical-rl"/);
  assert.match(orderPage, /fetch\("\/api\/dev\/order-pdf"/);
  assert.doesNotMatch(orderPage, /noto-serif-jp|FINAL_TYPOGRAPHY/);
  assert.match(oldOrderRoute, /renderLocalFinalBodyPdf\(input\.book, input\.bodyPdfPageCount\)/);
});

test("font and PDF preview endpoints are fixed to local development and do not touch order services", async () => {
  const [fontRoute, previewRoute, fontClient, config, packageJson] = await Promise.all([
    readFile(new URL("../app/api/dev/final-typography-font/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dev/final-preview-pdf/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/noto-serif-jp-preview.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/final-typography-preview.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(fontRoute, /process\.env\.NODE_ENV !== "development"/);
  assert.match(fontRoute, /requestUrl\.origin !== LOCAL_ORIGIN/);
  assert.match(fontRoute, /request\.headers\.get\("origin"\) !== LOCAL_ORIGIN/);
  assert.match(fontRoute, /request\.headers\.get\("host"\) !== "localhost:3000"/);
  assert.match(fontRoute, /C:\\\\Windows\\\\Fonts\\\\NotoSerifJP-VF\.ttf/);
  assert.doesNotMatch(fontRoute, /request\.url.*font|process\.env\.[A-Z_]+_FONT_PATH/);
  assert.match(fontClient, /method: "POST"/);
  assert.match(fontClient, /new FontFace\(NOTO_SERIF_JP_FONT_FAMILY/);
  assert.match(fontClient, /face\.status !== "loaded"/);
  assert.match(fontClient, /throw new Error\(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE\)/);

  assert.match(previewRoute, /process\.env\.NODE_ENV !== "development"/);
  assert.match(previewRoute, /requestUrl\.origin !== LOCAL_ORIGIN/);
  assert.match(previewRoute, /request\.headers\.get\("origin"\) !== LOCAL_ORIGIN/);
  assert.match(previewRoute, /request\.headers\.get\("host"\) !== "localhost:3000"/);
  assert.match(previewRoute, /parseFinalTypographyPreviewRequest\(raw\)/);
  assert.match(previewRoute, /verifyNotoFontUsage: input\.bodyTypography === "noto-serif-jp"/);
  assert.match(previewRoute, /requireRubyNodes: true/);
  assert.doesNotMatch(previewRoute, /supabase|stripe|createOrder|Storage/i);
  assert.doesNotMatch(previewRoute, /new URL\(.*raw|request\.url.*render/);
  assert.match(config, new RegExp(FINAL_TYPOGRAPHY_SESSION_KEY));
  assert.match(config, new RegExp(FINAL_PRELOADED_WORKS_SESSION_KEY));
  assert.match(config, new RegExp(NOTO_SERIF_JP_FONT_FAMILY));
  assert.ok(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE.includes("C:\\Windows\\Fonts\\NotoSerifJP-VF.ttf"));
  assert.match(packageJson, /"test:final-typography-preview"/);
});
