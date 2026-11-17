import JSZip from "jszip";

type Work = {
  id: string;
  title: string;
  author: string;
  contributors: WorkContributor[];
  cardUrl: string;
  textUrl: string;
  xhtmlUrl: string;
};

type WorkContributor = { name: string; role: string; reading: string };

type AuthorShelf = {
  author: string;
  workCount: number;
  sampleTitles: string[];
};

const AUTHOR_SHELF_LIMIT = 12;
const AUTHOR_SAMPLE_TITLE_LIMIT = 2;
const WORK_SHELF_LIMIT = 24;
const AUTHOR_WORK_PAGE_SIZE = 30;
const AUTHOR_LIST_PAGE_SIZE = 50;
const WORK_LIST_PAGE_SIZE = 40;

function parseExcludedWorkIds(value: string | null): Set<string> | null {
  if (!value) return new Set();
  const items = value.split(",");
  if (items.length > WORK_SHELF_LIMIT || items.some((item) => !/^\d{1,12}$/.test(item))) return null;
  return new Set(items);
}

const CATALOG_URL =
  "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip";

let catalogCache: Work[] | null = null;

function sampleItems<T>(items: T[], count: number): T[] {
  const shuffled = [...items];
  const sampleSize = Math.min(count, shuffled.length);
  for (let index = 0; index < sampleSize; index += 1) {
    const selectedIndex = index + Math.floor(Math.random() * (shuffled.length - index));
    [shuffled[index], shuffled[selectedIndex]] = [shuffled[selectedIndex], shuffled[index]];
  }
  return shuffled.slice(0, sampleSize);
}

function isAuthorRole(role: string): boolean {
  return role === "著者" || role === "作者" || role === "原著者";
}

function workAuthors(work: Work): WorkContributor[] {
  const authors = work.contributors.filter((person) => isAuthorRole(person.role));
  if (authors.length > 0) return authors;
  // Older catalog exports do not include a role column. In that format the
  // existing 姓/名 pair is the author field, so retain the legacy behavior.
  return work.contributors.length === 0 && work.author
    ? [{ name: work.author, role: "著者", reading: work.author }]
    : [];
}

function buildAuthorEntries(catalog: Work[]): Array<AuthorShelf & { reading: string }> {
  const grouped = new Map<string, { works: Work[]; reading: string }>();
  for (const work of catalog) {
    for (const person of workAuthors(work)) {
      const author = person.name.trim();
      if (!author) continue;
      const entry = grouped.get(author) ?? { works: [], reading: person.reading || author };
      if (!entry.works.some((item) => item.id === work.id)) entry.works.push(work);
      grouped.set(author, entry);
    }
  }

  const collator = new Intl.Collator("ja", { sensitivity: "base", numeric: true });
  return [...grouped.entries()]
    .map(([author, entry]) => ({
      author,
      reading: entry.reading,
      workCount: entry.works.length,
      sampleTitles: entry.works.slice(0, AUTHOR_SAMPLE_TITLE_LIMIT).map((work) => work.title),
    }))
    .sort((left, right) => collator.compare(left.reading, right.reading) || collator.compare(left.author, right.author));
}

function publicAuthorEntry(entry: AuthorShelf & { reading: string }): AuthorShelf {
  return { author: entry.author, workCount: entry.workCount, sampleTitles: entry.sampleTitles };
}

function uniqueWorks(works: Work[]): Work[] {
  const byId = new Map<string, Work>();
  for (const work of works) {
    if (!byId.has(work.id)) byId.set(work.id, work);
  }
  return [...byId.values()];
}

function sampleWorks(catalog: Work[], excludedIds: Set<string> = new Set()): Work[] {
  const unique = uniqueWorks(catalog);
  const fresh = unique.filter((work) => !excludedIds.has(work.id));
  return sampleItems(fresh.length > 0 ? fresh : unique, WORK_SHELF_LIMIT);
}

