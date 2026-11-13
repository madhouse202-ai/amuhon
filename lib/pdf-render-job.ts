import type { BookData } from "./book.ts";
import {
  parseFinalPreviewWorkTexts,
  type FinalPreviewWorkText,
} from "./final-typography-preview.ts";
import { parseLocalOrderPdfRequest } from "./local-order-pdf-request.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEYS = new Set(["schemaVersion", "jobId", "book", "works"]);

export type PdfRenderJob = {
  schemaVersion: 1;
  jobId: string;
  book: BookData;
  works: FinalPreviewWorkText[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Parse a server-created render snapshot. The fake count is only used to reuse
 * the existing book/URL validator; the actual count always comes from the PDF.
 */
export function parsePdfRenderJob(value: unknown): PdfRenderJob | null {
  if (!isRecord(value) || !hasOnlyKeys(value, JOB_KEYS) ||
      value.schemaVersion !== 1 || typeof value.jobId !== "string" || !UUID_V4.test(value.jobId)) {
    return null;
  }

  const parsed = parseLocalOrderPdfRequest({ book: value.book, bodyPdfPageCount: 24 });
  if (!parsed) return null;
  const rawBook = value.book;
  if (!isRecord(rawBook) || !hasOnlyKeys(rawBook, new Set([
    "title", "editor", "coverStyle", "coverColor", "works",
    "coverPaperCode", "coverSpineWidthMm", "coverSpineWidthPageCount", "coverSpineWidthConfirmed",
  ]))) return null;

  const works = parseFinalPreviewWorkTexts(value.works, parsed.book);
  if (!works) return null;
  return {
    schemaVersion: 1,
    jobId: value.jobId,
    book: parsed.book,
    works,
  };
}
