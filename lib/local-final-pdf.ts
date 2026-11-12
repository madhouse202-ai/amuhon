import { access } from "node:fs/promises";
import { chromium, type Browser } from "playwright-core";

import type { BookData } from "./book.ts";
import {
  FINAL_PRELOADED_WORKS_SESSION_KEY,
  FINAL_TYPOGRAPHY_SESSION_KEY,
  NOTO_SERIF_JP_FONT_FAMILY,
  NOTO_SERIF_JP_UNAVAILABLE_MESSAGE,
  type FinalBodyTypography,
  type FinalPreviewWorkText,
} from "./final-typography-preview.ts";
import {
  resolveFinalPdfRendererConfig,
  type FinalPdfRendererConfig,
} from "./final-pdf-renderer-config.ts";
import { validateBodyPdf } from "./order-assets.ts";

export type LocalFinalPdfResult = {
  pdfBytes: Uint8Array;
  pageCount: number;
  rubyCount: number;
  visualSample?: Uint8Array;
};

export type LocalFinalPdfOptions = {
  includeVisualSample?: boolean;
  requireRubyNodes?: boolean;
  bodyTypography?: FinalBodyTypography;
  preloadedWorks?: FinalPreviewWorkText[];
  verifyNotoFontUsage?: boolean;
  /** Fixed, content-free progress codes for the local typography diagnostic route. */
  onDiagnosticCode?: (code: LocalFinalPdfDiagnosticCode) => void;
};

export const LOCAL_FINAL_PDF_DIAGNOSTIC_CODES = {
  chromiumStart: "CHROMIUM_START",
  chromiumSuccess: "CHROMIUM_SUCCESS",
  chromiumFailure: "CHROMIUM_FAILURE",
  handoffSetupStart: "BODY_HANDOFF_SETUP_START",
  handoffSetupSuccess: "BODY_HANDOFF_SETUP_SUCCESS",
  handoffSetupFailure: "BODY_HANDOFF_SETUP_FAILURE",
  navigationStart: "PAGE_NAVIGATION_START",
  navigationSuccess: "PAGE_NAVIGATION_SUCCESS",
  navigationFailure: "PAGE_NAVIGATION_FAILURE",
  handoffVerifyStart: "BODY_HANDOFF_VERIFY_START",
  handoffVerifySuccess: "BODY_HANDOFF_VERIFY_SUCCESS",
  handoffVerifyFailure: "BODY_HANDOFF_VERIFY_FAILURE",
  layoutStart: "LAYOUT_WAIT_START",
  layoutSuccess: "LAYOUT_WAIT_SUCCESS",
  layoutFailure: "LAYOUT_WAIT_FAILURE",
  layoutWaitTimeoutFailure: "LAYOUT_WAIT_TIMEOUT_FAILURE",
  layoutNotoAlertFailure: "LAYOUT_NOTO_ALERT_FAILURE",
  layoutWorkTextAlertFailure: "LAYOUT_WORK_TEXT_ALERT_FAILURE",
  layoutSnapshotAlertFailure: "LAYOUT_SNAPSHOT_ALERT_FAILURE",
  layoutEmptyBookAlertFailure: "LAYOUT_EMPTY_BOOK_ALERT_FAILURE",
  layoutPageCountRangeAlertFailure: "LAYOUT_PAGE_COUNT_RANGE_ALERT_FAILURE",
  layoutMainScreenAlertFailure: "LAYOUT_MAIN_SCREEN_ALERT_FAILURE",
  layoutTypographyControlAlertFailure: "LAYOUT_TYPOGRAPHY_CONTROL_ALERT_FAILURE",
  layoutOtherScreenAlertFailure: "LAYOUT_OTHER_SCREEN_ALERT_FAILURE",
  layoutPageCountFailure: "LAYOUT_PAGE_COUNT_FAILURE",
  layoutSheetCountFailure: "LAYOUT_SHEET_COUNT_FAILURE",
  layoutRubyFailure: "LAYOUT_RUBY_FAILURE",
  layoutBodyFailure: "LAYOUT_BODY_LAYOUT_FAILURE",
  aozoraRequestObserved: "AOZORA_REQUEST_OBSERVED",
  aozoraRequestFailedObserved: "AOZORA_REQUEST_FAILED_OBSERVED",
  aozoraHttpErrorObserved: "AOZORA_HTTP_ERROR_OBSERVED",
  browserPageErrorObserved: "BROWSER_PAGE_ERROR_OBSERVED",
  browserConsoleErrorObserved: "BROWSER_CONSOLE_ERROR_OBSERVED",
  notoStart: "NOTO_USAGE_CHECK_START",
  notoSuccess: "NOTO_USAGE_CHECK_SUCCESS",
  notoFailure: "NOTO_USAGE_CHECK_FAILURE",
  notoSkipped: "NOTO_USAGE_CHECK_SKIPPED",
  pdfStart: "PDF_GENERATION_START",
  pdfSuccess: "PDF_GENERATION_SUCCESS",
  pdfFailure: "PDF_GENERATION_FAILURE",
  validationStart: "A6_PAGE_COUNT_VALIDATION_START",
  validationSuccess: "A6_PAGE_COUNT_VALIDATION_SUCCESS",
  validationFailure: "A6_PAGE_COUNT_VALIDATION_FAILURE",
} as const;

