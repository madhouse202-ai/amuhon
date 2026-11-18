import type { BookData } from "./book.ts";
import { parseLocalOrderPdfRequest } from "./local-order-pdf-request.ts";
import { parseFinalPreviewWorkTexts, type FinalPreviewWorkText } from "./final-work-text-snapshot.ts";
export { parseFinalPreviewWorkTexts } from "./final-work-text-snapshot.ts";
export type { FinalPreviewWorkText } from "./final-work-text-snapshot.ts";

export const FINAL_TYPOGRAPHY_SESSION_KEY = "amuhon-dev-final-body-typography";
export const FINAL_PRELOADED_WORKS_SESSION_KEY = "amuhon-dev-final-preview-works";
export const NOTO_SERIF_JP_FONT_FAMILY = "Noto Serif JP";
export const NOTO_SERIF_CJK_JP_FAMILY = "Noto Serif CJK JP";
export const NOTO_SERIF_CJK_JP_REGULAR_POSTSCRIPT_NAME = "NotoSerifCJKjp-Regular";
export const NOTO_SERIF_JP_FONT_SIZE_BYTES = 24_573_864;
export const NOTO_SERIF_JP_FONT_SHA256 = "D9854C7A8EF170B5A7932558856FD64EB8DE0B007CD823FED6F9F514AD2803D3";
export const NOTO_SERIF_JP_UNAVAILABLE_MESSAGE =
  "Noto Serif CJK JP 2.003の開発用フォントを読み込めません。.local-assets\\fonts\\NotoSerifCJKjp-Regular.otf の配置とSHA-256を確認してください。";

export type FinalBodyTypography = "serif" | "noto-serif-jp";

export function isFinalBodyTypography(value: unknown): value is FinalBodyTypography {
  return value === "serif" || value === "noto-serif-jp";
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
