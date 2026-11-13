import {
  renderLocalFinalBodyPdf,
  type LocalFinalPdfNotoDiagnosticDetails,
  type LocalFinalPdfNotoDiagnosticCounts,
  type LocalFinalPdfDiagnosticCode,
} from "@/lib/local-final-pdf";
import { parseFinalTypographyPreviewRequest } from "@/lib/final-typography-preview";
import { NOTO_SERIF_JP_UNAVAILABLE_MESSAGE } from "@/lib/final-typography-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOCAL_ORIGIN = "http://localhost:3000";
const MAX_REQUEST_BYTES = 8_500_000;
let rendering = false;

type ApiDiagnosticCode = LocalFinalPdfDiagnosticCode |
  "LOCAL_ONLY_REJECTED" |
  "REQUEST_VALIDATION_START" |
  "REQUEST_VALIDATION_SUCCESS" |
  "REQUEST_VALIDATION_FAILURE" |
  "REQUEST_CONTENT_TYPE_REJECTED" |
  "REQUEST_BODY_TOO_LARGE" |
  "REQUEST_JSON_INVALID" |
  "REQUEST_SCHEMA_REJECTED" |
  "PDF_RENDER_BUSY" |
  "PDF_RENDER_UNKNOWN_FAILURE";

function recordDiagnostic(code: ApiDiagnosticCode) {
  console.info(`[final-preview-pdf] ${code}`);
}

const NOTO_COUNT_KEYS = [
  "bodyGlyphCellCount",
  "nonEmptyRubyNodeCount",
  "glyphTextColumnCount",
  "kanjiCellCount",
  "hiraganaCellCount",
  "punctuationCellCount",
  "inspectedNodeCount",
  "emptyFontReportCount",
  "fallbackFontNodeCount",
] as const satisfies readonly (keyof LocalFinalPdfNotoDiagnosticCounts)[];

function safeNotoDiagnosticCounts(counts: LocalFinalPdfNotoDiagnosticCounts): LocalFinalPdfNotoDiagnosticCounts {
  return Object.fromEntries(NOTO_COUNT_KEYS.map((key) => {
    const value = counts[key];
    return [key, Number.isSafeInteger(value) && value >= 0 ? value : 0];
  })) as unknown as LocalFinalPdfNotoDiagnosticCounts;
}

const NOTO_CATEGORIES = new Set(["kanji", "hiragana", "katakana", "punctuation", "other"]);
const NOTO_KINDS = new Set(["column", "body-cell", "ruby"]);

function safeDiagnosticInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Math.min(Number(value), 1_000_000) : 0;
}

function safeDiagnosticFamily(value: unknown): string {
  if (typeof value !== "string") return "OTHER_FONT";
  return value.normalize("NFKC").replace(/[\\/:<>\u0000-\u001F]/g, " ")
    .replace(/[^\p{L}\p{N} ._-]/gu, "").trim().replace(/\s+/g, " ").slice(0, 64) || "OTHER_FONT";
}

function safeNotoDiagnosticDetails(details: LocalFinalPdfNotoDiagnosticDetails): LocalFinalPdfNotoDiagnosticDetails {
  const safeRoot = (root: LocalFinalPdfNotoDiagnosticDetails["fallbackRoots"][number]) => ({
    kind: NOTO_KINDS.has(root.kind) ? root.kind : "column" as const,
    index: safeDiagnosticInteger(root.index),
    columnIndex: safeDiagnosticInteger(root.columnIndex),
    categories: [...new Set(root.categories.filter((category) => NOTO_CATEGORIES.has(category)))],
    fallbackFonts: root.fallbackFonts.slice(0, 8).map((font) => ({
      family: safeDiagnosticFamily(font.family),
      glyphCount: safeDiagnosticInteger(font.glyphCount),
    })),
  });
  return {
    expectedNodeCount: safeDiagnosticInteger(details.expectedNodeCount),
    fallbackRootCount: safeDiagnosticInteger(details.fallbackRootCount),
    fallbackColumnRootCount: safeDiagnosticInteger(details.fallbackColumnRootCount),
    fallbackBodyCellRootCount: safeDiagnosticInteger(details.fallbackBodyCellRootCount),
    fallbackRubyRootCount: safeDiagnosticInteger(details.fallbackRubyRootCount),
    uniqueFallbackTextNodeCount: safeDiagnosticInteger(details.uniqueFallbackTextNodeCount),
    textNodesObservedByMultipleRoots: safeDiagnosticInteger(details.textNodesObservedByMultipleRoots),
    leafScanComplete: details.leafScanComplete === true,
    emptyLeafFontReportCount: safeDiagnosticInteger(details.emptyLeafFontReportCount),
    omittedFallbackRootCount: safeDiagnosticInteger(details.omittedFallbackRootCount),
    omittedFallbackTextNodeCount: safeDiagnosticInteger(details.omittedFallbackTextNodeCount),
    fallbackRoots: details.fallbackRoots.slice(0, 24).map(safeRoot),
    fallbackTextNodes: details.fallbackTextNodes.slice(0, 24).map((sample) => ({
      kind: sample.kind === "ruby" ? "ruby" : "body-cell",
      columnIndex: safeDiagnosticInteger(sample.columnIndex),
      categories: [...new Set(sample.categories.filter((category) => NOTO_CATEGORIES.has(category)))],
      codePoints: sample.codePoints.slice(0, 12).filter((value) => /^U\+[0-9A-F]{4,6}$/u.test(value)),
      codePointCount: safeDiagnosticInteger(sample.codePointCount),
      truncated: sample.truncated === true,
      computedFontFamily: safeDiagnosticFamily(sample.computedFontFamily),
      cssFamilyIncludesNoto: typeof sample.cssFamilyIncludesNoto === "boolean" ? sample.cssFamilyIncludesNoto : null,
      fallbackFonts: sample.fallbackFonts.slice(0, 8).map((font) => ({
        family: safeDiagnosticFamily(font.family),
        glyphCount: safeDiagnosticInteger(font.glyphCount),
      })),
      observedBy: sample.observedBy.slice(0, 8).map((root) => ({
        kind: NOTO_KINDS.has(root.kind) ? root.kind : "column" as const,
        index: safeDiagnosticInteger(root.index),
        columnIndex: safeDiagnosticInteger(root.columnIndex),
      })),
    })),
  };
}

