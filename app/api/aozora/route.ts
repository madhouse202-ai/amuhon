import { NextResponse } from "next/server";

type RubyPart = {
  type: "ruby";
  text: string;
  ruby: string;
};

type TextPart = {
  type: "text";
  text: string;
};

type ContentPart = RubyPart | TextPart;

function decodeHtml(html: string) {
  return html
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const value = Number(code);
      return Number.isFinite(value)
        ? String.fromCodePoint(value)
        : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const value = parseInt(code, 16);
      return Number.isFinite(value)
        ? String.fromCodePoint(value)
        : "";
    });
}

function stripTags(html: string) {
  return html.replace(/<[^>]+>/g, "");
}

function normalizeText(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 青空文庫XHTMLから、
 *
 * <ruby>本文<rt>ルビ</rt></ruby>
 *
 * を見つけて、ルビ情報を別構造にする。
 *
 * <rp>（</rp> や <rp>）</rp> は完全に無視する。
 */
function parseRubyXhtml(html: string) {
  const content: ContentPart[] = [];

  let cursor = 0;

  const rubyRegex =
    /<ruby\b[^>]*>([\s\S]*?)<\/ruby>/gi;

  let match: RegExpExecArray | null;

  while ((match = rubyRegex.exec(html)) !== null) {
    const before = html.slice(cursor, match.index);

    addPlainHtml(content, before);

    const rubyHtml = match[1];

    const rtMatch =
      rubyHtml.match(/<rt\b[^>]*>([\s\S]*?)<\/rt>/i);

    if (!rtMatch) {
      addPlainHtml(content, rubyHtml);
      cursor = rubyRegex.lastIndex;
      continue;
    }

    const baseHtml = rubyHtml
      .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, "")
      .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, "");

    const base = normalizeInlineText(
      decodeHtml(stripTags(baseHtml))
    );

    const ruby = normalizeInlineText(
      decodeHtml(stripTags(rtMatch[1]))
    );

    if (base && ruby) {
      content.push({
        type: "ruby",
        text: base,
        ruby,
      });
    } else {
      addPlainHtml(content, rubyHtml);
    }

    cursor = rubyRegex.lastIndex;
  }

  addPlainHtml(content, html.slice(cursor));

  return content;
}

function addPlainHtml(
  content: ContentPart[],
  html: string
) {
  if (!html) {
    return;
  }

  let text = html;

  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  /*
   * 改行を持つ要素を先に処理する。
   */
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<hr\b[^>]*>/gi, "\n");

  /*
   * 青空文庫XHTMLに含まれる注釈用要素などは
   * 本文そのものではないので、タグだけ除去する。
   */
  text = stripTags(text);
  text = decodeHtml(text);

  if (!text) {
    return;
  }

  content.push({
    type: "text",
    text,
  });
}

function normalizeInlineText(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();
}

/**
 * 青空文庫のテキスト形式に残っている
 *
 * ［＃「本文」の左に「ルビ」のルビ］
 *
 * のような注記を処理する。
 *
 * 今回はまず本文側からルビを取り除き、
 * 構造化データとして保存するための前処理を行う。
 */
function parseAozoraRubyAnnotations(
  content: ContentPart[]
) {
  const result: ContentPart[] = [];

  const rubyAnnotationRegex =
    /(.+?)［＃「([^」]+)」の(?:左|右)に「([^」]+)」のルビ］/g;

  for (const part of content) {
    if (part.type !== "text") {
      result.push(part);
      continue;
    }

    let text = part.text;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    rubyAnnotationRegex.lastIndex = 0;

    while (
      (match = rubyAnnotationRegex.exec(text)) !== null
    ) {
      const before = text.slice(
        lastIndex,
        match.index + match[1].length
      );

      if (before) {
        result.push({
          type: "text",
          text: before,
        });
      }

      result.push({
        type: "ruby",
        text: match[2],
        ruby: match[3],
      });

      lastIndex =
        match.index + match[0].length;
    }

    if (lastIndex === 0) {
      result.push(part);
    } else if (lastIndex < text.length) {
      result.push({
        type: "text",
        text: text.slice(lastIndex),
      });
    }
  }

  return result;
}

function contentToPlainText(
  content: ContentPart[]
) {
  return normalizeText(
    content
      .map((part) => part.text)
      .join("")
  );
}

function isAllowedAozoraUrl(value: string) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      (
        url.hostname === "aozora.gr.jp" ||
        url.hostname === "www.aozora.gr.jp"
      )
    );
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  const { searchParams } =
    new URL(request.url);

  const url =
    searchParams.get("url")?.trim() ?? "";

  if (!url) {
    return NextResponse.json(
      {
        error:
          "青空文庫のURLが指定されていません。",
      },
      { status: 400 }
    );
  }

  if (!isAllowedAozoraUrl(url)) {
    return NextResponse.json(
      {
        error:
          "青空文庫のURLのみ取得できます。",
      },
      { status: 400 }
    );
  }

  try {
    console.log(
      "青空文庫本文を取得:",
      url
    );

    const response = await fetch(url, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(
        `青空文庫本文の取得に失敗しました: ${response.status}`
      );
    }

    const buffer =
      await response.arrayBuffer();

    const bytes =
      new Uint8Array(buffer);

    /*
     * 文字コードを判定する。
     */
    const sample =
      new TextDecoder("utf-8", {
        fatal: false,
      }).decode(bytes.slice(0, 4096));

    const charsetMatch =
      sample.match(
        /charset=["']?([a-zA-Z0-9_-]+)/i
      );

    const charset =
      charsetMatch?.[1]?.toLowerCase() ??
      "utf-8";

    let html = "";

    if (
      charset.includes("shift") ||
      charset.includes("sjis")
    ) {
      html = new TextDecoder(
        "shift_jis"
      ).decode(bytes);
    } else {
      html = new TextDecoder(
        "utf-8"
      ).decode(bytes);
    }

    /*
     * XHTMLからルビを含む構造を取得する。
     */
    let content =
      parseRubyXhtml(html);

    /*
     * XHTMLではなく、
     * 青空文庫注記形式が残っている場合にも対応する。
     */
    content =
      parseAozoraRubyAnnotations(
        content
      );

    /*
     * 本文だけを取り出したプレーンテキスト。
     *
     * 現在のfinal/page.tsxはまだ
     * data.textを使っているため、
     * 次の段階まではこちらを返す。
     */
    const text =
      contentToPlainText(content);

    return NextResponse.json({
      text,
      content,
      sourceUrl: url,
    });
  } catch (error) {
    console.error(
      "青空文庫本文取得エラー:",
      error
    );

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "青空文庫本文の取得に失敗しました。",
      },
      { status: 500 }
    );
  }
}