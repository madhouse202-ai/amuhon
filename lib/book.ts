export type CoverStyle = "classic" | "free";

export type CoverColor = "red" | "blue" | "green";

export type BookWork = {
  id: string;
  title: string;
  author: string;
  cardUrl: string;
  textUrl: string;
  xhtmlUrl: string;
};

export type BookData = {
  works: BookWork[];
  title: string;
  editor: string;
  coverStyle: CoverStyle;
  coverColor: CoverColor;
  /** Official cover-calculator inputs for the separate spread artwork. */
  coverPaperCode?: string;
  coverSpineWidthMm?: number;
  coverSpineWidthPageCount?: number;
  /** True only after the user confirms this is the matching official calculator result. */
  coverSpineWidthConfirmed?: boolean;
};

/** Stable snapshot key for validating that the final-page count belongs to the same book. */
export function bookLayoutKey(book: BookData, title = book.title, editor = book.editor): string {
  return JSON.stringify({
    title,
    editor,
    works: book.works.map((work) => [work.id, work.title, work.author, work.xhtmlUrl]),
  });
}

export const defaultBookData: BookData = {
  works: [],
  title: "わたしの本",
  editor: "編者",
  coverStyle: "classic",
  coverColor: "red",
};

const STORAGE_KEY = "amuhon-book";

export function saveBookData(data: BookData) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(data)
  );
}

export function loadBookData(): BookData {
  const saved = localStorage.getItem(STORAGE_KEY);

  if (!saved) {
    return defaultBookData;
  }

  try {
    return {
      ...defaultBookData,
      ...JSON.parse(saved),
    };
  } catch {
    return defaultBookData;
  }
}
