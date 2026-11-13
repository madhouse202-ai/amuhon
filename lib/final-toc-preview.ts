import {
  calculateTocLayout,
  calculateWorkStartPages,
  type TocEntry,
  type TocWork,
} from "./book-layout.ts";
import { LONG_FIXTURE_SOURCES } from "./final-typography-comparison.ts";

export const FINAL_TOC_PREVIEW_PAGE_WIDTH_MM = 105;
export const FINAL_TOC_PREVIEW_PAGE_HEIGHT_MM = 148;
export const FINAL_TOC_PREVIEW_CONTENT_WIDTH_MM = 81;
export const FINAL_TOC_PREVIEW_LIST_HEIGHT_MM = 88;
export const FINAL_TOC_PREVIEW_ENTRY_GAP_MM = 3;
export const FINAL_TOC_VERTICAL_TITLE_COLUMN_WIDTH_MM = 4.2;
export const FINAL_TOC_VERTICAL_AUTHOR_COLUMN_WIDTH_MM = 3.4;
export const FINAL_TOC_VERTICAL_NUMBER_COLUMN_WIDTH_MM = 8.5;
export const FINAL_TOC_VERTICAL_COLUMN_GAP_MM = 0.8;
export const FINAL_TOC_VERTICAL_TITLE_CHARS_PER_COLUMN = 19;
export const FINAL_TOC_VERTICAL_AUTHOR_CHARS_PER_COLUMN = 25;
export const FINAL_TOC_VERTICAL_LIST_TOP_MM = 39;
export const FINAL_TOC_VERTICAL_PAGE_NUMBER_TOP_MM = FINAL_TOC_VERTICAL_LIST_TOP_MM + 69;
export const FINAL_TOC_VERTICAL_BOTTOM_MARGIN_MM = 21;
export const FINAL_TOC_VERTICAL_TITLE_LINE_HEIGHT_MM = 8.5 * 25.4 / 72 * 1.45;
export const FINAL_TOC_VERTICAL_AUTHOR_LINE_HEIGHT_MM = 7 * 25.4 / 72 * 1.35;
export const FINAL_TOC_SHIFT_RATIOS = [0.4, 0.45] as const;

/** Real title/author metadata; page counts below are a deterministic layout sample, not the live anthology. */
export const FOUR_WORK_TOC_PREVIEW_WORKS: TocWork[] = LONG_FIXTURE_SOURCES.map((work, index) => ({
  id: `work-${index + 1}`,
  title: work.title,
  author: work.author,
}));

/** Sample-only body page counts, chosen to exercise one- and two-digit start pages. */
export const FOUR_WORK_TOC_PREVIEW_BODY_PAGE_COUNTS = [20, 1, 19, 14] as const;

/** Fictional entries used only to exercise long labels, three-digit numbers, and multiple TOC pages. */
export const TOC_PREVIEW_STRESS_WORKS: TocWork[] = Array.from({ length: 18 }, (_, index) => ({
  id: `stress-${index + 1}`,
  title: index % 3 === 0
    ? `目次レイアウトの縦書き折り返しと改ページを検証する長い作品名・第${index + 1}編`
    : `試作作品${index + 1}`,
  author: index % 4 === 0
    ? `縦書き目次の長い著者名を折り返し確認する作家${index + 1}`
    : `著者${index + 1}`,
}));

export const TOC_PREVIEW_STRESS_BODY_PAGE_COUNTS = [
  25, 12, 18, 1, 32, 22, 25, 13, 7, 21, 1, 40, 18, 12, 30, 11, 16, 1,
] as const;

const TOC_PREVIEW_TITLE_FONT_SIZE_PT = 9;
const TOC_PREVIEW_AUTHOR_FONT_SIZE_PT = 7.2;
const TOC_PREVIEW_TITLE_LINE_HEIGHT_MM = 4.4;
const TOC_PREVIEW_AUTHOR_LINE_HEIGHT_MM = 3.5;
const TOC_PREVIEW_ROW_PADDING_MM = 3.2;
const TOC_PREVIEW_MIN_ROW_HEIGHT_MM = 11.5;
const TOC_PREVIEW_NUMBER_WIDTH_MM = 14;
const TOC_PREVIEW_NUMBER_GAP_MM = 3;

