import type { BookData, BookWork } from "./book.ts";
import { isSubmissionPageCount } from "./production.ts";

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
    ids.add(id);
    works.push({ id, title: workTitle, author: work.author.trim(), cardUrl, textUrl, xhtmlUrl });
  }

  return {
    bodyPdfPageCount: raw.bodyPdfPageCount as number,
    book: {
      title,
      editor,
      coverStyle: source.coverStyle,
      coverColor: source.coverColor,
      works,
    },
  };
}
