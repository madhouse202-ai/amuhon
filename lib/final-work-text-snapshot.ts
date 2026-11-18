import type { BookData } from "./book.ts";

export type FinalPreviewWorkText = {
  id: string;
  title: string;
  author: string;
  text: string;
};

const MAX_TOTAL_WORK_TEXT_BYTES = 8_000_000;
const MAX_SINGLE_WORK_TEXT_BYTES = 4_000_000;

/** Match browser-held public work text to the selected works and reject arbitrary or oversized payloads. */
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
