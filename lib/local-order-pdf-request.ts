import type { BookData, BookWork } from "./book.ts";
import { isSubmissionPageCount } from "./production.ts";
import { parseFinalPreviewWorkTexts, type FinalPreviewWorkText } from "./final-work-text-snapshot.ts";

const MAX_WORKS = 100;
const MAX_URL_LENGTH = 2048;

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : null;
}

function safeAozoraUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" ||
        !["aozora.gr.jp", "www.aozora.gr.jp"].includes(url.hostname) ||
        url.username || url.password || url.port ||
        !url.pathname.startsWith("/cards/")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export type LocalOrderPdfRequest = {
  book: BookData;
  bodyPdfPageCount: number;
  preloadedWorks?: FinalPreviewWorkText[];
};

/** Accept only the app's bounded Aozora book snapshot; never accept HTML, paths, or render URLs. */
export function parseLocalOrderPdfRequest(input: unknown): LocalOrderPdfRequest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (!raw.book || typeof raw.book !== "object" || Array.isArray(raw.book)) return null;
  const source = raw.book as Record<string, unknown>;
  if (!Array.isArray(source.works) || source.works.length < 1 || source.works.length > MAX_WORKS) return null;

  const title = boundedText(source.title, 200);
  const editor = boundedText(source.editor, 100);
  if (!title || !editor ||
      (source.coverStyle !== "classic" && source.coverStyle !== "free") ||
      (source.coverColor !== "red" && source.coverColor !== "blue" && source.coverColor !== "green") ||
      !Number.isInteger(raw.bodyPdfPageCount) || !isSubmissionPageCount(raw.bodyPdfPageCount as number)) return null;

  const works: BookWork[] = [];
  const ids = new Set<string>();
  for (const item of source.works) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const work = item as Record<string, unknown>;
    const id = boundedText(work.id, 200);
    const workTitle = boundedText(work.title, 500);
    if (!id || !workTitle || typeof work.author !== "string" || work.author.length > 300 || ids.has(id)) return null;
    const cardUrl = safeAozoraUrl(work.cardUrl);
    const textUrl = safeAozoraUrl(work.textUrl);
    const xhtmlUrl = safeAozoraUrl(work.xhtmlUrl);
    if (!cardUrl || !textUrl || !xhtmlUrl) return null;
    let contributors: BookWork["contributors"];
    if (work.contributors !== undefined) {
      if (!Array.isArray(work.contributors) || work.contributors.length > 20) return null;
      contributors = [];
      for (const value of work.contributors) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const contributor = value as Record<string, unknown>;
        if (typeof contributor.name !== "string" || !contributor.name.trim() || contributor.name.length > 300 ||
            typeof contributor.role !== "string" || !contributor.role.trim() || contributor.role.length > 80) return null;
        contributors.push({ name: contributor.name.trim(), role: contributor.role.trim() });
      }
    }
    let sourceMetadata: BookWork["sourceMetadata"];
    if (work.sourceMetadata !== undefined) {
      if (!work.sourceMetadata || typeof work.sourceMetadata !== "object" || Array.isArray(work.sourceMetadata)) return null;
      const metadata = work.sourceMetadata as Record<string, unknown>;
      const keys = ["firstPublication", "baseText", "basePublisher", "inputter", "proofreader"];
      if (Object.keys(metadata).some((key) => !keys.includes(key)) || keys.some((key) => typeof metadata[key] !== "string" || (metadata[key] as string).length > 2000)) return null;
      sourceMetadata = {
        firstPublication: metadata.firstPublication as string,
        baseText: metadata.baseText as string,
        basePublisher: metadata.basePublisher as string,
        inputter: metadata.inputter as string,
        proofreader: metadata.proofreader as string,
      };
    }
    const sourceSha256 = work.sourceSha256 === undefined ? undefined :
      typeof work.sourceSha256 === "string" && /^[a-f0-9]{64}$/.test(work.sourceSha256) ? work.sourceSha256 : null;
    const rightsNotice = work.rightsNotice === undefined ? undefined :
      typeof work.rightsNotice === "string" && work.rightsNotice.trim().length > 0 && work.rightsNotice.length <= 1000 ? work.rightsNotice : null;
    if (sourceSha256 === null || rightsNotice === null || ((sourceSha256 === undefined) !== (rightsNotice === undefined))) return null;
    ids.add(id);
    works.push({ id, title: workTitle, author: work.author.trim(), cardUrl, textUrl, xhtmlUrl, contributors, sourceMetadata, sourceSha256, rightsNotice });
  }

  const book: BookData = { title, editor, coverStyle: source.coverStyle, coverColor: source.coverColor, works };
  const hasPreloadedWorks = Object.hasOwn(raw, "preloadedWorks");
  const preloadedWorks = hasPreloadedWorks ? parseFinalPreviewWorkTexts(raw.preloadedWorks, book) : null;
  if (hasPreloadedWorks && preloadedWorks === null) return null;

  return {
    bodyPdfPageCount: raw.bodyPdfPageCount as number,
    book,
    ...(preloadedWorks ? { preloadedWorks } : {}),
  };
}
