import type { BookData } from "./book.ts";
import { parseLocalOrderPdfRequest } from "./local-order-pdf-request.ts";

export const FINAL_TYPOGRAPHY_SESSION_KEY = "amuhon-dev-final-body-typography";
export const FINAL_PRELOADED_WORKS_SESSION_KEY = "amuhon-dev-final-preview-works";
export const NOTO_SERIF_JP_FONT_FAMILY = "Noto Serif JP";
export const NOTO_SERIF_JP_UNAVAILABLE_MESSAGE =
  "Noto Serif JPの開発用フォントを読み込めません。C:\\Windows\\Fonts\\NotoSerifJP-VF.ttf があるか確認してください。";

export type FinalBodyTypography = "serif" | "noto-serif-jp";
export type FinalPreviewWorkText = {
  id: string;
  title: string;
  author: string;
  text: string;
};

const MAX_TOTAL_WORK_TEXT_BYTES = 8_000_000;
const MAX_SINGLE_WORK_TEXT_BYTES = 4_000_000;

export function isFinalBodyTypography(value: unknown): value is FinalBodyTypography {
  return value === "serif" || value === "noto-serif-jp";
}

/** Match cached text to the selected work snapshot and reject arbitrary or oversized payloads. */
export function parseFinalPreviewWorkTexts(
  value: unknown,
  book: BookData,
): FinalPreviewWorkText[] | null {
  if (!Array.isArray(value) || value.length !== book.works.length || value.length === 0) return null;
  const parsed: FinalPreviewWorkText[] = [];
  let totalBytes = 0;

  for (const [index, rawWork] of value.entries()) {
    if (!rawWork || typeof rawWork !== "object" || Array.isArray(rawWork)) return null;
    const item = rawWork as Record<string, unknown>;
    const selected = book.works[index];
    if (!selected || item.id !== selected.id || item.title !== selected.title ||
        item.author !== selected.author || typeof item.text !== "string" || !item.text.trim()) return null;
    const textBytes = new TextEncoder().encode(item.text).byteLength;
    if (textBytes > MAX_SINGLE_WORK_TEXT_BYTES) return null;
    totalBytes += textBytes;
    if (totalBytes > MAX_TOTAL_WORK_TEXT_BYTES) return null;
    parsed.push({ id: selected.id, title: selected.title, author: selected.author, text: item.text });
  }

  return parsed;
}

export type FinalTypographyPreviewRequest = {
  book: BookData;
  bodyPdfPageCount: number;
  bodyTypography: FinalBodyTypography;
  works: FinalPreviewWorkText[];
};

export function parseFinalTypographyPreviewRequest(input: unknown): FinalTypographyPreviewRequest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (!isFinalBodyTypography(raw.bodyTypography)) return null;

  const base = parseLocalOrderPdfRequest({
    book: raw.book,
    bodyPdfPageCount: raw.bodyPdfPageCount,
  });
  if (!base) return null;
  const works = parseFinalPreviewWorkTexts(raw.works, base.book);
  if (!works) return null;
  return { ...base, bodyTypography: raw.bodyTypography, works };
}
