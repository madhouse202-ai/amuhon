import { NextResponse } from "next/server";

type WorkData = {
  author: string;
  textUrl: string;
};

const works: Record<string, WorkData> = {
  "注文の多い料理店": {
    author: "宮沢賢治",
    textUrl:
      "https://www.aozora.gr.jp/cards/000081/files/43754_17659.html",
  },

  "走れメロス": {
    author: "太宰治",
    textUrl:
      "https://www.aozora.gr.jp/cards/000035/files/1567_14913.html",
  },

  "銀河鉄道の夜": {
    author: "宮沢賢治",
    textUrl:
      "https://www.aozora.gr.jp/cards/000081/files/43737_19215.html",
  },

  "こころ": {
    author: "夏目漱石",
    textUrl:
      "https://www.aozora.gr.jp/cards/000148/files/773_14560.html",
  },
};

function normalizeTitle(title: string) {
  return title
    .trim()
    .replace(/\s+/g, "")
    .replace(/「|」/g, "")
    .replace(/『|』/g, "")
    .replace(/【|】/g, "");
}

function decodeHtml(text: string) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanAozoraHtml(html: string) {
  let text = html;

  // ルビを削除
  text = text.replace(/<rt[\s\S]*?<\/rt>/gi, "");

  // HTMLの改行を本文の改行に変換
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // HTMLタグを削除
  text = text.replace(/<[^>]+>/g, "");

  // HTML特殊文字を戻す
  text = decodeHtml(text);

  // 青空文庫の注記を削除
  text = text.replace(/［＃[\s\S]*?］/g, "");

  // 青空文庫のルビ記号を削除
  text = text.replace(/｜/g, "");

  // 《ルビ》を削除
  text = text.replace(/《[\s\S]*?》/g, "");

  // 行末の余分な空白を削除
  text = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

  // 空行が多すぎる場合は整理
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const title = searchParams.get("title");

  if (!title) {
    return NextResponse.json(
      {
        error: "作品タイトルが指定されていません。",
      },
      { status: 400 }
    );
  }

  // 作品名の表記ゆれを吸収
  const normalizedTitle = normalizeTitle(title);

  const workKey = Object.keys(works).find(
    (key) => normalizeTitle(key) === normalizedTitle
  );

  // 対応していない作品
  if (!workKey) {
    return NextResponse.json(
      {
        error: `現在この作品には対応していません。受け取った作品名：「${title}」`,
      },
      { status: 404 }
    );
  }

  const work = works[workKey];

  try {
    // 青空文庫から本文を取得
    const response = await fetch(work.textUrl, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(
        `青空文庫の本文取得に失敗しました: ${response.status}`
      );
    }

    const html = await response.text();

    // 本文を読みやすいテキストに変換
    const text = cleanAozoraHtml(html);

    return NextResponse.json({
      title: workKey,
      author: work.author,
      text,
      sourceUrl: work.textUrl,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error: "青空文庫から本文を取得できませんでした。",
      },
      { status: 500 }
    );
  }
}