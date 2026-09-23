import { NextResponse } from "next/server";
import JSZip from "jszip";

type Work = {
  id: string;
  title: string;
  author: string;
  cardUrl: string;
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

async function loadCatalog(): Promise<Work[]> {
  // すでに取得済みなら再利用
  if (catalogCache) {
    return catalogCache;
  }

  console.log("青空文庫の作品カタログを取得しています...");

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

  // ZIPの中からCSVを探す
  const csvFileName = Object.keys(zip.files).find((name) =>
    name.endsWith(".csv")
  );

  if (!csvFileName) {
    throw new Error(
      "青空文庫のCSVファイルが見つかりませんでした。"
    );
  }

  const csvText = await zip.files[csvFileName].async("string");

  const lines = csvText.split(/\r?\n/);

  const works: Work[] = [];

  // 1行目はヘッダーなので2行目から読む
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trim()) {
      continue;
    }

    const columns = parseCsvLine(line);

    /*
     * 青空文庫の拡充版CSV
     *
     * 作品ID       → 0
     * 作品名       → 1
     * 著者名       → 姓・名の列
     * 図書カードURL → 13
     */

    const id = columns[0]?.trim() ?? "";
    const title = columns[1]?.trim() ?? "";

    const lastName = columns[15]?.trim() ?? "";
    const firstName = columns[16]?.trim() ?? "";

    const author = `${lastName} ${firstName}`.trim();

    const cardUrl = columns[13]?.trim() ?? "";

    if (!id || !title) {
      continue;
    }

    works.push({
      id,
      title,
      author,
      cardUrl,
    });
  }

  console.log(
    `青空文庫カタログ読み込み完了: ${works.length}作品`
  );

  catalogCache = works;

  return works;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const query = searchParams.get("q")?.trim() ?? "";

  // 検索文字がない場合
  if (!query) {
    return NextResponse.json({
      works: [],
    });
  }

  try {
    const catalog = await loadCatalog();

    const normalizedQuery = query.toLowerCase();

    const results = catalog
      .filter((work) => {
        const title = work.title.toLowerCase();
        const author = work.author.toLowerCase();

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
          "青空文庫の作品カタログを取得できませんでした。",
      },
      {
        status: 500,
      }
    );
  }
}
