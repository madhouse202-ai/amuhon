import { renderLocalFinalBodyPdf } from "@/lib/local-final-pdf";
import { parseLocalOrderPdfRequest } from "@/lib/local-order-pdf-request";
import { inspectLocalDevelopmentOrigin } from "@/lib/local-dev-render-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 8_500_000;
let rendering = false;

type OrderPdfDiagnosticCode =
  | "LOCAL_ONLY_REJECTED"
  | "REQUEST_VALIDATION_START"
  | "REQUEST_VALIDATION_SUCCESS"
  | "REQUEST_VALIDATION_FAILURE"
  | "PDF_RENDER_BUSY"
  | "PDF_RENDER_UNKNOWN_FAILURE"
  | "BODY_SNAPSHOT_HANDOFF_SUCCESS"
  | "BODY_SNAPSHOT_HANDOFF_UNAVAILABLE"
  | "LOCAL_REQUEST_URL_REJECTED"
  | "LOCAL_ORIGIN_HEADER_REJECTED"
  | "LOCAL_ORIGIN_MISMATCH"
  | "LOCAL_HOST_HEADER_MISMATCH"
  | "LOCAL_ROUTE_PATH_REJECTED"
  | import("@/lib/local-final-pdf").LocalFinalPdfDiagnosticCode;

function recordDiagnostic(code: OrderPdfDiagnosticCode) {
  console.info(`[order-pdf] ${code}`);
}

function errorResponse(message: string, status: number, diagnosticCode?: OrderPdfDiagnosticCode) {
  const includeDiagnostic = process.env.NODE_ENV === "development" && diagnosticCode !== undefined;
  return Response.json({ error: message, ...(includeDiagnostic ? { diagnosticCode } : {}) }, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(includeDiagnostic ? { "X-Diagnostic-Code": diagnosticCode } : {}),
    },
  });
}

export async function POST(request: Request) {
  const localRequest = inspectLocalDevelopmentOrigin(request, "/api/dev/order-pdf");
  if (process.env.NODE_ENV !== "development" || localRequest.failureCode !== null) {
    const diagnosticCode = process.env.NODE_ENV === "development"
      ? localRequest.failureCode ?? "LOCAL_ONLY_REJECTED"
      : "LOCAL_ONLY_REJECTED";
    if (process.env.NODE_ENV === "development") recordDiagnostic(diagnosticCode);
    return errorResponse("この本文PDF生成機能はローカル開発環境専用です。", 404, diagnosticCode);
  }
  const localOrigin = localRequest.origin;
  recordDiagnostic("REQUEST_VALIDATION_START");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    recordDiagnostic("REQUEST_VALIDATION_FAILURE");
    return errorResponse("本の情報を読み取れませんでした。", 415, "REQUEST_VALIDATION_FAILURE");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    recordDiagnostic("REQUEST_VALIDATION_FAILURE");
    return errorResponse("本の情報が上限を超えています。", 413, "REQUEST_VALIDATION_FAILURE");
  }
  if (rendering) {
    recordDiagnostic("PDF_RENDER_BUSY");
    return errorResponse("別の本文PDFを生成中です。完了後に再試行してください。", 429, "PDF_RENDER_BUSY");
  }

  let raw: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
      recordDiagnostic("REQUEST_VALIDATION_FAILURE");
      return errorResponse("本の情報が上限を超えています。", 413, "REQUEST_VALIDATION_FAILURE");
    }
    raw = JSON.parse(text) as unknown;
  } catch {
    recordDiagnostic("REQUEST_VALIDATION_FAILURE");
    return errorResponse("本の情報を読み取れませんでした。", 400, "REQUEST_VALIDATION_FAILURE");
  }

  const input = parseLocalOrderPdfRequest(raw);
  if (!input) {
    recordDiagnostic("REQUEST_VALIDATION_FAILURE");
    return errorResponse("作品情報または本文PDFページ数を確認してください。", 400, "REQUEST_VALIDATION_FAILURE");
  }
  recordDiagnostic("REQUEST_VALIDATION_SUCCESS");
  recordDiagnostic(input.preloadedWorks ? "BODY_SNAPSHOT_HANDOFF_SUCCESS" : "BODY_SNAPSHOT_HANDOFF_UNAVAILABLE");

  rendering = true;
  let failureCode: OrderPdfDiagnosticCode | null = null;
  try {
    const result = await renderLocalFinalBodyPdf(input.book, input.bodyPdfPageCount, {
      developmentRenderUrl: `${localOrigin}/final`,
      ...(input.preloadedWorks ? {
        preloadedWorks: input.preloadedWorks,
        blockExternalRequests: true,
      } : {}),
      onDiagnosticCode: (code) => {
        recordDiagnostic(code);
        if (code.endsWith("_FAILURE")) failureCode ??= code;
      },
    });
    const pdfBody = new ArrayBuffer(result.pdfBytes.byteLength);
    new Uint8Array(pdfBody).set(result.pdfBytes);
    return new Response(pdfBody, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(result.pdfBytes.byteLength),
        "X-Body-Pdf-Page-Count": String(result.pageCount),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    const diagnosticCode = failureCode ?? "PDF_RENDER_UNKNOWN_FAILURE";
    if (!failureCode) recordDiagnostic(diagnosticCode);
    return errorResponse("本文PDFを作成できませんでした。本文取得または組版を確認してから再試行してください。", 502, diagnosticCode);
  } finally {
    rendering = false;
  }
}