export type LocalFinalPdfDiagnosticCode =
  (typeof LOCAL_FINAL_PDF_DIAGNOSTIC_CODES)[keyof typeof LOCAL_FINAL_PDF_DIAGNOSTIC_CODES];

type DiagnosticStageCodes = {
  start: LocalFinalPdfDiagnosticCode;
  success: LocalFinalPdfDiagnosticCode;
  failure: LocalFinalPdfDiagnosticCode;
};

function reportDiagnosticCode(
  callback: LocalFinalPdfOptions["onDiagnosticCode"],
  code: LocalFinalPdfDiagnosticCode,
) {
  try {
    callback?.(code);
  } catch {
    // Diagnostics must never affect the generated document.
  }
}

export async function runLocalFinalPdfDiagnosticStage<T>(
  callback: LocalFinalPdfOptions["onDiagnosticCode"],
  codes: DiagnosticStageCodes,
  operation: () => Promise<T>,
): Promise<T> {
  if (!callback) return operation();
  reportDiagnosticCode(callback, codes.start);
  try {
    const result = await operation();
    reportDiagnosticCode(callback, codes.success);
    return result;
  } catch (error) {
    reportDiagnosticCode(callback, codes.failure);
    throw error;
  }
}

export async function findFinalPdfChromiumExecutable(
  config: FinalPdfRendererConfig = resolveFinalPdfRendererConfig(),
): Promise<string> {
  for (const executablePath of config.executableCandidates) {
    try {
      await access(executablePath);
      return executablePath;
    } catch {
      // Only standard local Chrome/Edge installation paths are considered.
    }
  }
  throw new Error("設定された本文PDF用Chromiumを利用できません。");
}

