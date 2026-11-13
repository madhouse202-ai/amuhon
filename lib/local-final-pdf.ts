import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { chromium, type Browser } from "playwright-core";

import type { BookData } from "./book.ts";
import {
  FINAL_PRELOADED_WORKS_SESSION_KEY,
  FINAL_TYPOGRAPHY_SESSION_KEY,
  NOTO_SERIF_JP_UNAVAILABLE_MESSAGE,
  NOTO_SERIF_JP_FONT_SHA256,
  NOTO_SERIF_JP_FONT_SIZE_BYTES,
  type FinalBodyTypography,
  type FinalPreviewWorkText,
} from "./final-typography-preview.ts";
import { isNotoSerifJpRenderedFont } from "./noto-serif-jp-preview.ts";
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
  /** Exact pinned font bytes for the isolated production renderer container. */
  notoFontBytes?: Uint8Array;
  /** Prevent the print browser from making non-local requests (requires preloaded work text). */
  blockExternalRequests?: boolean;
  /** Bound the whole browser session; the browser is closed when the deadline fires. */
  timeoutMs?: number;
  verifyNotoFontUsage?: boolean;
  /** Fixed, content-free progress codes for the local typography diagnostic route. */
  onDiagnosticCode?: (code: LocalFinalPdfDiagnosticCode) => void;
  /** Counts only; never includes work text, URLs, or raw platform-font details. */
  onNotoDiagnosticCounts?: (counts: LocalFinalPdfNotoDiagnosticCounts) => void;
  /** Bounded localhost-only evidence; contains code points and sanitized family names, never text. */
  onNotoDiagnosticDetails?: (details: LocalFinalPdfNotoDiagnosticDetails) => void;
};

export type LocalFinalPdfNotoDiagnosticCounts = {
  bodyGlyphCellCount: number;
  nonEmptyRubyNodeCount: number;
  glyphTextColumnCount: number;
  kanjiCellCount: number;
  hiraganaCellCount: number;
  punctuationCellCount: number;
  inspectedNodeCount: number;
  emptyFontReportCount: number;
  fallbackFontNodeCount: number;
};

export type LocalFinalPdfNotoCategory = "kanji" | "hiragana" | "katakana" | "punctuation" | "other";
export type LocalFinalPdfNotoInspectionKind = "column" | "body-cell" | "ruby";

export type LocalFinalPdfNotoFallbackFont = {
  family: string;
  glyphCount: number;
};

export type LocalFinalPdfNotoFallbackRoot = {
  kind: LocalFinalPdfNotoInspectionKind;
  index: number;
  columnIndex: number;
  categories: LocalFinalPdfNotoCategory[];
  fallbackFonts: LocalFinalPdfNotoFallbackFont[];
};

export type LocalFinalPdfNotoFallbackTextNode = {
  kind: "body-cell" | "ruby";
  columnIndex: number;
  categories: LocalFinalPdfNotoCategory[];
  codePoints: string[];
  codePointCount: number;
  truncated: boolean;
  computedFontFamily: string;
  cssFamilyIncludesNoto: boolean | null;
  fallbackFonts: LocalFinalPdfNotoFallbackFont[];
  observedBy: Array<Pick<LocalFinalPdfNotoFallbackRoot, "kind" | "index" | "columnIndex">>;
};

export type LocalFinalPdfNotoDiagnosticDetails = {
  expectedNodeCount: number;
  fallbackRootCount: number;
  fallbackColumnRootCount: number;
  fallbackBodyCellRootCount: number;
  fallbackRubyRootCount: number;
  uniqueFallbackTextNodeCount: number;
  textNodesObservedByMultipleRoots: number;
  leafScanComplete: boolean;
  emptyLeafFontReportCount: number;
  omittedFallbackRootCount: number;
  omittedFallbackTextNodeCount: number;
  fallbackRoots: LocalFinalPdfNotoFallbackRoot[];
  fallbackTextNodes: LocalFinalPdfNotoFallbackTextNode[];
};

const NOTO_DIAGNOSTIC_DETAIL_LIMIT = 24;
const NOTO_DIAGNOSTIC_CODE_POINT_LIMIT = 12;

function hasNotoDiagnosticGlyphText(value: string): boolean {
  return /[^\s\u200B\uFEFF]/u.test(value);
}

