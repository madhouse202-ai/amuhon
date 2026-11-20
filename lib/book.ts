import { parseAozoraCommercialRightsSnapshot, type AozoraCommercialRightsSnapshot } from "./aozora-commercial-rights-schema.ts";

export type CoverStyle = "classic" | "free";

export type CoverColor = "red" | "blue" | "green";

export type BookContributor = { name: string; role: string };
export type CatalogSourceMetadata = {
  firstPublication: string;
  baseText: string;
  basePublisher: string;
  inputter: string;
  proofreader: string;
};

export type BookWork = {
  id: string;
  title: string;
  author: string;
  cardUrl: string;
  textUrl: string;
  xhtmlUrl: string;
  /** Role-aware catalog people retained for rights checks and source notes. */
  contributors?: BookContributor[];
  sourceMetadata?: CatalogSourceMetadata;
  /** Exact server-verified text revision; clients cannot assert this value. */
  sourceSha256?: string;
  /** Server-copied license or permission notice printed in the source note. */
  rightsNotice?: string;
  /** Server-generated official-catalog rights facts; never accepted from a browser request. */
  catalogRights?: AozoraCommercialRightsSnapshot;
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

export type BookDraftReadResult =
  | { status: "ready"; data: BookData; hasSavedData: boolean }
  | { status: "corrupt" | "unavailable" };

function isBookWork(value: unknown): value is BookWork {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const work = value as Record<string, unknown>;
  if (!["id", "title", "author", "cardUrl", "textUrl", "xhtmlUrl"]
    .every((key) => typeof work[key] === "string")) return false;
  if (work.contributors !== undefined && (!Array.isArray(work.contributors) || work.contributors.length > 20 ||
      !work.contributors.every((item) => item && typeof item === "object" && !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).name === "string" &&
        typeof (item as Record<string, unknown>).role === "string"))) return false;
  if (work.sourceMetadata !== undefined) {
    const metadata = work.sourceMetadata as Record<string, unknown>;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
        ["firstPublication", "baseText", "basePublisher", "inputter", "proofreader"].some((key) => typeof metadata[key] !== "string" || (metadata[key] as string).length > 2000)) return false;
  }
  return (work.sourceSha256 === undefined || (typeof work.sourceSha256 === "string" && /^[a-f0-9]{64}$/.test(work.sourceSha256))) &&
    (work.rightsNotice === undefined || (typeof work.rightsNotice === "string" && work.rightsNotice.length <= 1000)) &&
    (work.catalogRights === undefined || parseAozoraCommercialRightsSnapshot(work.catalogRights) !== null);
}

/**
 * Reads the existing local draft format without treating corrupt or inaccessible
 * storage as an empty draft. Callers can then fail closed instead of overwriting it.
 */
export function readBookDraft(): BookDraftReadResult {
  let saved: string | null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { status: "unavailable" };
  }

  if (saved === null) {
    return {
      status: "ready",
      data: { ...defaultBookData, works: [] },
      hasSavedData: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(saved);
  } catch {
    return { status: "corrupt" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "corrupt" };
  }

  const data = { ...defaultBookData, ...(parsed as Partial<BookData>) };
  if (
    !Array.isArray(data.works) ||
    !data.works.every(isBookWork) ||
    typeof data.title !== "string" ||
    typeof data.editor !== "string" ||
    (data.coverStyle !== "classic" && data.coverStyle !== "free") ||
    (data.coverColor !== "red" && data.coverColor !== "blue" && data.coverColor !== "green")
  ) {
    return { status: "corrupt" };
  }

  return { status: "ready", data, hasSavedData: true };
}

export function saveBookData(data: BookData) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(data)
  );
}

/** Writes a draft without throwing into the editing flow when browser storage is full or blocked. */
export function trySaveBookDraft(data: BookData): boolean {
  try {
    saveBookData(data);
    return true;
  } catch {
    return false;
  }
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
