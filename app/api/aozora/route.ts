
import { NextResponse } from "next/server";

type TextPart = {
  type: "text";
  text: string;
};

type ContentPart = TextPart;

/**
 * HTMLエンティティを通常の文字に戻す
 */
function decodeHtml(html: string): string {
  return html
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number(decimal))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16))
    );
}

/**
 * HTMLタグを取り除く
 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/**
 * 本文の改行や空白を整える
 */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 青空文庫HTMLから main_text の中身を抽出する
 */
function extractMainText(html: string): string | null {
  const openingTag = /<div\b[^>]*class=["'][^"']*\bmain_text\b[^"']*["'][^>]*>/i;
  const match = openingTag.exec(html);

  if (!match || match.index === undefined) {
    return null;
  }

  const start = match.index + match[0].length;
  const rest = html.slice(start);
  const divTags = /<\/?div\b[^>]*>/gi;

  let depth = 1;
  let lastIndex = 0;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = divTags.exec(rest)) !== null) {
    const tag = tagMatch[0];

    if (/^<\/div/i.test(tag)) {
      depth -= 1;

      if (depth === 0) {
        return rest.slice(0, tagMatch.index);
      }
    } else if (!/\/>$/.test(tag)) {
      depth += 1;
    }

    lastIndex = divTags.lastIndex;
  }

  void lastIndex;
  return null;
}

/**
 * 青空文庫の本文HTMLをプレーンテキストに変換する
 * ルビの読み仮名とルビ用括弧は、タグ除去より先に削除する
 */
function parseMainTextHtml(html: string): string {
  let text = html;

  // スクリプトやスタイルを削除
  text = text.replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ""
  );

  // ルビの読み仮名を削除
  text = text.replace(/<rt\b[^>]*>[\s\S]*?<\/rt\s*>/gi, "");

  // ルビの代替表示用括弧を削除
  text = text.replace(/<rp\b[^>]*>[\s\S]*?<\/rp\s*>/gi, "");

  // ルビに関連する補助要素を削除
  text = text.replace(/<\/?(?:ruby|rb|rtc)\b[^>]*>/gi, "");

  // 改行に相当するHTML要素を改行へ変換
  text = text.replace(/<br\b[^>]*\/?>/gi, "\n");
  text = text.replace(
    /<\/(?:p|div|h[1-6]|blockquote|pre|section|article)\s*>/gi,
    "\n"
  );
  text = text.replace(
    /<(?:p|div|h[1-6]|blockquote|pre|section|article)\b[^>]*>/gi,
    ""
  );
  text = text.replace(/<hr\b[^>]*\/?>/gi, "\n");

  // 残ったHTMLタグを取り除いてからエンティティを復元
  text = stripTags(text);
  text = decodeHtml(text);

  return normalizeText(text);
}

/**
 * HTML解析後に残った青空文庫注記の読みだけを除き、親文字を保持する。
 */
function removeRubyAnnotations(text: string): string {
  return text
    // 青空文庫の注記形式：｜親文字《読み》
    .replace(/｜([^《\n]+)《[^》\n]*》/g, "$1")
    // 直前の文字に続くルビ形式：漢字《かんじ》
    .replace(/([一-龯々〆ヵヶ]+)《[^》\n]*》/g, "$1")
    // 括弧形式で残った読み仮名（HTMLのrp/rt除去後に使う）
    .replace(/（[^（）\n]*）/g, (match) => {
      // 一般の文章の括弧まで消さないよう、読み仮名らしい場合のみ除去
      const inside = match.slice(1, -1);
      return /^[ぁ-ゖァ-ヺー・ゔゕゖ]+$/.test(inside) ? "" : match;
    })
    .trim();
}

function makeContent(text: string): ContentPart[] {
  return text ? [{ type: "text", text }] : [];
}

/**
 * 青空文庫のURLだけ許可する
 */
function isAllowedAozoraUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      (url.hostname === "aozora.gr.jp" ||
        url.hostname === "www.aozora.gr.jp")
    );
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sourceUrl = searchParams.get("url");

    if (!sourceUrl || !isAllowedAozoraUrl(sourceUrl)) {
      return NextResponse.json(
        { error: "有効な青空文庫のURLを指定してください。" },
        { status: 400 }
      );
    }

    const response = await fetch(sourceUrl, {
      headers: {
        "User-Agent": "Amuhon/1.0",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "青空文庫から本文を取得できませんでした。" },
        { status: 502 }
      );
    }

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") ?? "";

    let html: string;

    if (/shift[_-]?jis|sjis/i.test(contentType)) {
      html = new TextDecoder("shift_jis").decode(buffer);
    } else {
      const bytes = new Uint8Array(buffer);
      const head = new TextDecoder("ascii").decode(bytes.slice(0, 500));

      if (/charset\s*=\s*["']?shift[_-]?jis/i.test(head)) {
        html = new TextDecoder("shift_jis").decode(buffer);
      } else {
        html = new TextDecoder("utf-8").decode(buffer);
      }
    }

    const mainTextHtml = extractMainText(html);

    if (!mainTextHtml) {
      return NextResponse.json(
        { error: "本文領域（main_text）が見つかりませんでした。" },
        { status: 422 }
      );
    }

    const parsedText = parseMainTextHtml(mainTextHtml);
    const text = removeRubyAnnotations(parsedText);

    if (!text) {
      return NextResponse.json(
        { error: "本文を抽出できませんでした。" },
        { status: 422 }
      );
    }

    return NextResponse.json({
      text,
      content: makeContent(text),
      sourceUrl,
    });
  } catch (error) {
    console.error("Aozora text fetch error:", error);

    return NextResponse.json(
      { error: "本文の取得中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
