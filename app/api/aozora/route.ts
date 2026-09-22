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

/**
 * HTMLエンティティを通常の文字に戻す
 */
function decodeHtml(text: string) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x3000;/gi, "　");
}

/**
 * 青空文庫HTMLを本文テキストに変換する
 */
function cleanAozoraHtml(html: string) {
  let text = html;

  // --------------------------------------------------
  // 1. ルビを削除
  // --------------------------------------------------

  // ルビ本文を削除
  text = text.replace(/<rt[\s\S]*?<\/rt>/gi, "");

  // ルビ用の括弧（ ）を削除
  text = text.replace(/<rp[\s\S]*?<\/rp>/gi, "");

  // rubyタグ自体を削除
  text = text.replace(/<\/?ruby[^>]*>/gi, "");

  // --------------------------------------------------
  // 2. HTMLの構造を本文用テキストに変換
  // --------------------------------------------------

  // brタグを改行に変換
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // その他のHTMLタグを削除
  text = text.replace(/<[^>]+>/g, "");

  // --------------------------------------------------
  // 3. HTML特殊文字を通常の文字に戻す
  // --------------------------------------------------

  text = decodeHtml(text);

  // --------------------------------------------------
  // 4. 青空文庫独自の記法を整理
  // --------------------------------------------------

  // 青空文庫の注記を削除
  // 例：［＃ここから○字下げ］
  text = text.replace(/［＃[\s\S]*?］/g, "");

  // ルビ開始記号「｜」を削除
  text = text.replace(/｜/g, "");

  // 青空文庫形式のルビ
  // 例：漢字《かんじ》
  text = text.replace(/《[\s\S]*?》/g, "");

  // --------------------------------------------------
  // 5. 文章の余分な空白を整理
  // --------------------------------------------------

  text = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

  // 空行が3行以上続く場合は2行までにする
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * 青空文庫のHTMLを文字化けさせずに取得する
 *
 * response.text()ではなくarrayBuffer()を使い、
 * HTMLのcharsetを確認してからデコードする。
 */
async function fetchAozoraHtml(url: string) {
  const response = await fetch(url, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `青空文庫の本文取得に失敗しました: ${response.status}`
    );
  }

  // バイト列として取得
  const buffer = await response.arrayBuffer();

  // HTMLの先頭部分からcharsetを探す
  const headerText = new TextDecoder("ascii").decode(
    buffer.slice(0, 4096)
  );

  const charsetMatch = headerText.match(
    /charset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)/i
  );

  const charset = charsetMatch?.[1]?.toLowerCase() ?? "utf-8";

  console.log("青空文庫 charset:", charset);

  // UTF-8
  if (charset === "utf-8" || charset === "utf8") {
    return new TextDecoder("utf-8").decode(buffer);
  }

  // Shift_JIS系
  if (
    charset === "shift_jis" ||
    charset === "shift-jis" ||
    charset === "sjis"
  ) {
    return new TextDecoder("shift_jis").decode(buffer);
  }

  // 判別できない場合
  console.warn(
    `未知の文字コード "${charset}" が指定されています。UTF-8として処理します。`
  );

  return new TextDecoder("utf-8").decode(buffer);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const title = searchParams.get("title");

  // --------------------------------------------------
  // 1. 作品タイトルの確認
  // --------------------------------------------------

  if (!title) {
    return NextResponse.json(
      {
        error: "作品タイトルが指定されていません。",
      },
      { status: 400 }
    );
  }

  // --------------------------------------------------
  // 2. 作品名の表記ゆれを吸収
  // --------------------------------------------------

  const normalizedTitle = normalizeTitle(title);

  const workKey = Object.keys(works).find(
    (key) => normalizeTitle(key) === normalizedTitle
  );

  // --------------------------------------------------
  // 3. 対応していない作品
  // --------------------------------------------------

  if (!workKey) {
    return NextResponse.json(
      {
        error: `現在この作品には対応していません。受け取った作品名：「${title}」`,
      },
      { status: 404 }
    );
  }

  const work = works[workKey];

  // --------------------------------------------------
  // 4. 青空文庫から本文を取得
  // --------------------------------------------------

  try {
    const html = await fetchAozoraHtml(work.textUrl);

    // ------------------------------------------------
    // 5. HTMLを本文テキストに変換
    // ------------------------------------------------

    const text = cleanAozoraHtml(html);

    // ------------------------------------------------
    // 6. book-previewへ返す
    // ------------------------------------------------

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