function classifyNotoDiagnosticText(value: string): LocalFinalPdfNotoCategory[] {
  const categories = new Set<LocalFinalPdfNotoCategory>();
  for (const character of value) {
    if (/\p{Script=Han}/u.test(character)) categories.add("kanji");
    else if (/\p{Script=Hiragana}/u.test(character)) categories.add("hiragana");
    else if (/\p{Script=Katakana}/u.test(character)) categories.add("katakana");
    else if (/[、。，．！？「」『』（）［］…・：；ー]/u.test(character)) categories.add("punctuation");
    else if (hasNotoDiagnosticGlyphText(character)) categories.add("other");
  }
  return [...categories];
}

function sanitizeNotoDiagnosticFontFamily(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[\\/:<>\u0000-\u001F]/g, " ");
  return normalized.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().replace(/\s+/g, " ").slice(0, 64) || "OTHER_FONT";
}

function safeNotoFallbackFonts(
  fonts: Array<{ familyName?: string; glyphCount?: number }>,
): LocalFinalPdfNotoFallbackFont[] {
  return fonts
    .filter((font) => Number(font.glyphCount) > 0)
    .map((font) => ({
      family: sanitizeNotoDiagnosticFontFamily(font.familyName ?? ""),
      glyphCount: Number.isSafeInteger(font.glyphCount) && Number(font.glyphCount) > 0
        ? Math.min(Number(font.glyphCount), 1_000_000)
        : 0,
    }));
}