function fullWidthCharactersPerLine(fontSizePt: number, widthMm: number): number {
  const emMm = fontSizePt * 25.4 / 72;
  return Math.max(1, Math.floor(widthMm / emMm));
}

function wrappedLineCount(text: string, charactersPerLine: number): number {
  return Math.max(1, Math.ceil(Array.from(text.trim()).length / charactersPerLine));
}

export function estimateRefinedTocEntryHeightMm(work: TocWork): number {
  const textWidthMm = FINAL_TOC_PREVIEW_CONTENT_WIDTH_MM - TOC_PREVIEW_NUMBER_WIDTH_MM - TOC_PREVIEW_NUMBER_GAP_MM;
  const titleCharsPerLine = fullWidthCharactersPerLine(TOC_PREVIEW_TITLE_FONT_SIZE_PT, textWidthMm);
  const authorCharsPerLine = fullWidthCharactersPerLine(TOC_PREVIEW_AUTHOR_FONT_SIZE_PT, textWidthMm);
  const titleLines = wrappedLineCount(work.title, titleCharsPerLine);
  const authorLines = work.author?.trim()
    ? wrappedLineCount(work.author.trim(), authorCharsPerLine)
    : 0;
  const contentHeight = titleLines * TOC_PREVIEW_TITLE_LINE_HEIGHT_MM +
    authorLines * TOC_PREVIEW_AUTHOR_LINE_HEIGHT_MM + TOC_PREVIEW_ROW_PADDING_MM;
  return Math.max(TOC_PREVIEW_MIN_ROW_HEIGHT_MM, contentHeight);
}

/**
 * Preview-only horizontal TOC pagination. Production pagination remains in book-layout.ts.
 * Page numbers are recomputed with the production start-page function after the TOC page count stabilizes.
 */
export function paginateRefinedTocEntries(works: TocWork[], pageNumbers: number[]): TocEntry[][] {
  const pages: TocEntry[][] = [];
  let current: TocEntry[] = [];
  let usedHeightMm = 0;

  works.forEach((work, workIndex) => {
    const pageNumber = pageNumbers[workIndex] ?? 0;
    const entryHeightMm = estimateRefinedTocEntryHeightMm(work);
    const neededHeightMm = entryHeightMm + (current.length ? FINAL_TOC_PREVIEW_ENTRY_GAP_MM : 0);
    if (current.length && usedHeightMm + neededHeightMm > FINAL_TOC_PREVIEW_LIST_HEIGHT_MM) {
      pages.push(current);
      current = [];
      usedHeightMm = 0;
    }
    if (current.length) usedHeightMm += FINAL_TOC_PREVIEW_ENTRY_GAP_MM;
    usedHeightMm += entryHeightMm;
    current.push({ workIndex, pageNumber });
  });

  if (current.length) pages.push(current);
  return pages.length ? pages : [[]];
}

export function calculateRefinedTocLayout(works: TocWork[], workPageCounts: number[]) {
  if (works.length !== workPageCounts.length || workPageCounts.some((count) => !Number.isInteger(count) || count < 1)) {
    throw new Error("TOC preview requires one positive body page count per work.");
  }

  let tocPageCount = 1;
  for (let iteration = 0; iteration <= works.length + 1; iteration += 1) {
    const pageLayout = calculateWorkStartPages(workPageCounts, tocPageCount);
    const pages = paginateRefinedTocEntries(works, pageLayout.workStartPages);
    if (pages.length === tocPageCount) {
      return {
        pages,
        pageNumbers: pageLayout.workStartPages,
        colophonPageNumber: pageLayout.colophonPageNumber,
      };
    }
    tocPageCount = pages.length;
  }

  throw new Error("Refined TOC preview pagination did not stabilize.");
}

