import {
  renderLocalFinalBodyPdf,
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

function errorResponse(message: string, status: number, diagnosticCode: ApiDiagnosticCode) {
  return Response.json({ error: message, diagnosticCode }, {
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
      return errorResponse("Noto Serif JPの検証に失敗しました。", 503, diagnosticCode);
    }
    const diagnosticCode = rendererFailureCode ?? "PDF_RENDER_UNKNOWN_FAILURE";
    if (!rendererFailureCode) recordDiagnostic(diagnosticCode);
    return errorResponse("本文PDFの検証に失敗しました。診断コードを確認してください。", 502, diagnosticCode);
  } finally {
    rendering = false;
  }
}
