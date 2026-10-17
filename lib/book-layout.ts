export const CHARS_PER_COLUMN = 40;
export const COLUMNS_PER_PAGE = 16;
export const BODY_RUBY_ENABLED = true;

export type LayoutUnit = {
  type: "text";
  text: string;
  ruby?: string;
};

export type TocWork = { id: string; title: string; author?: string };
export type TocEntry = { workIndex: number; pageNumber: number };

const TOC_FONT_SIZE_PT = 8.5;
const TOC_LINE_HEIGHT = 1.6;
const TOC_CONTENT_WIDTH_MM = 81; // A6 105mm page with 12mm side padding.
const TOC_CONTENT_HEIGHT_MM = 124; // A6 148mm page with 12mm top/bottom padding.
const TOC_ENTRY_GAP_MM = 3;
const TOC_COLUMN_WIDTH_MM = TOC_FONT_SIZE_PT * 25.4 / 72 * TOC_LINE_HEIGHT;

export function unitCharacterCount(unit: LayoutUnit): number {
  return Array.from(unit.text).length;
}

function isLineStartKinsoku(char: string) {
  return "、。，．：；？！‼⁇⁈⁉・ヽヾ々ー）］】〕〉》」』〙〗〟’”｣｝〉》".includes(char);
}

function isLineEndKinsoku(char: string) {
  return "「『（［【〔〈《〘〖〝‘“".includes(char);
}

function plainTextUnits(text: string): LayoutUnit[] {
  return Array.from(text, (char) => ({ type: "text" as const, text: char }));
}

function textToLayoutUnits(text: string, enableRuby: boolean): LayoutUnit[] {
  if (!text) return [];

  const units: LayoutUnit[] = [];
  const rubyPattern = /｜([^《\n]+)《([^》\n]+)》|([一-龯々〆ヵヶ]+)《([^》\n]+)》/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = rubyPattern.exec(text)) !== null) {
    units.push(...plainTextUnits(text.slice(cursor, match.index)));
    const base = match[1] ?? match[3];
    const reading = match[2] ?? match[4];
    if (enableRuby) units.push({ type: "text", text: base, ruby: reading });
    else units.push(...plainTextUnits(base));
    cursor = match.index + match[0].length;
  }

  units.push(...plainTextUnits(text.slice(cursor)));
  return units;
}

function splitParagraphIntoColumns(units: LayoutUnit[]): LayoutUnit[][] {
  const columns: LayoutUnit[][] = [];
  let current: LayoutUnit[] = [];
  let currentCharacterCount = 0;

  const flush = () => {
    if (!current.length) return;
    columns.push(current);
    current = [];
    currentCharacterCount = 0;
  };

  for (const unit of units) {
    const characters = Array.from(unit.text);
    const firstChar = characters[0];
    const lastChar = characters[characters.length - 1];
    const unitLength = unitCharacterCount(unit);
    if (!firstChar) continue;
    if (unit.text === "\n") {
      flush();
      continue;
    }

    if (currentCharacterCount + unitLength > CHARS_PER_COLUMN) {
      if (isLineStartKinsoku(firstChar) && current.length > 0) {
        const last = current.pop();
        if (last) currentCharacterCount -= unitCharacterCount(last);
        flush();
        if (last) {
          current.push(last);
          currentCharacterCount += unitCharacterCount(last);
        }
        current.push(unit);
        currentCharacterCount += unitLength;
        continue;
      }
      flush();
    }

    if (currentCharacterCount + unitLength === CHARS_PER_COLUMN && isLineEndKinsoku(lastChar)) flush();
    current.push(unit);
    currentCharacterCount += unitLength;
  }

  flush();
  return columns;
}