export function estimateVerticalTocEntryWidthMm(work: TocWork): number {
  const titleColumns = Math.max(1, Math.ceil(Array.from(work.title.trim()).length / FINAL_TOC_VERTICAL_TITLE_CHARS_PER_COLUMN));
  const authorLength = work.author?.trim() ? Array.from(work.author.trim()).length : 0;
  const authorColumns = authorLength
    ? Math.max(1, Math.ceil(authorLength / FINAL_TOC_VERTICAL_AUTHOR_CHARS_PER_COLUMN))
    : 0;
  const titleWidth = titleColumns * FINAL_TOC_VERTICAL_TITLE_COLUMN_WIDTH_MM;
  const authorWidth = authorColumns * FINAL_TOC_VERTICAL_AUTHOR_COLUMN_WIDTH_MM;
  const numberWidth = FINAL_TOC_VERTICAL_NUMBER_COLUMN_WIDTH_MM;
  const dividerCount = authorColumns ? 2 : 1;
  return titleWidth + authorWidth + numberWidth + dividerCount * FINAL_TOC_VERTICAL_COLUMN_GAP_MM;
}

export function getShiftedVerticalTocTextGeometry(startRatio: number) {
  if (!FINAL_TOC_SHIFT_RATIOS.some((ratio) => Math.abs(ratio - startRatio) < Number.EPSILON)) {
    throw new Error("Vertical TOC preview supports only the fixed 40% and 45% start positions.");
  }

  const titleStartMm = FINAL_TOC_PREVIEW_PAGE_HEIGHT_MM * startRatio;
  const textBottomMm = FINAL_TOC_PREVIEW_PAGE_HEIGHT_MM - FINAL_TOC_VERTICAL_BOTTOM_MARGIN_MM;
  const textHeightMm = textBottomMm - titleStartMm;
  const titleCharsPerColumn = Math.floor(textHeightMm / FINAL_TOC_VERTICAL_TITLE_LINE_HEIGHT_MM);
  const authorCharsPerColumn = Math.floor(textHeightMm / FINAL_TOC_VERTICAL_AUTHOR_LINE_HEIGHT_MM);
  if (titleCharsPerColumn < 1 || authorCharsPerColumn < 1) {
    throw new Error("Vertical TOC preview has no safe room for a title or author column.");
  }

  return {
    startRatio,
    titleStartMm,
    textBottomMm,
    textHeightMm,
    titleCharsPerColumn,
    authorCharsPerColumn,
  };
}

export function estimateShiftedVerticalTocEntryWidthMm(work: TocWork, startRatio: number): number {
  const geometry = getShiftedVerticalTocTextGeometry(startRatio);
  const titleColumns = Math.max(1, Math.ceil(Array.from(work.title.trim()).length / geometry.titleCharsPerColumn));
  const authorLength = work.author?.trim() ? Array.from(work.author.trim()).length : 0;
  const authorColumns = authorLength
    ? Math.max(1, Math.ceil(authorLength / geometry.authorCharsPerColumn))
    : 0;
  const titleWidth = titleColumns * FINAL_TOC_VERTICAL_TITLE_COLUMN_WIDTH_MM;
  const authorWidth = authorColumns * FINAL_TOC_VERTICAL_AUTHOR_COLUMN_WIDTH_MM;
  const dividerCount = authorColumns ? 2 : 1;
  return titleWidth + authorWidth + FINAL_TOC_VERTICAL_NUMBER_COLUMN_WIDTH_MM + dividerCount * FINAL_TOC_VERTICAL_COLUMN_GAP_MM;
}

function paginateShiftedVerticalTocEntries(works: TocWork[], pageNumbers: number[], startRatio: number): TocEntry[][] {
  const pages: TocEntry[][] = [];
  let current: TocEntry[] = [];
  let usedWidthMm = 0;

  works.forEach((work, workIndex) => {
    const pageNumber = pageNumbers[workIndex] ?? 0;
    const entryWidthMm = estimateShiftedVerticalTocEntryWidthMm(work, startRatio);
    const neededWidthMm = entryWidthMm + (current.length ? FINAL_TOC_PREVIEW_ENTRY_GAP_MM : 0);
    if (current.length && usedWidthMm + neededWidthMm > FINAL_TOC_PREVIEW_CONTENT_WIDTH_MM) {
      pages.push(current);
      current = [];
      usedWidthMm = 0;
    }
    if (current.length) usedWidthMm += FINAL_TOC_PREVIEW_ENTRY_GAP_MM;
    usedWidthMm += entryWidthMm;
    current.push({ workIndex, pageNumber });
  });

  if (current.length) pages.push(current);
  return pages.length ? pages : [[]];
}

