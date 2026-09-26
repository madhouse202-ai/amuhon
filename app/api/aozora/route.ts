import { NextResponse } from "next/server";

function decodeHtml(html: string) {
  return html
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanAozoraHtml(html: string) {
  let text = html;

  // script / style を削除
  text = text.replace(
    /<script[\s\S]*?<\/script>/gi,
    ""
  );

  text = text.replace(
    /<style[\s\S]*?<\/style>/gi,
    ""
  );

  // 改行として扱いたいタグ
  text = text.replace(
    /<br\s*\/?>/gi,
    "\n"
  );

  text = text.replace(
    /<\/p>/gi,
    "\n\n"
  );

  text = text.replace(
    /<\/div>/gi,
    "\n"
  );

  text = text.replace(
    /<\/h[1-6]>/gi,
    "\n\n"
  );

  // HTMLタグを削除
  text = text.replace(
    /<[^>]+>/g,
    ""
  );

  // HTMLエンティティを戻す
  text = decodeHtml(text);

  // 改行・空白を整理
  text = text.replace(/\r\n/g, "\n");
  text = text.replace(/\r/g, "\n");

  text = text.replace(
    /[ \t]+\n/g,
    "\n"
  );

  text = text.replace(
    /\n{3,}/g,
    "\n\n"
  );

  return text.trim();
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
      {
        status: 400,
      }
    );
  }

  if (!isAllowedAozoraUrl(url)) {
    return NextResponse.json(
      {
        error:
          "青空文庫のURLのみ取得できます。",
      },
      {
        status: 400,
      }
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

    // 先頭部分を見て文字コードを判定
    const sample =
      new TextDecoder("utf-8", {
        fatal: false,
      }).decode(
        bytes.slice(0, 4096)
      );

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
      html =
        new TextDecoder("shift_jis").decode(
          bytes
        );
    } else {
      html =
        new TextDecoder("utf-8").decode(
          bytes
        );
    }

    const text =
      cleanAozoraHtml(html);

    return NextResponse.json({
      text,
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
      {
        status: 500,
      }
    );
  }
}