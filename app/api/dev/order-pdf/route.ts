import { renderLocalFinalBodyPdf } from "@/lib/local-final-pdf";
import { parseLocalOrderPdfRequest } from "@/lib/local-order-pdf-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 256 * 1024;
let rendering = false;

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (process.env.NODE_ENV !== "development" ||
      requestUrl.origin !== "http://localhost:3000" ||
      origin !== "http://localhost:3000" || host !== "localhost:3000") {
    return errorResponse("この本文PDF生成機能はローカル開発環境専用です。", 404);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return errorResponse("本の情報を読み取れませんでした。", 415);
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return errorResponse("本の情報が上限を超えています。", 413);
  }
  if (rendering) return errorResponse("別の本文PDFを生成中です。完了後に再試行してください。", 429);

  let raw: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
      return errorResponse("本の情報が上限を超えています。", 413);
    }
    raw = JSON.parse(text) as unknown;
  } catch {
    return errorResponse("本の情報を読み取れませんでした。", 400);
  }

  const input = parseLocalOrderPdfRequest(raw);
  if (!input) return errorResponse("作品情報または本文PDFページ数を確認してください。", 400);

  rendering = true;
  try {
    const result = await renderLocalFinalBodyPdf(input.book, input.bodyPdfPageCount);
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
    return errorResponse("本文PDFを作成できませんでした。本文取得または組版を確認してから再試行してください。", 502);
  } finally {
    rendering = false;
  }
}
