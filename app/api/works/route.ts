import { compareJapaneseReadings, getAvailableGojuonLetters, getGojuonIndexLetter, GOJUON_LETTERS } from "../../../lib/kana-index.ts";
import { resolveAozoraRightsCatalog, type AozoraCatalogContributor, type AozoraRightsCatalogWork } from "../../../lib/aozora-edition.ts";
import { callOrderRpc, getSupabaseServerConfig } from "../../../lib/order-checkout-server.ts";
import { filterAozoraWorksByApprovedScope } from "../../../lib/aozora-rights-scope.ts";
import {
  getCurrentAozoraRightsPolicyBinding,
  isCurrentAozoraRightsPolicyReady,
  parseAozoraSellableWorkFacts,
} from "../../../lib/aozora-rights-policy.ts";

type Work = AozoraRightsCatalogWork;
type WorkContributor = Pick<AozoraCatalogContributor, "name" | "role" | "reading">;

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

type PublicWork = {
  id: string;
  title: string;
  titleReading: string;
  sortReading: string;
  author: string;
  contributors: Array<{ name: string; role: string; reading: string }>;
  cardUrl: string;
  textUrl: string;
  xhtmlUrl: string;
  sourceMetadata: Work["sourceMetadata"];
};

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
    ? [{ name: work.author, role: "著者", reading: "" }]
    : [];
}

function buildAuthorEntries(catalog: Work[]): Array<AuthorShelf & { reading: string }> {
  const grouped = new Map<string, { works: Work[]; reading: string }>();
  for (const work of catalog) {
    for (const person of workAuthors(work)) {
      const author = person.name.trim();
      if (!author) continue;
      const entry = grouped.get(author) ?? { works: [], reading: person.reading };
      if (!entry.works.some((item) => item.id === work.id)) entry.works.push(work);
      if (!entry.reading && person.reading) entry.reading = person.reading;
      grouped.set(author, entry);
    }
  }

  return [...grouped.entries()]
    .map(([author, entry]) => ({
      author,
      reading: entry.reading,
      workCount: entry.works.length,
      sampleTitles: entry.works.slice(0, AUTHOR_SAMPLE_TITLE_LIMIT).map((work) => work.title),
    }))
    .sort((left, right) => compareJapaneseReadings(left.reading, right.reading) || left.author.localeCompare(right.author, "ja"));
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

function toPublicWork(work: Work): PublicWork {
  return {
    id: work.id,
    title: work.title,
    titleReading: work.titleReading,
    sortReading: work.sortReading,
    author: work.author,
    contributors: work.contributors.map(({ name, role, reading }) => ({ name, role, reading })),
    cardUrl: work.cardUrl,
    textUrl: work.textUrl,
    xhtmlUrl: work.xhtmlUrl,
    sourceMetadata: work.sourceMetadata,
  };
}

async function loadSellableCatalog(): Promise<{ ready: boolean; works: Work[] }> {
  if (!isCurrentAozoraRightsPolicyReady()) return { ready: false, works: [] };
  const config = getSupabaseServerConfig();
  if (!config) return { ready: false, works: [] };
  const binding = getCurrentAozoraRightsPolicyBinding();
  const approval = await callOrderRpc(config, "get_amuhon_aozora_sellable_work_facts_v1", {
    p_policy_id: binding.policyId,
    p_policy_version: binding.policyVersion,
    p_policy_sha256: binding.policySha256,
  });
  if (!approval.ok || !approval.data || approval.data.ready !== true) throw new Error("rights_scope_unavailable");
  const scope = parseAozoraSellableWorkFacts(approval.data.works);
  if (!scope) throw new Error("rights_scope_response_invalid");
  const catalog = await resolveAozoraRightsCatalog();
  return { ready: true, works: filterAozoraWorksByApprovedScope(catalog.works, scope) };
}

export async function GET(request: Request) {
  const { searchParams } =
    new URL(request.url);

  const query =
    searchParams.get("q")?.trim() ?? "";
  const browse = searchParams.get("browse");
  const letter = searchParams.get("letter");

  if (letter !== null && !GOJUON_LETTERS.includes(letter)) {
    return Response.json({ error: "五十音の指定が正しくありません。" }, { status: 400 });
  }

  if (!query && !browse) {
    return Response.json({
      works: [],
    });
  }

  if (!query && browse && !["discover", "author", "authors", "works"].includes(browse)) {
    return Response.json({ error: "作品棚を読み込めませんでした。" }, { status: 400 });
  }

  try {
    const resolved = await loadSellableCatalog();
    if (!resolved.ready) {
      return Response.json({ error: "現在、利用可能な作品を表示できません。時間をおいて再試行してください。" }, { status: 503 });
    }
    const catalog = resolved.works;

    if (!query && browse === "discover") {
      const excludedIds = parseExcludedWorkIds(searchParams.get("exclude"));
      if (!excludedIds) return Response.json({ error: "本棚を読み込めませんでした。" }, { status: 400 });
      return Response.json({
        authors: sampleItems(buildAuthorEntries(catalog), AUTHOR_SHELF_LIMIT).map(publicAuthorEntry),
        works: sampleWorks(catalog, excludedIds).map(toPublicWork),
      });
    }

    if (!query && browse === "works") {
      const offset = parseOffset(searchParams.get("offset"));
      if (offset === null) return Response.json({ error: "作品一覧を読み込めませんでした。" }, { status: 400 });
      const sorted = [...catalog].sort((left, right) => {
        const leftReading = left.sortReading || left.titleReading;
        const rightReading = right.sortReading || right.titleReading;
        return compareJapaneseReadings(leftReading, rightReading) || left.title.localeCompare(right.title, "ja") || left.id.localeCompare(right.id);
      });
      const availableLetters = getAvailableGojuonLetters(sorted.map((work) => work.sortReading || work.titleReading));
      const filtered = letter ? sorted.filter((work) => getGojuonIndexLetter(work.sortReading || work.titleReading) === letter) : sorted;
      const works = filtered.slice(offset, offset + WORK_LIST_PAGE_SIZE);
      const nextOffset = offset + works.length;
      return Response.json({ works: works.map(toPublicWork), total: filtered.length, nextOffset, hasMore: nextOffset < filtered.length, availableLetters });
    }

    if (!query && browse === "authors") {
      const offset = parseOffset(searchParams.get("offset"));
      if (offset === null) return Response.json({ error: "作家一覧を読み込めませんでした。" }, { status: 400 });
      const authors = buildAuthorEntries(catalog);
      const availableLetters = getAvailableGojuonLetters(authors.map((author) => author.reading));
      const filtered = letter ? authors.filter((author) => getGojuonIndexLetter(author.reading) === letter) : authors;
      const page = filtered.slice(offset, offset + AUTHOR_LIST_PAGE_SIZE);
      const nextOffset = offset + page.length;
      return Response.json({
        authors: page.map(publicAuthorEntry),
        total: filtered.length,
        nextOffset,
        hasMore: nextOffset < filtered.length,
        availableLetters,
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
        works: works.map(toPublicWork),
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
      works: results.map(toPublicWork),
    });
  } catch {
    console.error("[works] SELLABLE_CATALOG_LOOKUP_FAILED");

    return Response.json(
      {
        error: "作品情報を確認できませんでした。時間をおいて再試行してください。",
      },
      {
        status: 500,
      }
    );
  }
}
