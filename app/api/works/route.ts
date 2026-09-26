import { NextResponse } from "next/server";
import JSZip from "jszip";

type Work = {
  id: string;
  title: string;
  author: string;
  cardUrl: string;
  textUrl: string;
  xhtmlUrl: string;
};

const CATALOG_URL =
  "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip";

let catalogCache: Work[] | null = null;

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);

  return values;
}

function normalizeColumnName(value: string) {
  return value
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\s+/g, "")
    .replace(/　/g, "");
}

async function loadCatalog(): Promise<Work[]> {
  if (catalogCache) {
    return catalogCache;
  }

  console.log(
    "青空文庫の作品カタログを取得しています..."
  );

  const response = await fetch(CATALOG_URL, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `青空文庫カタログの取得に失敗しました: ${response.status}`
    );
  }

  const buffer = await response.arrayBuffer();

  const zip = await JSZip.loadAsync(buffer);

  const csvFileName = Object.keys(zip.files).find(
    (name) => name.endsWith(".csv")
  );

  if (!csvFileName) {
    throw new Error(
      "青空文庫のCSVファイルが見つかりませんでした。"
    );
  }

  const csvText =
    await zip.files[csvFileName].async("string");

  const lines = csvText.split(/\r?\n/);

  if (lines.length === 0) {
    throw new Error(
      "青空文庫のCSVが空です。"
    );
  }

  /*
   * --------------------------------------------------
   * CSVのヘッダーから各列の位置を探す
   * --------------------------------------------------
   */

  const header = parseCsvLine(lines[0]).map(
    normalizeColumnName
  );

  console.log(
    "青空文庫CSVヘッダー:",
    header
  );

  const findColumnIndex = (
    candidates: string[]
  ) => {
    for (const candidate of candidates) {
      const normalizedCandidate =
        normalizeColumnName(candidate);

      const index = header.findIndex(
        (column) =>
          column === normalizedCandidate
      );

      if (index !== -1) {
        return index;
      }
    }

    return -1;
  };

  /*
   * 作品ID
   */
  const idIndex = findColumnIndex([
    "作品ID",
    "作品ＩＤ",
    "作品id",
  ]);

  /*
   * 作品名
   */
  const titleIndex = findColumnIndex([
    "作品名",
  ]);

  /*
   * 図書カードURL
   */
  const cardUrlIndex = findColumnIndex([
    "図書カードURL",
    "図書カード",
    "カードURL",
  ]);

  /*
   * 姓
   */
  const lastNameIndex = findColumnIndex([
    "姓",
  ]);

  /*
   * 名
   */
  const firstNameIndex = findColumnIndex([
    "名",
  ]);

  /*
   * テキストファイルURL
   */
  const textUrlIndex = findColumnIndex([
    "テキストファイルURL",
    "テキストURL",
    "テキストファイル",
  ]);

  /*
   * XHTML / HTMLファイルURL
   */
  const xhtmlUrlIndex = findColumnIndex([
    "XHTMLファイルURL",
    "XHTML/HTMLファイルURL",
    "XHTML/HTMLファイル",
    "HTMLファイルURL",
    "XHTMLURL",
  ]);

  console.log(
    "CSV列番号:",
    {
      idIndex,
      titleIndex,
      cardUrlIndex,
      lastNameIndex,
      firstNameIndex,
      textUrlIndex,
      xhtmlUrlIndex,
    }
  );

  /*
   * 必須列が見つからなければエラー
   */

  if (
    idIndex === -1 ||
    titleIndex === -1
  ) {
    throw new Error(
      "青空文庫CSVの作品IDまたは作品名の列を特定できませんでした。"
    );
  }

  /*
   * URL列は、今回の目的では重要なので
   * 見つからない場合は明示的にエラーにする。
   */

  if (
    cardUrlIndex === -1 ||
    textUrlIndex === -1 ||
    xhtmlUrlIndex === -1
  ) {
    throw new Error(
      "青空文庫CSVのURL列を特定できませんでした。ヘッダーを確認してください。"
    );
  }

  const works: Work[] = [];

  /*
   * 2行目以降を作品データとして読む
   */

  for (
    let i = 1;
    i < lines.length;
    i++
  ) {
    const line = lines[i];

    if (!line.trim()) {
      continue;
    }

    const columns = parseCsvLine(line);

    const id =
      columns[idIndex]?.trim() ?? "";

    const title =
      columns[titleIndex]?.trim() ?? "";

    const lastName =
      lastNameIndex !== -1
        ? columns[lastNameIndex]?.trim() ?? ""
        : "";

    const firstName =
      firstNameIndex !== -1
        ? columns[firstNameIndex]?.trim() ?? ""
        : "";

    const author =
      `${lastName} ${firstName}`.trim();

    const cardUrl =
      columns[cardUrlIndex]?.trim() ?? "";

    const textUrl =
      columns[textUrlIndex]?.trim() ?? "";

    const xhtmlUrl =
      columns[xhtmlUrlIndex]?.trim() ?? "";

    if (!id || !title) {
      continue;
    }

    works.push({
      id,
      title,
      author,
      cardUrl,
      textUrl,
      xhtmlUrl,
    });
  }

  console.log(
    `青空文庫カタログ読み込み完了: ${works.length}作品`
  );

  catalogCache = works;

  return works;
}

export async function GET(request: Request) {
  const { searchParams } =
    new URL(request.url);

  const query =
    searchParams.get("q")?.trim() ?? "";

  /*
   * 検索文字がない場合
   */

  if (!query) {
    return NextResponse.json({
      works: [],
    });
  }

  try {
    const catalog =
      await loadCatalog();

    /*
     * 検索時はスペースを無視する。
     *
     * 例：
     * 「夏目漱石」
     * 「夏目 漱石」
     * 「夏目　漱石」
     *
     * すべて同じ検索結果になる。
     */

    const normalizedQuery =
      query
        .toLowerCase()
        .replace(/\s+/g, "");

    const results = catalog
      .filter((work) => {
        const title =
          work.title
            .toLowerCase()
            .replace(/\s+/g, "");

        const author =
          work.author
            .toLowerCase()
            .replace(/\s+/g, "");

        return (
          title.includes(normalizedQuery) ||
          author.includes(normalizedQuery)
        );
      })
      .slice(0, 30);

    return NextResponse.json({
      works: results,
    });
  } catch (error) {
    console.error(
      "青空文庫作品検索エラー:",
      error
    );

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "青空文庫の作品カタログを取得できませんでした。",
      },
      {
        status: 500,
      }
    );
  }
}