export function calculateShiftedVerticalTocLayout(works: TocWork[], workPageCounts: number[], startRatio: number) {
  getShiftedVerticalTocTextGeometry(startRatio);
  if (works.length !== workPageCounts.length || workPageCounts.some((count) => !Number.isInteger(count) || count < 1)) {
    throw new Error("TOC preview requires one positive body page count per work.");
  }

  let tocPageCount = 1;
  for (let iteration = 0; iteration <= works.length + 1; iteration += 1) {
    const pageLayout = calculateWorkStartPages(workPageCounts, tocPageCount);
    const pages = paginateShiftedVerticalTocEntries(works, pageLayout.workStartPages, startRatio);
    if (pages.length === tocPageCount) {
      return {
        pages,
        pageNumbers: pageLayout.workStartPages,
        colophonPageNumber: pageLayout.colophonPageNumber,
      };
    }
    tocPageCount = pages.length;
  }

  throw new Error("Shifted vertical TOC preview pagination did not stabilize.");
}

/** Preview-only vertical right-to-left pagination. Start pages use the production calculator. */
export function paginateVerticalTocEntries(works: TocWork[], pageNumbers: number[]): TocEntry[][] {
  const pages: TocEntry[][] = [];
  let current: TocEntry[] = [];
  let usedWidthMm = 0;

  works.forEach((work, workIndex) => {
    const pageNumber = pageNumbers[workIndex] ?? 0;
    const entryWidthMm = estimateVerticalTocEntryWidthMm(work);
    const neededWidthMm = entryWidthMm + (current.length ? FINAL_TOC_PREVIEW_ENTRY_GAP_MM : 0);
    if (current.length && usedWidthMm + neededWidthMm > FINAL_TOC_PREVIEW_CONTENT_WIDTH_MM) {
      pages.push(current);
      current = [];
      usedWidthMm = 0;
    }
    if (current.length) usedWidthMm += FINAL_TOC_PREVIEW_ENTRY_GAP_MM;
    usedWidthMm += entryWidthMm;
    current.push({ workIndex, pageNumber });
  });

  if (current.length) pages.push(current);
  return pages.length ? pages : [[]];
}

export function calculateVerticalTocLayout(works: TocWork[], workPageCounts: number[]) {
  if (works.length !== workPageCounts.length || workPageCounts.some((count) => !Number.isInteger(count) || count < 1)) {
    throw new Error("TOC preview requires one positive body page count per work.");
  }

  let tocPageCount = 1;
  for (let iteration = 0; iteration <= works.length + 1; iteration += 1) {
    const pageLayout = calculateWorkStartPages(workPageCounts, tocPageCount);
    const pages = paginateVerticalTocEntries(works, pageLayout.workStartPages);
    if (pages.length === tocPageCount) {
      return {
        pages,
        pageNumbers: pageLayout.workStartPages,
        colophonPageNumber: pageLayout.colophonPageNumber,
      };
    }
    tocPageCount = pages.length;
  }

  throw new Error("Vertical TOC preview pagination did not stabilize.");
}

export function calculateTocPreviewPair(works: TocWork[], workPageCounts: number[]) {
  return {
    current: calculateTocLayout(works, workPageCounts),
    refined: calculateRefinedTocLayout(works, workPageCounts),
    vertical: calculateVerticalTocLayout(works, workPageCounts),
    vertical40: calculateShiftedVerticalTocLayout(works, workPageCounts, 0.4),
    vertical45: calculateShiftedVerticalTocLayout(works, workPageCounts, 0.45),
  };
}

