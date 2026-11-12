import { readFile } from "node:fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FONT_PATH = "C:\\Windows\\Fonts\\NotoSerifJP-VF.ttf";
const LOCAL_ORIGIN = "http://localhost:3000";

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const fetchSite = request.headers.get("sec-fetch-site");
  if (process.env.NODE_ENV !== "development" || requestUrl.origin !== LOCAL_ORIGIN ||
      request.headers.get("origin") !== LOCAL_ORIGIN || request.headers.get("host") !== "localhost:3000" ||
      (fetchSite !== null && fetchSite !== "same-origin")) {
    return Response.json({ error: "開発用フォント確認機能はローカル環境専用です。" }, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 0) {
    return Response.json({ error: "フォント要求を確認できませんでした。" }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const bytes = await readFile(FONT_PATH);
    if (bytes.byteLength < 1024 || bytes.byteLength > 30_000_000 ||
        !(bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) || bytes.subarray(0, 4).toString("ascii") === "OTTO")) {
      throw new Error("invalid_font");
    }
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return new Response(body.buffer, {
      status: 200,
      headers: {
        "Content-Type": "font/ttf",
        "Content-Length": String(body.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "Noto Serif JPのローカルフォントが見つからないか、読み込めません。" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
