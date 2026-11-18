import type { BookData } from "./book.ts";
import { BOOK_PRODUCTION } from "./production.ts";
import { renderSpreadCoverPng } from "./cover-renderer.ts";

/** High-resolution print asset. Import only from server-renderer or gated dev paths. */
export function createSpreadCoverPngBlob(
  book: Pick<BookData, "title" | "editor" | "coverStyle" | "coverColor">,
  bodyPdfPageCount: number,
  showSpineText = true,
): Promise<Blob> {
  return renderSpreadCoverPng(book, bodyPdfPageCount, showSpineText, BOOK_PRODUCTION.dpi);
}