export function createNotoFallbackTextNodeSample(input: {
  kind: "body-cell" | "ruby";
  columnIndex: number;
  text: string;
  fallbackFonts: Array<{ familyName?: string; glyphCount?: number }>;
  computedFontFamily: string | null;
  observedBy: Array<Pick<LocalFinalPdfNotoFallbackRoot, "kind" | "index" | "columnIndex">>;
}): LocalFinalPdfNotoFallbackTextNode {
  const characters = Array.from(input.text).filter(hasNotoDiagnosticGlyphText);
  const codePoints = characters.slice(0, NOTO_DIAGNOSTIC_CODE_POINT_LIMIT)
    .map((character) => `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
  return {
    kind: input.kind,
    columnIndex: Math.max(0, Math.trunc(input.columnIndex)),
    categories: classifyNotoDiagnosticText(characters.join("")),
    codePoints,
    codePointCount: characters.length,
    truncated: characters.length > codePoints.length,
    computedFontFamily: sanitizeNotoDiagnosticFontFamily(input.computedFontFamily ?? "UNKNOWN"),
    cssFamilyIncludesNoto: input.computedFontFamily === null
      ? null
      : input.computedFontFamily.replace(/["'\s]/g, "").toLowerCase().includes("notoserifjp"),
    fallbackFonts: safeNotoFallbackFonts(input.fallbackFonts),
    observedBy: input.observedBy.slice(0, 8).map((root) => ({
      kind: root.kind,
      index: Math.max(0, Math.trunc(root.index)),
      columnIndex: Math.max(0, Math.trunc(root.columnIndex)),
    })),
  };
}

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
  notoFontReadinessSuccess: "NOTO_FONT_READINESS_SUCCESS",
  notoFontReadinessFailure: "NOTO_FONT_READINESS_FAILURE",
  notoBodyColumnsEmptyFailure: "NOTO_BODY_COLUMNS_EMPTY_FAILURE",
  notoCdpFontsEmptyFailure: "NOTO_CDP_FONTS_EMPTY_FAILURE",
  notoFallbackFontFailure: "NOTO_FALLBACK_FONT_FAILURE",
  notoInspectionExceptionFailure: "NOTO_CHECK_EXCEPTION_FAILURE",
  pdfStart: "PDF_GENERATION_START",
  pdfSuccess: "PDF_GENERATION_SUCCESS",
  pdfFailure: "PDF_GENERATION_FAILURE",
  validationStart: "A6_PAGE_COUNT_VALIDATION_START",
  validationSuccess: "A6_PAGE_COUNT_VALIDATION_SUCCESS",
  validationFailure: "A6_PAGE_COUNT_VALIDATION_FAILURE",
} as const;

export type LocalFinalPdfDiagnosticCode =
  (typeof LOCAL_FINAL_PDF_DIAGNOSTIC_CODES)[keyof typeof LOCAL_FINAL_PDF_DIAGNOSTIC_CODES];

export function classifyNotoFontUsageFailure(
  fontSetReady: boolean,
  counts: Pick<LocalFinalPdfNotoDiagnosticCounts,
    "glyphTextColumnCount" | "inspectedNodeCount" | "emptyFontReportCount" | "fallbackFontNodeCount">,
): LocalFinalPdfDiagnosticCode | null {
  if (!fontSetReady) return LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.notoFontReadinessFailure;
  if (counts.glyphTextColumnCount === 0) return LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.notoBodyColumnsEmptyFailure;
  if (counts.inspectedNodeCount === 0 || counts.emptyFontReportCount > 0) {
    return LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.notoCdpFontsEmptyFailure;
  }
  if (counts.fallbackFontNodeCount > 0) return LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.notoFallbackFontFailure;
  return null;
}

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

function reportNotoDiagnosticCounts(
  callback: LocalFinalPdfOptions["onNotoDiagnosticCounts"],
  counts: LocalFinalPdfNotoDiagnosticCounts,
) {
  try {
    callback?.({
      bodyGlyphCellCount: counts.bodyGlyphCellCount,
      nonEmptyRubyNodeCount: counts.nonEmptyRubyNodeCount,
      glyphTextColumnCount: counts.glyphTextColumnCount,
      kanjiCellCount: counts.kanjiCellCount,
      hiraganaCellCount: counts.hiraganaCellCount,
      punctuationCellCount: counts.punctuationCellCount,
      inspectedNodeCount: counts.inspectedNodeCount,
      emptyFontReportCount: counts.emptyFontReportCount,
      fallbackFontNodeCount: counts.fallbackFontNodeCount,
    });
  } catch {
    // Safe numeric diagnostics must never affect PDF generation.
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
  expectedPageCount: number | null,
  options: LocalFinalPdfOptions = {},
): Promise<LocalFinalPdfResult> {
  const rendererConfig = resolveFinalPdfRendererConfig();
  const bodyTypography = options.bodyTypography ?? "serif";
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 300_000) {
    throw new Error("本文PDFレンダラーの制限時間設定が不正です。");
  }
  if (options.blockExternalRequests && !options.preloadedWorks) {
    throw new Error("外部通信を禁止するレンダリングには本文スナップショットが必要です。");
  }
  if (options.notoFontBytes) {
    const fontHash = createHash("sha256").update(options.notoFontBytes).digest("hex").toUpperCase();
    if (bodyTypography !== "noto-serif-jp" || !options.verifyNotoFontUsage ||
        options.notoFontBytes.byteLength !== NOTO_SERIF_JP_FONT_SIZE_BYTES ||
        fontHash !== NOTO_SERIF_JP_FONT_SHA256 ||
        Buffer.from(options.notoFontBytes.subarray(0, 4)).toString("ascii") !== "OTTO") {
      throw new Error(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE);
    }
  }
  if (options.verifyNotoFontUsage && bodyTypography !== "noto-serif-jp") {
    throw new Error("Noto Serif JPの実使用確認にはD版を指定してください。");
  }
  const browserRef: { current: Browser | null } = { current: null };
  let browserTimeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const { context, page } = await runLocalFinalPdfDiagnosticStage(options.onDiagnosticCode, {
      start: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.chromiumStart,
      success: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.chromiumSuccess,
      failure: LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.chromiumFailure,
    }, async () => {
      const launchedBrowser = await chromium.launch({
        executablePath: await findFinalPdfChromiumExecutable(rendererConfig),
        headless: true,
        timeout: Math.min(timeoutMs, 30_000),
      });
      browserRef.current = launchedBrowser;
      browserTimeout = setTimeout(() => {
        void launchedBrowser.close().catch(() => undefined);
      }, timeoutMs);
      const context = await launchedBrowser.newContext({
        viewport: { width: 1440, height: 1000 },
        locale: "ja-JP",
      });
      const page = await context.newPage();
      if (options.blockExternalRequests) {
        await page.route("**/*", async (route) => {
          let requestUrl: URL;
          try {
            requestUrl = new URL(route.request().url());
          } catch {
            await route.abort("blockedbyclient");
            return;
          }
          if (requestUrl.origin !== rendererConfig.renderOrigin) {
            await route.abort("blockedbyclient");
            return;
          }
          if (requestUrl.pathname.startsWith("/api/")) {
            if (requestUrl.pathname === "/api/dev/final-typography-font" &&
                route.request().method() === "POST" && options.notoFontBytes) {
              await route.fulfill({
                status: 200,
                contentType: "font/otf",
                headers: {
                  "Cache-Control": "no-store",
                  "X-Content-Type-Options": "nosniff",
                },
                body: Buffer.from(options.notoFontBytes.buffer, options.notoFontBytes.byteOffset, options.notoFontBytes.byteLength),
              });
              return;
            }
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
        });
      }
      return { context, page };
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
    }, () => page.addInitScript(({ bookData, renderOrigin, requestedTypography, preloadedWorks, typographySessionKey, preloadedWorksSessionKey, diagnosticsEnabled, rendererFontAvailable }) => {
      const originMatched = location.origin === renderOrigin;
      if (originMatched && rendererFontAvailable) {
        Object.defineProperty(window, "__AMUHON_PDF_RENDERER_V1__", {
          value: true,
          configurable: false,
        });
      }
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
      rendererFontAvailable: Boolean(options.notoFontBytes),
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
          return document.querySelector('main.print-root[data-final-layout-ready="true"]') !== null ||
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
      const layoutRoot = page.locator("main.print-root");
      const layoutReady = await layoutRoot.getAttribute("data-final-layout-ready");
      const pageCountValue = await layoutRoot.getAttribute("data-submission-page-count");
      const composedPageCount = pageCountValue !== null && /^\d+$/.test(pageCountValue)
        ? Number(pageCountValue)
        : NaN;
      if (layoutReady !== "true") {
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutFailure);
        throw new Error("composition_not_ready");
      }
      if (!Number.isSafeInteger(composedPageCount) || composedPageCount <= 0 ||
          (expectedPageCount !== null && composedPageCount !== expectedPageCount)) {
        reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.layoutPageCountFailure);
        throw new Error("composed_page_count_mismatch");
      }

      const sheets = await page.locator(".print-sheet").count();
      if (sheets !== composedPageCount + 2) {
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
        let session: Awaited<ReturnType<typeof context.newCDPSession>> | null = null;
        const counts: LocalFinalPdfNotoDiagnosticCounts = {
          bodyGlyphCellCount: 0,
          nonEmptyRubyNodeCount: 0,
          glyphTextColumnCount: 0,
          kanjiCellCount: 0,
          hiraganaCellCount: 0,
          punctuationCellCount: 0,
          inspectedNodeCount: 0,
          emptyFontReportCount: 0,
          fallbackFontNodeCount: 0,
        };
        let specificFailureCode: LocalFinalPdfDiagnosticCode | null = null;
        let countsAvailable = false;
        const refuse = (code: LocalFinalPdfDiagnosticCode): never => {
          specificFailureCode = code;
          reportDiagnosticCode(options.onDiagnosticCode, code);
          if (countsAvailable) reportNotoDiagnosticCounts(options.onNotoDiagnosticCounts, counts);
          throw new Error(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE);
        };
        try {
          const activeSession = await context.newCDPSession(page);
          session = activeSession;
          const fontSetReady = await page.evaluate(async () => {
            await document.fonts.ready;
            const family = "Noto Serif JP";
            const sample = "漢あ、。縦書き「ルビ」";
            const loadedFaces = await document.fonts.load(`8.5pt "${family}"`, sample);
            const isNoto = (face: FontFace) => {
              const normalized = face.family.replace(/[\"']/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
              return normalized === "notoserifjp" || normalized === "notoserifcjkJP".toLowerCase();
            };
            const registeredFaceReady = [...document.fonts]
              .some((face) => isNoto(face) && face.status === "loaded");
            const sampleFaceReady = loadedFaces
              .some((face) => isNoto(face) && face.status === "loaded");
            return document.fonts.status === "loaded" && registeredFaceReady && sampleFaceReady &&
              document.fonts.check(`8.5pt "${family}"`, sample);
          });
          if (!fontSetReady) refuse(LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.notoFontReadinessFailure);
          reportDiagnosticCode(options.onDiagnosticCode, LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.notoFontReadinessSuccess);

          const targets = await page.evaluate(() => {
            const hasGlyphText = (value: string) => /[^\s\u200B\uFEFF]/u.test(value);
            const classifyText = (value: string) => {
              const categories = new Set<string>();
              for (const character of value) {
                if (/\p{Script=Han}/u.test(character)) categories.add("kanji");
                else if (/\p{Script=Hiragana}/u.test(character)) categories.add("hiragana");
                else if (/\p{Script=Katakana}/u.test(character)) categories.add("katakana");
                else if (/[、。，．！？「」『』（）［］…・：；ー]/u.test(character)) categories.add("punctuation");
                else if (hasGlyphText(character)) categories.add("other");
              }
              return [...categories];
            };
            const directText = (element: Element) => Array.from(element.childNodes)
              .filter((node) => node.nodeType === Node.TEXT_NODE)
              .map((node) => node.nodeValue ?? "")
              .join("");
            const cells = [...document.querySelectorAll(".print-character-cell")];
            const rubyNodes = [...document.querySelectorAll(".print-character-cell__ruby")];
            const cellText = cells.map(directText);
            const hasRubyGlyph = (cell: Element) => [...cell.querySelectorAll(".print-character-cell__ruby")]
              .some((ruby) => hasGlyphText(ruby.textContent ?? ""));
            const columns = [...document.querySelectorAll(".body-content > div")];
            const categoryIndexes = {
              kanji: cellText.findIndex((text) => hasGlyphText(text) && /\p{Script=Han}/u.test(text)),
              hiragana: cellText.findIndex((text) => hasGlyphText(text) && /\p{Script=Hiragana}/u.test(text)),
              punctuation: cellText.findIndex((text) => hasGlyphText(text) && /[、。，．！？「」『』（）［］…・：；ー]/u.test(text)),
            };
            const nonEmptyRubyIndexes = rubyNodes
              .map((ruby, index) => hasGlyphText(ruby.textContent ?? "") ? index : -1)
              .filter((index) => index >= 0);
            const glyphColumnIndexes = columns
              .map((column, index) => [...column.querySelectorAll(".print-character-cell")]
                .some((cell) => hasGlyphText(directText(cell)) || hasRubyGlyph(cell)) ? index : -1)
              .filter((index) => index >= 0);
            const columnCategories = columns.map((column) => classifyText(
              [...column.querySelectorAll(".print-character-cell")]
                .map((cell) => `${directText(cell)} ${[...cell.querySelectorAll(".print-character-cell__ruby")]
                  .map((ruby) => ruby.textContent ?? "").join(" ")}`)
                .join(" "),
            ));
            return {
              bodyGlyphCellCount: cellText.filter(hasGlyphText).length,
              nonEmptyRubyNodeCount: nonEmptyRubyIndexes.length,
              glyphColumnIndexes,
              kanjiCellCount: cellText.filter((text) => hasGlyphText(text) && /\p{Script=Han}/u.test(text)).length,
              hiraganaCellCount: cellText.filter((text) => hasGlyphText(text) && /\p{Script=Hiragana}/u.test(text)).length,
              punctuationCellCount: cellText.filter((text) => hasGlyphText(text) && /[、。，．！？「」『』（）［］…・：；ー]/u.test(text)).length,
              representativeCellIndexes: Object.values(categoryIndexes).filter((index) => index >= 0),
              representativeRubyIndex: nonEmptyRubyIndexes[0] ?? -1,
              cellCategories: cellText.map(classifyText),
              cellColumnIndexes: cells.map((cell) => columns.findIndex((column) => column.contains(cell))),
              rubyCategories: rubyNodes.map((ruby) => classifyText(ruby.textContent ?? "")),
              rubyColumnIndexes: rubyNodes.map((ruby) => columns.findIndex((column) => column.contains(ruby))),
              columnCategories,
              cellCount: cells.length,
              rubyNodeCount: rubyNodes.length,
              columnCount: columns.length,
            };
          });
          counts.bodyGlyphCellCount = targets.bodyGlyphCellCount;
          counts.nonEmptyRubyNodeCount = targets.nonEmptyRubyNodeCount;
          counts.glyphTextColumnCount = targets.glyphColumnIndexes.length;
          counts.kanjiCellCount = targets.kanjiCellCount;
          counts.hiraganaCellCount = targets.hiraganaCellCount;
          counts.punctuationCellCount = targets.punctuationCellCount;
          countsAvailable = true;
          if (counts.glyphTextColumnCount === 0) {
            refuse(LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.notoBodyColumnsEmptyFailure);
          }

          await activeSession.send("DOM.enable");
          await activeSession.send("CSS.enable");
          const { root } = await activeSession.send("DOM.getDocument", { depth: -1, pierce: true });
          const { nodeIds: columnNodeIds } = await activeSession.send("DOM.querySelectorAll", {
            nodeId: root.nodeId,
            selector: ".body-content > div",
          });
          const { nodeIds: cellNodeIds } = await activeSession.send("DOM.querySelectorAll", {
            nodeId: root.nodeId,
            selector: ".print-character-cell",
          });
          const { nodeIds: rubyNodeIds } = await activeSession.send("DOM.querySelectorAll", {
            nodeId: root.nodeId,
            selector: ".print-character-cell__ruby",
          });
          if (columnNodeIds.length !== targets.columnCount || cellNodeIds.length !== targets.cellCount ||
              rubyNodeIds.length !== targets.rubyNodeCount ||
              targets.glyphColumnIndexes.some((index) => index >= columnNodeIds.length) ||
              targets.representativeCellIndexes.some((index) => index >= cellNodeIds.length) ||
              targets.representativeCellIndexes.some((index) => targets.cellColumnIndexes[index] < 0) ||
              (targets.representativeRubyIndex >= 0 && targets.rubyColumnIndexes[targets.representativeRubyIndex] < 0) ||
              targets.representativeRubyIndex >= rubyNodeIds.length) {
            throw new Error("noto_dom_target_mismatch");
          }

          type InspectionTarget = {
            nodeId: number;
            kind: LocalFinalPdfNotoInspectionKind;
            index: number;
            columnIndex: number;
            categories: LocalFinalPdfNotoCategory[];
          };
          const inspectionTargets = new Map<number, InspectionTarget>();
          for (const index of targets.glyphColumnIndexes) {
            inspectionTargets.set(columnNodeIds[index], {
              nodeId: columnNodeIds[index], kind: "column", index, columnIndex: index,
              categories: targets.columnCategories[index] as LocalFinalPdfNotoCategory[],
            });
          }
          for (const index of targets.representativeCellIndexes) {
            inspectionTargets.set(cellNodeIds[index], {
              nodeId: cellNodeIds[index], kind: "body-cell", index, columnIndex: targets.cellColumnIndexes[index],
              categories: targets.cellCategories[index] as LocalFinalPdfNotoCategory[],
            });
          }
          if (targets.representativeRubyIndex >= 0) {
            inspectionTargets.set(rubyNodeIds[targets.representativeRubyIndex], {
              nodeId: rubyNodeIds[targets.representativeRubyIndex], kind: "ruby",
              index: targets.representativeRubyIndex, columnIndex: targets.rubyColumnIndexes[targets.representativeRubyIndex],
              categories: targets.rubyCategories[targets.representativeRubyIndex] as LocalFinalPdfNotoCategory[],
            });
          }
          const fallbackRoots: LocalFinalPdfNotoFallbackRoot[] = [];
          const failedRootTargets = new Map<number, LocalFinalPdfNotoFallbackRoot>();
          const isNotoUsedFont = isNotoSerifJpRenderedFont;
          for (const target of inspectionTargets.values()) {
            const { fonts } = await activeSession.send("CSS.getPlatformFontsForNode", { nodeId: target.nodeId });
            const usedFonts = (fonts as Array<{ familyName?: string; postScriptName?: string; glyphCount?: number; isCustomFont?: boolean }>)
              .filter((font) => Number(font.glyphCount) > 0);
            counts.inspectedNodeCount += 1;
            if (usedFonts.length === 0) {
              counts.emptyFontReportCount += 1;
              continue;
            }
            const fallbackFonts = usedFonts.filter((font) => !isNotoUsedFont(font));
            if (fallbackFonts.length > 0) {
              counts.fallbackFontNodeCount += 1;
              const safeRoot: LocalFinalPdfNotoFallbackRoot = {
                kind: target.kind,
                index: target.index,
                columnIndex: target.columnIndex,
                categories: target.categories,
                fallbackFonts: safeNotoFallbackFonts(fallbackFonts),
              };
              fallbackRoots.push(safeRoot);
              failedRootTargets.set(target.nodeId, safeRoot);
            }
          }

          if (counts.fallbackFontNodeCount > 0) {
            const details: LocalFinalPdfNotoDiagnosticDetails = {
              expectedNodeCount: inspectionTargets.size,
              fallbackRootCount: fallbackRoots.length,
              fallbackColumnRootCount: fallbackRoots.filter((root) => root.kind === "column").length,
              fallbackBodyCellRootCount: fallbackRoots.filter((root) => root.kind === "body-cell").length,
              fallbackRubyRootCount: fallbackRoots.filter((root) => root.kind === "ruby").length,
              uniqueFallbackTextNodeCount: 0,
              textNodesObservedByMultipleRoots: 0,
              leafScanComplete: false,
              emptyLeafFontReportCount: 0,
              omittedFallbackRootCount: Math.max(0, fallbackRoots.length - NOTO_DIAGNOSTIC_DETAIL_LIMIT),
              omittedFallbackTextNodeCount: 0,
              fallbackRoots: fallbackRoots.slice(0, NOTO_DIAGNOSTIC_DETAIL_LIMIT),
              fallbackTextNodes: [],
            };
            try {
              type CdpNode = {
                nodeId?: number;
                nodeType?: number;
                nodeName?: string;
                nodeValue?: string;
                attributes?: string[];
                children?: CdpNode[];
                shadowRoots?: CdpNode[];
                contentDocument?: CdpNode;
                templateContent?: CdpNode;
              };
              const fullDocument = root as CdpNode;
              const columnByNodeId = new Map(columnNodeIds.map((nodeId, index) => [nodeId, index]));
              const leafCandidates = new Map<number, {
                nodeId: number;
                parentElementNodeId: number;
                kind: "body-cell" | "ruby";
                columnIndex: number;
                text: string;
                observedBy: Array<Pick<LocalFinalPdfNotoFallbackRoot, "kind" | "index" | "columnIndex">>;
              }>();
              const hasGlyphText = (value: string) => /[^\s\u200B\uFEFF]/u.test(value);
              const visit = (
                node: CdpNode,
                context: { columnIndex: number; inBodyCell: boolean; inRuby: boolean; parentElementNodeId: number; roots: LocalFinalPdfNotoFallbackRoot[] },
              ) => {
                const nodeId = Number(node.nodeId ?? 0);
                const next = { ...context, roots: [...context.roots] };
                if (columnByNodeId.has(nodeId)) next.columnIndex = columnByNodeId.get(nodeId)!;
                if (node.nodeType === 1) {
                  const attrs = node.attributes ?? [];
                  const classIndex = attrs.indexOf("class");
                  const classes = classIndex >= 0 ? new Set((attrs[classIndex + 1] ?? "").split(/\s+/u)) : new Set<string>();
                  next.inBodyCell ||= classes.has("print-character-cell");
                  next.inRuby ||= classes.has("print-character-cell__ruby");
                  next.parentElementNodeId = nodeId;
                  const failedRoot = failedRootTargets.get(nodeId);
                  if (failedRoot) next.roots.push(failedRoot);
                } else if (node.nodeType === 3 && next.roots.length > 0 && next.inBodyCell &&
                    nodeId > 0 && hasGlyphText(node.nodeValue ?? "")) {
                  const existing = leafCandidates.get(nodeId);
                  if (existing) {
                    for (const rootSample of next.roots) {
                      if (!existing.observedBy.some((item) => item.kind === rootSample.kind && item.index === rootSample.index)) {
                        existing.observedBy.push({ kind: rootSample.kind, index: rootSample.index, columnIndex: rootSample.columnIndex });
                      }
                    }
                  } else {
                    leafCandidates.set(nodeId, {
                      nodeId,
                      parentElementNodeId: next.parentElementNodeId,
                      kind: next.inRuby ? "ruby" : "body-cell",
                      columnIndex: next.columnIndex,
                      text: node.nodeValue ?? "",
                      observedBy: next.roots.map((item) => ({ kind: item.kind, index: item.index, columnIndex: item.columnIndex })),
                    });
                  }
                }
                for (const child of node.children ?? []) visit(child, next);
                for (const child of node.shadowRoots ?? []) visit(child, next);
                if (node.contentDocument) visit(node.contentDocument, next);
                if (node.templateContent) visit(node.templateContent, next);
              };
              visit(fullDocument, { columnIndex: -1, inBodyCell: false, inRuby: false, parentElementNodeId: 0, roots: [] });
              const candidateValues = [...leafCandidates.values()];
              const maxLeafScan = 4096;
              const scannedCandidates = candidateValues.slice(0, maxLeafScan);
              details.leafScanComplete = candidateValues.length <= maxLeafScan;
              details.omittedFallbackTextNodeCount = Math.max(0, candidateValues.length - scannedCandidates.length);
              const familyByParent = new Map<number, string | null>();
              const fallbackLeafSamples: LocalFinalPdfNotoFallbackTextNode[] = [];
              const fallbackTextNodeIds = new Set<number>();
              let multipleRootTextNodeCount = 0;
              for (const candidate of scannedCandidates) {
                const { fonts } = await activeSession.send("CSS.getPlatformFontsForNode", { nodeId: candidate.nodeId });
                const usedFonts = (fonts as Array<{ familyName?: string; postScriptName?: string; glyphCount?: number; isCustomFont?: boolean }>)
                  .filter((font) => Number(font.glyphCount) > 0);
                if (usedFonts.length === 0) {
                  details.emptyLeafFontReportCount += 1;
                  continue;
                }
                const fallbackFonts = usedFonts.filter((font) => !isNotoUsedFont(font));
                if (fallbackFonts.length === 0) continue;
                fallbackTextNodeIds.add(candidate.nodeId);
                if (candidate.observedBy.length > 1) multipleRootTextNodeCount += 1;
                if (!familyByParent.has(candidate.parentElementNodeId)) {
                  try {
                    const { object } = await activeSession.send("DOM.resolveNode", { nodeId: candidate.parentElementNodeId });
                    if (!object?.objectId) familyByParent.set(candidate.parentElementNodeId, null);
                    else {
                      const computed = await activeSession.send("Runtime.callFunctionOn", {
                        objectId: object.objectId,
                        functionDeclaration: "function(){ return getComputedStyle(this).fontFamily; }",
                        returnByValue: true,
                      });
                      familyByParent.set(candidate.parentElementNodeId,
                        typeof computed?.result?.value === "string" ? computed.result.value : null);
                    }
                  } catch {
                    familyByParent.set(candidate.parentElementNodeId, null);
                  }
                }
                if (fallbackLeafSamples.length < NOTO_DIAGNOSTIC_DETAIL_LIMIT) {
                  fallbackLeafSamples.push(createNotoFallbackTextNodeSample({
                    kind: candidate.kind,
                    columnIndex: candidate.columnIndex,
                    text: candidate.text,
                    computedFontFamily: familyByParent.get(candidate.parentElementNodeId) ?? null,
                    fallbackFonts,
                    observedBy: candidate.observedBy,
                  }));
                }
              }
              details.uniqueFallbackTextNodeCount = fallbackTextNodeIds.size;
              details.textNodesObservedByMultipleRoots = multipleRootTextNodeCount;
              details.fallbackTextNodes = fallbackLeafSamples;
              details.omittedFallbackTextNodeCount += Math.max(0, details.uniqueFallbackTextNodeCount - fallbackLeafSamples.length);
            } catch {
              // The original strict root-level font check remains authoritative; diagnostics may be incomplete.
              details.leafScanComplete = false;
            }
            try {
              options.onNotoDiagnosticDetails?.(details);
            } catch {
              // Diagnostic delivery must not change the PDF validation result.
            }
          }
          const failureCode = classifyNotoFontUsageFailure(true, counts);
          if (failureCode) refuse(failureCode);
          reportNotoDiagnosticCounts(options.onNotoDiagnosticCounts, counts);
        } catch (error) {
          if (!specificFailureCode) {
            specificFailureCode = LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.notoInspectionExceptionFailure;
            reportDiagnosticCode(options.onDiagnosticCode, specificFailureCode);
            if (countsAvailable) reportNotoDiagnosticCounts(options.onNotoDiagnosticCounts, counts);
          }
          if (error instanceof Error && error.message === NOTO_SERIF_JP_UNAVAILABLE_MESSAGE) throw error;
          throw new Error(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE);
        } finally {
          try {
            if (session) await session.detach();
          } catch {
            if (!specificFailureCode) {
              specificFailureCode = LOCAL_FINAL_PDF_DIAGNOSTIC_CODES.notoInspectionExceptionFailure;
              reportDiagnosticCode(options.onDiagnosticCode, specificFailureCode);
              if (countsAvailable) reportNotoDiagnosticCounts(options.onNotoDiagnosticCounts, counts);
            }
            throw new Error(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE);
          }
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
      if (expectedPageCount !== null && result.pageCount !== expectedPageCount) {
        throw new Error("validated_page_count_mismatch");
      }
      return result;
    });
    return { pdfBytes, pageCount: validated.pageCount, rubyCount, visualSample };
  } finally {
    if (browserTimeout) clearTimeout(browserTimeout);
    if (browserRef.current) await browserRef.current.close();
  }
}