function parseOffset(value: string | null): number | null {
  if (value === null || value === "") return 0;
  if (!/^\d{1,7}$/.test(value)) return null;
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : null;
}

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
  const roleIndex = findColumnIndex(["役割フラグ", "役割"]);
  const lastNameReadingIndex = findColumnIndex(["姓読み", "姓よみ"]);
  const firstNameReadingIndex = findColumnIndex(["名読み", "名よみ"]);

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

  const workMap = new Map<string, Work>();

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
    const role = roleIndex === -1 ? "著者" : (columns[roleIndex]?.trim() ?? "");
    const reading = `${lastNameReadingIndex === -1 ? "" : columns[lastNameReadingIndex]?.trim() ?? ""} ${firstNameReadingIndex === -1 ? "" : columns[firstNameReadingIndex]?.trim() ?? ""}`.trim();

    const cardUrl =
      columns[cardUrlIndex]?.trim() ?? "";

    const textUrl =
      columns[textUrlIndex]?.trim() ?? "";

    const xhtmlUrl =
      columns[xhtmlUrlIndex]?.trim() ?? "";

    if (!id || !title) {
      continue;
    }

    const existing = workMap.get(id);
    const work = existing ?? {
      id,
      title,
      author: "",
      contributors: [],
      cardUrl,
      textUrl,
      xhtmlUrl,
    } satisfies Work;
    if (author && role && !work.contributors.some((person) => person.name === author && person.role === role)) {
      work.contributors.push({ name: author, role, reading: reading || author });
    }
    if (isAuthorRole(role) && author) {
      const authors = work.contributors.filter((person) => isAuthorRole(person.role)).map((person) => person.name);
      work.author = [...new Set(authors)].join("・");
    }
    workMap.set(id, work);
  }

  const works = [...workMap.values()];

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
  const browse = searchParams.get("browse");

  if (!query && !browse) {
    return Response.json({
      works: [],
    });
  }

  if (!query && browse && !["discover", "author", "authors", "works"].includes(browse)) {
    return Response.json({ error: "作品棚を読み込めませんでした。" }, { status: 400 });
  }

  try {
    const catalog =
      await loadCatalog();

    if (!query && browse === "discover") {
      const excludedIds = parseExcludedWorkIds(searchParams.get("exclude"));
      if (!excludedIds) return Response.json({ error: "本棚を読み込めませんでした。" }, { status: 400 });
      return Response.json({
        authors: sampleItems(buildAuthorEntries(catalog), AUTHOR_SHELF_LIMIT).map(publicAuthorEntry),
        works: sampleWorks(catalog, excludedIds),
      });
    }

    if (!query && browse === "works") {
      const offset = parseOffset(searchParams.get("offset"));
      if (offset === null) return Response.json({ error: "作品一覧を読み込めませんでした。" }, { status: 400 });
      const collator = new Intl.Collator("ja", { sensitivity: "base", numeric: true });
      const sorted = [...catalog].sort((left, right) => collator.compare(left.title, right.title) || left.id.localeCompare(right.id));
      const works = sorted.slice(offset, offset + WORK_LIST_PAGE_SIZE);
      const nextOffset = offset + works.length;
      return Response.json({ works, total: sorted.length, nextOffset, hasMore: nextOffset < sorted.length });
    }

    if (!query && browse === "authors") {
      const offset = parseOffset(searchParams.get("offset"));
      if (offset === null) return Response.json({ error: "作家一覧を読み込めませんでした。" }, { status: 400 });
      const authors = buildAuthorEntries(catalog);
      const page = authors.slice(offset, offset + AUTHOR_LIST_PAGE_SIZE);
      const nextOffset = offset + page.length;
      return Response.json({
        authors: page.map(publicAuthorEntry),
        total: authors.length,
        nextOffset,
        hasMore: nextOffset < authors.length,
      });
    }

    if (!query && browse === "author") {
      const author = searchParams.get("author")?.trim() ?? "";
      const offset = parseOffset(searchParams.get("offset"));
      if (!author || author.length > 120 || offset === null) {
        return Response.json({ error: "作家の作品を読み込めませんでした。" }, { status: 400 });
      }

      const authorWorks = catalog.filter((work) => workAuthors(work).some((person) => person.name === author));
      const works = authorWorks.slice(offset, offset + AUTHOR_WORK_PAGE_SIZE);
      const nextOffset = offset + works.length;
      return Response.json({
        author,
        works,
        total: authorWorks.length,
        nextOffset,
        hasMore: nextOffset < authorWorks.length,
      });
    }

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
        const contributorMatch = work.contributors.some((person) =>
          person.name.toLowerCase().replace(/\s+/g, "").includes(normalizedQuery),
        );

        return (
          title.includes(normalizedQuery) ||
          author.includes(normalizedQuery) ||
          contributorMatch
        );
      })
      .slice(0, 30);

    return Response.json({
      works: results,
    });
  } catch (error) {
    console.error(
      "青空文庫作品検索エラー:",
      error
    );

    return Response.json(
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