export function splitTextIntoColumns(text: string, enableRuby = BODY_RUBY_ENABLED): LayoutUnit[][] {
  const units: LayoutUnit[] = [];
  const paragraphs = text
    .split(/\r?\n(?:[ \t]*\r?\n)+/)
    .map((paragraph) => paragraph.replace(/\r?\n/g, ""))
    .filter((paragraph) => paragraph.trim());

  paragraphs.forEach((paragraph, index) => {
    if (index > 0) units.push({ type: "text", text: "\n" });
    const normalizedParagraph = paragraph.replace(/^　+/, "");
    if (!normalizedParagraph.startsWith("「")) units.push({ type: "text", text: "　" });
    units.push(...textToLayoutUnits(normalizedParagraph, enableRuby));
  });

  return splitParagraphIntoColumns(units);
}

export function splitTextIntoPages(text: string, enableRuby = BODY_RUBY_ENABLED): LayoutUnit[][][] {
  const columns = splitTextIntoColumns(text, enableRuby);
  const pages: LayoutUnit[][][] = [];
  for (let index = 0; index < columns.length; index += COLUMNS_PER_PAGE) {
    pages.push(columns.slice(index, index + COLUMNS_PER_PAGE));
  }
  if (pages.length === 0) pages.push([]);
  return pages;
}

export function estimateBodyPageCount(text: string): number {
  return splitTextIntoPages(text).length;
}

function estimateTocColumns(work: TocWork, pageNumber: number): number {
  const authorPart = work.author?.trim() ? `${work.author.trim()}　` : "";
  const entryLength = Array.from(`${work.title}　${authorPart}${pageNumber}`).length;
  const lineHeightMm = TOC_FONT_SIZE_PT * 25.4 / 72 * TOC_LINE_HEIGHT;
  const charsPerColumn = Math.max(1, Math.floor(TOC_CONTENT_HEIGHT_MM / lineHeightMm));
  return Math.max(1, Math.ceil(entryLength / charsPerColumn));
}

export function paginateTocEntries(works: TocWork[], pageNumbers: number[]): TocEntry[][] {
  const pages: TocEntry[][] = [];
  let current: TocEntry[] = [];
  let usedWidthMm = 0;

  works.forEach((work, workIndex) => {
    const pageNumber = pageNumbers[workIndex] ?? 0;
    const columns = estimateTocColumns(work, pageNumber);
    const entryWidthMm = columns * TOC_COLUMN_WIDTH_MM;
    const neededWidthMm = entryWidthMm + (current.length > 0 ? TOC_ENTRY_GAP_MM : 0);
    if (current.length > 0 && usedWidthMm + neededWidthMm > TOC_CONTENT_WIDTH_MM) {
      pages.push(current);
      current = [];
      usedWidthMm = 0;
    }
    if (current.length > 0) usedWidthMm += TOC_ENTRY_GAP_MM;
    usedWidthMm += entryWidthMm;
    current.push({ workIndex, pageNumber });
  });

  if (current.length > 0) pages.push(current);
  return pages.length ? pages : [[]];
}

export function calculateWorkStartPages(workPageCounts: number[], tocPageCount: number) {
  let currentPageNumber = 2 + tocPageCount;
  const workStartPages = workPageCounts.map((pageCount) => {
    const start = currentPageNumber;
    currentPageNumber += 1 + pageCount; // work title page and body pages
    return start;
  });
  return { workStartPages, colophonPageNumber: currentPageNumber };
}

export function calculateTocLayout(works: TocWork[], workPageCounts: number[]) {
  let tocPageCount = 1;
  let pageNumbers: number[] = [];
  let pages: TocEntry[][] = [[]];
  let colophonPageNumber = 3;

  for (let iteration = 0; iteration <= works.length + 1; iteration += 1) {
    const pageLayout = calculateWorkStartPages(workPageCounts, tocPageCount);
    pageNumbers = pageLayout.workStartPages;
    colophonPageNumber = pageLayout.colophonPageNumber;
    pages = paginateTocEntries(works, pageNumbers);
    if (pages.length === tocPageCount) break;
    tocPageCount = pages.length;
  }

  return { pages, pageNumbers, colophonPageNumber };
}