function errorResponse(
  message: string,
  status: number,
  diagnosticCode: ApiDiagnosticCode,
  diagnosticCounts?: LocalFinalPdfNotoDiagnosticCounts,
  diagnosticDetails?: LocalFinalPdfNotoDiagnosticDetails,
) {
  const body = {
    error: message,
    diagnosticCode,
    ...(diagnosticCounts ? { diagnosticCounts: safeNotoDiagnosticCounts(diagnosticCounts) } : {}),
    ...(diagnosticDetails ? { diagnosticDetails: safeNotoDiagnosticDetails(diagnosticDetails) } : {}),
  };
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Diagnostic-Code": diagnosticCode },
  });
}

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  if (process.env.NODE_ENV !== "development" || requestUrl.origin !== LOCAL_ORIGIN ||
      request.headers.get("origin") !== LOCAL_ORIGIN || request.headers.get("host") !== "localhost:3000") {
    return errorResponse("開発用本文PDF検証はローカル環境専用です。", 404, "LOCAL_ONLY_REJECTED");
  }
  recordDiagnostic("REQUEST_VALIDATION_START");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    recordDiagnostic("REQUEST_VALIDATION_FAILURE");
    return errorResponse("作品情報を読み取れませんでした。", 415, "REQUEST_CONTENT_TYPE_REJECTED");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    recordDiagnostic("REQUEST_VALIDATION_FAILURE");
    return errorResponse("作品本文が上限を超えています。", 413, "REQUEST_BODY_TOO_LARGE");
  }
  if (rendering) return errorResponse("別の検証PDFを生成中です。完了後に再試行してください。", 429, "PDF_RENDER_BUSY");

  let raw: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
      recordDiagnostic("REQUEST_VALIDATION_FAILURE");
      return errorResponse("作品本文が上限を超えています。", 413, "REQUEST_BODY_TOO_LARGE");
    }
    raw = JSON.parse(text) as unknown;
  } catch {
    recordDiagnostic("REQUEST_VALIDATION_FAILURE");
    return errorResponse("作品情報を読み取れませんでした。", 400, "REQUEST_JSON_INVALID");
  }
  const input = parseFinalTypographyPreviewRequest(raw);
  if (!input) {
    recordDiagnostic("REQUEST_VALIDATION_FAILURE");
    return errorResponse("選択作品、本文、またはページ数を確認してください。", 400, "REQUEST_SCHEMA_REJECTED");
  }
  recordDiagnostic("REQUEST_VALIDATION_SUCCESS");

  rendering = true;
  let rendererFailureCode: LocalFinalPdfDiagnosticCode | null = null;
  let rendererNotoDiagnosticCounts: LocalFinalPdfNotoDiagnosticCounts | null = null;
  let rendererNotoDiagnosticDetails: LocalFinalPdfNotoDiagnosticDetails | null = null;
  try {
    const result = await renderLocalFinalBodyPdf(input.book, input.bodyPdfPageCount, {
      bodyTypography: input.bodyTypography,
      preloadedWorks: input.works,
      requireRubyNodes: true,
      verifyNotoFontUsage: input.bodyTypography === "noto-serif-jp",
      onDiagnosticCode: (code) => {
        recordDiagnostic(code);
        if (code.endsWith("_FAILURE") && rendererFailureCode === null) rendererFailureCode = code;
      },
      onNotoDiagnosticCounts: (counts) => {
        rendererNotoDiagnosticCounts = safeNotoDiagnosticCounts(counts);
        const safeCounts = NOTO_COUNT_KEYS.map((key) => `${key}=${rendererNotoDiagnosticCounts?.[key] ?? 0}`).join(" ");
        console.info(`[final-preview-pdf] NOTO_DIAGNOSTIC_COUNTS ${safeCounts}`);
      },
      onNotoDiagnosticDetails: (details) => {
        rendererNotoDiagnosticDetails = safeNotoDiagnosticDetails(details);
      },
    });
    const body = new Uint8Array(result.pdfBytes.byteLength);
    body.set(result.pdfBytes);
    return new Response(body.buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(body.byteLength),
        "X-Body-Pdf-Page-Count": String(result.pageCount),
        "X-Body-Ruby-Count": String(result.rubyCount),
        "X-Body-Typography": input.bodyTypography,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === NOTO_SERIF_JP_UNAVAILABLE_MESSAGE) {
      const diagnosticCode = rendererFailureCode ?? "PDF_RENDER_UNKNOWN_FAILURE";
      if (!rendererFailureCode) recordDiagnostic(diagnosticCode);
      return errorResponse("Noto Serif JPの検証に失敗しました。", 503, diagnosticCode,
        rendererNotoDiagnosticCounts ?? undefined, rendererNotoDiagnosticDetails ?? undefined);
    }
    const diagnosticCode = rendererFailureCode ?? "PDF_RENDER_UNKNOWN_FAILURE";
    if (!rendererFailureCode) recordDiagnostic(diagnosticCode);
    return errorResponse("本文PDFの検証に失敗しました。診断コードを確認してください。", 502, diagnosticCode);
  } finally {
    rendering = false;
  }
}
