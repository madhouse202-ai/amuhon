import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { BookWork, CatalogSourceMetadata } from "./book.ts";

const CATALOG_URL = "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip";
const MAX_CATALOG_BYTES = 20 * 1024 * 1024;
const MAX_CATALOG_CSV_CHARS = 100 * 1024 * 1024;
const MAX_XHTML_BYTES = 8 * 1024 * 1024;
const CATALOG_CACHE_MS = 5 * 60 * 1000;

type CatalogContributor = { name: string; role: string; reading: string };
type CatalogWork = BookWork & {
  titleReading: string;
  sortReading: string;
  contributors: CatalogContributor[];
  sourceMetadata: CatalogSourceMetadata;
};
export type VerifiedAozoraWork = CatalogWork & { sourceSha256: string };

let catalogCache: { expiresAt: number; promise: Promise<Map<string, CatalogWork>> } | null = null;

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
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

function normalizeColumnName(value: string): string {
  return value.trim().replace(/^\uFEFF/, "").replace(/^"|"$/g, "").replace(/\s+/g, "").replace(/　/g, "");
}

function requiredAozoraUrl(value: string, id: string, extension: "html" | "txt" | "card"): string | null {
  try {
    const url = new URL(value);
    const allowedHost = url.hostname === "www.aozora.gr.jp" || url.hostname === "aozora.gr.jp";
    if (!allowedHost || url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
    if (extension === "card") {
      return new RegExp(`^/cards/${id}/[^/]+\\.html$`, "i").test(url.pathname) ? url.toString() : null;
    }
    return new RegExp(`^/cards/${id}/files/[^/]+\\.${extension}$`, "i").test(url.pathname) ? url.toString() : null;
  } catch {
    return null;
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("source_too_large");
  if (!response.body) throw new Error("source_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("source_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function buildCatalog(csvText: string): Map<string, CatalogWork> {
  if (csvText.length > MAX_CATALOG_CSV_CHARS) throw new Error("catalog_too_large");
  const lines = csvText.split(/\r?\n/);
  if (!lines[0]) throw new Error("catalog_header_missing");
  const header = parseCsvLine(lines[0]).map(normalizeColumnName);
  const find = (...names: string[]) => header.findIndex((column) => names.some((name) => column === normalizeColumnName(name)));
  const indexes = {
    id: find("作品ID", "作品ＩＤ", "作品id"),
    title: find("作品名"),
    cardUrl: find("図書カードURL", "図書カード", "カードURL"),
    textUrl: find("テキストファイルURL", "テキストURL", "テキストファイル"),
    xhtmlUrl: find("XHTMLファイルURL", "XHTML/HTMLファイルURL", "XHTML/HTMLファイル", "HTMLファイルURL", "XHTMLURL"),
    lastName: find("姓"),
    firstName: find("名"),
    role: find("役割フラグ", "役割"),
    lastNameReading: find("姓読み", "姓よみ"),
    firstNameReading: find("名読み", "名よみ"),
    titleReading: find("作品名読み", "作品名よみ"),
    sortReading: find("ソート用読み", "ソート用よみ"),
    firstPublication: find("初出"),
    baseText: find("底本名1", "底本1", "底本名"),
    basePublisher: find("底本出版社名1", "底本出版社1", "底本出版社名"),
    inputter: find("入力者", "入力者名"),
    proofreader: find("校正者", "校正者名"),
  };
  if ([indexes.id, indexes.title, indexes.cardUrl, indexes.textUrl, indexes.xhtmlUrl].some((index) => index < 0)) {
    throw new Error("catalog_required_column_missing");
  }

  const works = new Map<string, CatalogWork>();
  const ambiguousIds = new Set<string>();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const columns = parseCsvLine(line);
    const id = columns[indexes.id]?.trim() ?? "";
    const title = columns[indexes.title]?.trim() ?? "";
    if (!/^\d{1,12}$/.test(id) || !title) continue;
    const cardUrl = columns[indexes.cardUrl]?.trim() ?? "";
    const textUrl = columns[indexes.textUrl]?.trim() ?? "";
    const xhtmlUrl = columns[indexes.xhtmlUrl]?.trim() ?? "";
    const lastName = indexes.lastName < 0 ? "" : columns[indexes.lastName]?.trim() ?? "";
    const firstName = indexes.firstName < 0 ? "" : columns[indexes.firstName]?.trim() ?? "";
    const name = `${lastName} ${firstName}`.trim();
    const role = indexes.role < 0 ? "著者" : columns[indexes.role]?.trim() ?? "";
    const reading = `${indexes.lastNameReading < 0 ? "" : columns[indexes.lastNameReading]?.trim() ?? ""} ${indexes.firstNameReading < 0 ? "" : columns[indexes.firstNameReading]?.trim() ?? ""}`.trim();
    let work = works.get(id);
    if (work && (work.title !== title || work.cardUrl !== cardUrl || work.textUrl !== textUrl || work.xhtmlUrl !== xhtmlUrl)) {
      ambiguousIds.add(id);
      continue;
    }
    if (!work) {
      work = {
        id,
        title,
        titleReading: indexes.titleReading < 0 ? "" : columns[indexes.titleReading]?.trim() ?? "",
        sortReading: indexes.sortReading < 0 ? "" : columns[indexes.sortReading]?.trim() ?? "",
        author: "",
        cardUrl,
        textUrl,
        xhtmlUrl,
        contributors: [],
        sourceMetadata: { firstPublication: "", baseText: "", basePublisher: "", inputter: "", proofreader: "" },
      };
      works.set(id, work);
    }
    if (!work.titleReading && indexes.titleReading >= 0) work.titleReading = columns[indexes.titleReading]?.trim() ?? "";
    if (!work.sortReading && indexes.sortReading >= 0) work.sortReading = columns[indexes.sortReading]?.trim() ?? "";
    const metadata: CatalogSourceMetadata = {
      firstPublication: indexes.firstPublication < 0 ? "" : columns[indexes.firstPublication]?.trim() ?? "",
      baseText: indexes.baseText < 0 ? "" : columns[indexes.baseText]?.trim() ?? "",
      basePublisher: indexes.basePublisher < 0 ? "" : columns[indexes.basePublisher]?.trim() ?? "",
      inputter: indexes.inputter < 0 ? "" : columns[indexes.inputter]?.trim() ?? "",
      proofreader: indexes.proofreader < 0 ? "" : columns[indexes.proofreader]?.trim() ?? "",
    };
    for (const key of Object.keys(metadata) as Array<keyof CatalogSourceMetadata>) {
      if (!work.sourceMetadata[key] && metadata[key]) work.sourceMetadata[key] = metadata[key];
    }
    if (name && role && !work.contributors.some((person) => person.name === name && person.role === role)) {
      work.contributors.push({ name, role, reading });
    }
    if (["著者", "作者", "原著者"].includes(role) && name) {
      work.author = [...new Set(work.contributors.filter((person) => ["著者", "作者", "原著者"].includes(person.role)).map((person) => person.name))].join("・");
    }
  }
  for (const id of ambiguousIds) works.delete(id);
  return works;
}

async function loadCatalog(fetcher: typeof fetch): Promise<Map<string, CatalogWork>> {
  if (catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.promise;
  {
    const current = (async () => {
      const response = await fetcher(CATALOG_URL, {
        redirect: "error",
        cache: "no-store",
        headers: { "User-Agent": "Amuhon/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("catalog_fetch_failed");
      if (response.url && response.url !== CATALOG_URL) throw new Error("catalog_redirect_rejected");
      const archive = await readBoundedBody(response, MAX_CATALOG_BYTES);
      const zip = await JSZip.loadAsync(archive);
      const csvName = Object.keys(zip.files).find((name) => name.endsWith(".csv"));
      if (!csvName) throw new Error("catalog_csv_missing");
      const csvText = await zip.files[csvName].async("string");
      return buildCatalog(csvText);
    })();
    const entry = { expiresAt: Date.now() + CATALOG_CACHE_MS, promise: current };
    catalogCache = entry;
    current.catch(() => {
      if (catalogCache === entry) catalogCache = null;
    });
    return current;
  }
}

async function fetchEdition(work: CatalogWork, fetcher: typeof fetch): Promise<VerifiedAozoraWork> {
  const cardUrl = requiredAozoraUrl(work.cardUrl, work.id, "card");
  const textUrl = requiredAozoraUrl(work.textUrl, work.id, "txt");
  const xhtmlUrl = requiredAozoraUrl(work.xhtmlUrl, work.id, "html");
  if (!cardUrl || !textUrl || !xhtmlUrl || work.contributors.length === 0 || work.contributors.length > 20 ||
      work.title.length > 500 || work.author.length > 300 ||
      work.contributors.some((person) => !person.name || person.name.length > 300 || !person.role || person.role.length > 80) ||
      Object.values(work.sourceMetadata).some((value) => value.length > 2000)) throw new Error("catalog_work_invalid");
  const response = await fetcher(xhtmlUrl, {
    redirect: "error",
    cache: "no-store",
    headers: { "User-Agent": "Amuhon/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("edition_fetch_failed");
  if (response.url && response.url !== xhtmlUrl) throw new Error("edition_redirect_rejected");
  const bytes = await readBoundedBody(response, MAX_XHTML_BYTES);
  const asciiHead = new TextDecoder("ascii").decode(bytes.slice(0, Math.min(bytes.length, 1024 * 1024)));
  if (!/<(?:!doctype\s+html|html|div)\b/i.test(asciiHead) || !/<div\b[^>]*class=["'][^"']*\bmain_text\b/i.test(asciiHead)) {
    throw new Error("edition_body_missing");
  }
  return {
    ...work,
    cardUrl,
    textUrl,
    xhtmlUrl,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Resolves IDs through the fixed Aozora catalog and hashes the exact XHTML bytes used by /final. */
export async function resolveAozoraWorkEditions(ids: string[], fetcher: typeof fetch = fetch): Promise<VerifiedAozoraWork[]> {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((id) => !/^\d{1,12}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error("work_ids_invalid");
  }
  const catalog = await loadCatalog(fetcher);
  const selected = ids.map((id) => {
    const work = catalog.get(id);
    if (!work) throw new Error("catalog_work_missing");
    return work;
  });
  const verified: VerifiedAozoraWork[] = [];
  // Keep upstream requests bounded while retaining the requested book order.
  for (let offset = 0; offset < selected.length; offset += 4) {
    const group = await Promise.all(selected.slice(offset, offset + 4).map((work) => fetchEdition(work, fetcher)));
    verified.push(...group);
  }
  return verified;
}
