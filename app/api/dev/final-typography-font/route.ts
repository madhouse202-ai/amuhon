import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  NOTO_SERIF_JP_FONT_SHA256,
  NOTO_SERIF_JP_FONT_SIZE_BYTES,
} from "@/lib/final-typography-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FONT_PATH = join(process.cwd(), ".local-assets", "fonts", "NotoSerifCJKjp-Regular.otf");
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
    const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
    if (bytes.byteLength !== NOTO_SERIF_JP_FONT_SIZE_BYTES ||
        sha256 !== NOTO_SERIF_JP_FONT_SHA256 ||
        bytes.subarray(0, 4).toString("ascii") !== "OTTO") {
      throw new Error("invalid_font");
    }
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return new Response(body.buffer, {
      status: 200,
      headers: {
        "Content-Type": "font/otf",
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