/** Render only the fixed local /final page; no caller-supplied URL, HTML, or file path is accepted. */
export async function renderLocalFinalBodyPdf(
  book: BookData,
  expectedPageCount: number,
  options: LocalFinalPdfOptions = {},
): Promise<LocalFinalPdfResult> {
  const rendererConfig = resolveFinalPdfRendererConfig();
  const bodyTypography = options.bodyTypography ?? "serif";
  if (options.verifyNotoFontUsage && bodyTypography !== "noto-serif-jp") {
    throw new Error("Noto Serif JPの実使用確認にはD版を指定してください。");
  }
  const browserRef: { current: Browser | null } = { current: null };
  try {
    const { context, page } = await runLocalFinalPdfDiagnosticStage(options.onDiagnosticCode, {
      start: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.chromiumStart,
      success: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.chromiumSuccess,
      failure: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.chromiumFailure,
    }, async () => {
      const launchedBrowser = await chromium.launch({
        executablePath: await findFinalPdfChromiumExecutable(rendererConfig),
        headless: true,
      });
      browserRef.current = launchedBrowser;
      const context = await launchedBrowser.newContext({
        viewport: { width: 1440, height: 1000 },
        locale: "ja-JP",
      });
      return { context, page: await context.newPage() };
    });

    const diagnosticsEnabled = options.onDiagnosticCode !== undefined;
    if (diagnosticsEnabled) {
      let pageErrorObserved = false;
      let consoleErrorObserved = false;
      let aozoraRequestObserved = false;
      let aozoraRequestFailedObserved = false;
      let aozoraHttpErrorObserved = false;
      page.on("pageerror", () => {
        if (pageErrorObserved) return;
        pageErrorObserved = true;
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.browserPageErrorObserved);
      });
      page.on("console", (message) => {
        if (message.type() !== "error" || consoleErrorObserved) return;
        consoleErrorObserved = true;
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.browserConsoleErrorObserved);
      });
      page.on("request", (request) => {
        if (aozoraRequestObserved) return;
        try {
          if (new URL(request.url()).pathname !== "/api/aozora") return;
        } catch {
          return;
        }
        aozoraRequestObserved = true;
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.aozoraRequestObserved);
      });
      page.on("requestfailed", (request) => {
        if (aozoraRequestFailedObserved) return;
        try {
          if (new URL(request.url()).pathname !== "/api/aozora") return;
        } catch {
          return;
        }
        aozoraRequestFailedObserved = true;
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.aozoraRequestFailedObserved);
      });
      page.on("response", (response) => {
        if (aozoraHttpErrorObserved || response.status() < 400) return;
        try {
          if (new URL(response.url()).pathname !== "/api/aozora") return;
        } catch {
          return;
        }
        aozoraHttpErrorObserved = true;
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.aozoraHttpErrorObserved);
      });
    }
    await runLocalFinalPdfDiagnosticStage(options.onDiagnosticCode, {
      start: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.handoffSetupStart,
      success: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.handoffSetupSuccess,
      failure: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.handoffSetupFailure,
    }, () => page.addInitScript(({ bookData, renderOrigin, requestedTypography, preloadedWorks, typographySessionKey, preloadedWorksSessionKey, diagnosticsEnabled }) => {
      const originMatched = location.origin === renderOrigin;
      const handoff = diagnosticsEnabled ? {
        originMatched,
        bookStored: false,
        typographyStored: requestedTypography !== "noto-serif-jp",
        preloadedWorksStored: preloadedWorks === null,
      } : null;
      if (originMatched) {
        localStorage.setItem("amuhon-book", JSON.stringify(bookData));
        if (handoff) handoff.bookStored = true;
        if (requestedTypography === "noto-serif-jp") {
          sessionStorage.setItem(typographySessionKey, requestedTypography);
          if (handoff) handoff.typographyStored = true;
        }
        if (preloadedWorks) {
          sessionStorage.setItem(preloadedWorksSessionKey, JSON.stringify(preloadedWorks));
          if (handoff) handoff.preloadedWorksStored = true;
        }
      }
      if (handoff) {
        Object.defineProperty(window, "__amuhonFinalPdfHandoffV1", {
          value: handoff,
          configurable: true,
        });
      }
    }, {
      bookData: book,
      renderOrigin: rendererConfig.renderOrigin,
      requestedTypography: bodyTypography,
      preloadedWorks: options.preloadedWorks ?? null,
      typographySessionKey: FINAL_TYPOGRAPHY_SESSION_KEY,
      preloadedWorksSessionKey: FINAL_PRELOADED_WORKS_SESSION_KEY,
      diagnosticsEnabled,
    }));

    await runLocalFinalPdfDiagnosticStage(options.onDiagnosticCode, {
      start: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.navigationStart,
      success: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.navigationSuccess,
      failure: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.navigationFailure,
    }, async () => {
      const navigationResponse = await page.goto(rendererConfig.renderUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      if (!navigationResponse?.ok()) throw new Error("renderer_navigation_failed");
    });

    if (diagnosticsEnabled) {
      await runLocalFinalPdfDiagnosticStage(options.onDiagnosticCode, {
        start: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.handoffVerifyStart,
        success: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.handoffVerifySuccess,
        failure: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.handoffVerifyFailure,
      }, async () => {
        const handoff = await page.evaluate(() =>
          (window as Window & {
            __amuhonFinalPdfHandoffV1?: {
              originMatched: boolean;
              bookStored: boolean;
              typographyStored: boolean;
              preloadedWorksStored: boolean;
            };
          }).__amuhonFinalPdfHandoffV1 ?? null,
        );
        if (!handoff || !handoff.originMatched || !handoff.bookStored ||
            !handoff.typographyStored || !handoff.preloadedWorksStored) {
          throw new Error("renderer_data_handoff_failed");
        }
      });
    }

    const { rubyCount } = await runLocalFinalPdfDiagnosticStage(options.onDiagnosticCode, {
      start: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutStart,
      success: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutSuccess,
      failure: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutFailure,
    }, async () => {
      try {
        await page.waitForFunction(() => {
          const statuses = [...document.querySelectorAll('[role="status"]')];
          return statuses.some((element) => element.textContent?.includes("実組版結果")) ||
            Boolean(document.querySelector('[role="alert"]'));
        }, null, { timeout: 120_000 });
      } catch {
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutWaitTimeoutFailure);
        throw new Error("composition_wait_timeout");
      }

      const appAlerts = await page.evaluate(() => [...document.querySelectorAll('[role="alert"]')].map((element) => ({
        text: element.textContent ?? "",
        location: element.closest("fieldset") ? "typography" : element.closest("main") ? "main" : "other",
      })));
      const alertText = appAlerts.map((alert) => alert.text);
      if (alertText.some((text) => text.includes("Noto Serif JPの開発用フォント"))) {
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutNotoAlertFailure);
        throw new Error(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE);
      }
      if (alertText.some((text) => text.includes("本文を取得できなかった作品"))) {
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutWorkTextAlertFailure);
        throw new Error("selected_work_text_unavailable");
      }
      if (alertText.some((text) => text.includes("検証用の本文スナップショットが選択作品と一致しません"))) {
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutSnapshotAlertFailure);
        throw new Error("preview_snapshot_mismatch");
      }
      if (alertText.some((text) => text.includes("本に作品がありません"))) {
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutEmptyBookAlertFailure);
        throw new Error("empty_book_alert");
      }
      if (alertText.some((text) => text.includes("標準入稿データは、末尾白紙を含め"))) {
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutPageCountRangeAlertFailure);
        throw new Error("page_count_range_alert");
      }
      if (alertText.length > 0) {
        const alertLocations = appAlerts.map((alert) => alert.location);
        const alertCode = alertLocations.includes("typography")
          ? LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutTypographyControlAlertFailure
          : alertLocations.includes("main")
            ? LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutMainScreenAlertFailure
            : LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutOtherScreenAlertFailure;
        reportDiagnosticCode(options.onDiagnosticCode, alertCode);
        throw new Error("composition_alert_observed");
      }
      const status = await page.locator('[role="status"]')
        .filter({ hasText: "実組版結果" })
        .first()
        .innerText();
      const match = /本文PDF\s*(\d+)\s*ページ/.exec(status);
      const composedPageCount = match ? Number(match[1]) : NaN;
      if (composedPageCount !== expectedPageCount) {
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutPageCountFailure);
        throw new Error("composed_page_count_mismatch");
      }

      const sheets = await page.locator(".print-sheet").count();
      if (sheets !== expectedPageCount + 2) {
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutSheetCountFailure);
        throw new Error("print_sheet_count_mismatch");
      }
      const rubyCount = await page.locator(".print-character-cell__ruby").count();
      if (options.requireRubyNodes && rubyCount === 0) {
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutRubyFailure);
        throw new Error("ruby_nodes_missing");
      }

      if (options.preloadedWorks) {
        const bodyLayouts = await page.locator(".body-content").evaluateAll((elements) => elements.map((element) => {
          const columns = Array.from(element.children);
          const firstColumn = columns[0] as HTMLElement | undefined;
          const firstStyle = firstColumn ? getComputedStyle(firstColumn) : null;
          return {
            typography: element.getAttribute("data-body-typography"),
            columnCount: columns.length,
            writingMode: firstStyle?.writingMode ?? "",
            textOrientation: firstStyle?.textOrientation ?? "",
            fontFamily: firstStyle?.fontFamily ?? "",
            overflowColumns: columns.filter((column) => {
              const count = Array.from(column.querySelectorAll<HTMLElement>(".print-character-cell"))
                .reduce((sum, cell) => sum + Number(cell.dataset.unitCharacterCount), 0);
              return !Number.isFinite(count) || count > 40;
            }).length,
          };
        }));
        if (bodyLayouts.length === 0 || bodyLayouts.some((layout) =>
          layout.columnCount !== 16 || layout.overflowColumns !== 0 ||
          layout.writingMode !== "vertical-rl" || layout.textOrientation !== "mixed" ||
          layout.typography !== bodyTypography)) {
          reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutBodyFailure);
          throw new Error("body_layout_mismatch");
        }
      }

      return { rubyCount };
    });

    if (options.verifyNotoFontUsage) {
      await runLocalFinalPdfDiagnosticStage(options.onDiagnosticCode, {
        start: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.notoStart,
        success: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.notoSuccess,
        failure: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.notoFailure,
      }, async () => {
        const session = await context.newCDPSession(page);
        try {
          await session.send("DOM.enable");
          await session.send("CSS.enable");
          const { root } = await session.send("DOM.getDocument");
          const { nodeIds } = await session.send("DOM.querySelectorAll", {
            nodeId: root.nodeId,
            selector: ".body-content > div",
          });
          const textColumnIndexes = await page.evaluate(() => [...document.querySelectorAll(".body-content > div")]
            .map((column, index) => Array.from(column.querySelectorAll<HTMLElement>(".print-character-cell"))
              .some((cell) => Number(cell.dataset.unitCharacterCount) > 0) ? index : -1)
            .filter((index) => index >= 0));
          if (!nodeIds.length || !textColumnIndexes.length || textColumnIndexes.some((index) => index >= nodeIds.length)) {
            throw new Error(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE);
          }
          const expectedNotoName = NOTO_SERIF_JP_FONT_FAMILY.replaceAll(" ", "").toLowerCase();
          for (const columnIndex of textColumnIndexes) {
            const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId: nodeIds[columnIndex] });
            const usedFonts = (fonts as Array<{ familyName?: string; postScriptName?: string; glyphCount?: number; isCustomFont?: boolean }>)
              .filter((font) => Number(font.glyphCount) > 0);
            const allNoto = usedFonts.length > 0 && usedFonts.every((font) => {
              const normalizedName = `${font.familyName ?? ""}${font.postScriptName ?? ""}`
                .replaceAll(" ", "")
                .toLowerCase();
              return normalizedName.includes(expectedNotoName) && font.isCustomFont === true;
            });
            if (!allNoto) throw new Error(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE);
          }
        } finally {
          await session.detach();
        }
      });
    } else {
      reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.notoSkipped);
    }

    const { pdfBytes, visualSample } = await runLocalFinalPdfDiagnosticStage(options.onDiagnosticCode, {
      start: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.pdfStart,
      success: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.pdfSuccess,
      failure: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.pdfFailure,
    }, async () => {
      await page.locator(".print-root").evaluate((element) => element.classList.add("print-root--body-only"));
      await page.emulateMedia({ media: "print" });
      await page.evaluate(() => document.fonts.ready.then(() => true));

      let visualSample: Uint8Array | undefined;
      if (options.includeVisualSample) {
        const rubyPage = page.locator(".print-character-cell__ruby").first()
          .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' print-sheet ')][1]");
        visualSample = await rubyPage.screenshot();
      }

      const pdfBytes = new Uint8Array(await page.pdf({
        preferCSSPageSize: true,
        printBackground: true,
        displayHeaderFooter: false,
      }));
      return { pdfBytes, visualSample };
    });

    const validated = await runLocalFinalPdfDiagnosticStage(options.onDiagnosticCode, {
      start: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.validationStart,
      success: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.validationSuccess,
      failure: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.validationFailure,
    }, async () => {
      const result = await validateBodyPdf(pdfBytes);
      if (result.pageCount !== expectedPageCount) {
        throw new Error("validated_page_count_mismatch");
      }
      return result;
    });
    return { pdfBytes, pageCount: validated.pageCount, rubyCount, visualSample };
  } finally {
    if (browserRef.current) await browserRef.current.close();
  }
}
