import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateFinishedBookLayout,
  calculateTocLayout,
  calculateWorkStartPages,
  estimateBodyPageCount,
  paginateTocEntries,
  SOURCE_WORKS_PER_PAGE,
  splitTextIntoPages,
} from "../lib/book-layout.ts";

test("estimates body pages with the same column limits and ruby parent-character counting", () => {
  assert.equal(estimateBodyPageCount("あ".repeat(639)), 1);
  assert.equal(estimateBodyPageCount("あ".repeat(640)), 2);
  assert.equal(estimateBodyPageCount("東京"), estimateBodyPageCount("｜東京《とうきょう》"));

  const pages = splitTextIntoPages("一段落です。\n\n「会話文です。」\n\n次の段落です。");
  assert.ok(pages.length >= 1);
});

test("work start page numbers track composition order and body-page counts", () => {
  assert.deepEqual(calculateWorkStartPages([2, 1], 1), {
    workStartPages: [3, 6],
    colophonPageNumber: 8,
  });
  assert.deepEqual(calculateWorkStartPages([1, 2], 1).workStartPages, [3, 5]);
});

test("TOC paginates based on title, author, and page-number line widths", () => {
  const works = Array.from({ length: 18 }, (_, index) => ({
    id: String(index),
    title: `作品${index}`,
    author: "作者名",
  }));
  const pages = paginateTocEntries(works, works.map((_, index) => index + 3));
  assert.ok(pages.length > 1);
  assert.equal(pages.flat().length, works.length);

  const layout = calculateTocLayout(works, works.map((_, index) => index + 1));
  assert.equal(layout.pages.flat().length, works.length);
  assert.equal(layout.pageNumbers.length, works.length);
  assert.equal(layout.pageNumbers[0], 2 + layout.pages.length);
  assert.equal(layout.pageNumbers[1], layout.pageNumbers[0] + 2);
});

test("adopted A layout keeps long metadata and many works within paginated pages using real body counts", () => {
  const works = Array.from({ length: 18 }, (_, index) => ({
    id: String(index),
    title: `長い作品名の折り返しを確認するための試験作品タイトル${index}`,
    author: `長い著者名の表示確認用作者${index}`,
  }));
  const bodyPageCounts = Array.from({ length: works.length }, (_, index) => 6 + (index % 3));
  const layout = calculateTocLayout(works, bodyPageCounts);

  assert.ok(layout.pages.length > 1);
  assert.deepEqual(layout.pages.flat().map(({ workIndex }) => workIndex), works.map((_, index) => index));
  assert.deepEqual(
    layout.pageNumbers,
    calculateWorkStartPages(bodyPageCounts, layout.pages.length).workStartPages,
  );
  assert.ok(layout.pageNumbers.some((pageNumber) => pageNumber >= 100), "three-digit start pages must use actual body counts");

  const lineHeightMm = 8.5 * 25.4 / 72 * 1.6;
  const charsPerColumn = Math.max(1, Math.floor(124 / lineHeightMm));
  const columnWidthMm = lineHeightMm;
  for (const entries of layout.pages) {
    let usedWidthMm = 0;
    for (const { workIndex, pageNumber } of entries) {
      const work = works[workIndex];
      const author = work.author?.trim() ? `${work.author.trim()}　` : "";
      const length = Array.from(`${work.title}　${author}${pageNumber}`).length;
      const columns = Math.max(1, Math.ceil(length / charsPerColumn));
      usedWidthMm += columns * columnWidthMm;
    }
    usedWidthMm += Math.max(0, entries.length - 1) * 3;
    assert.ok(usedWidthMm <= 81 + 0.001, "each A6 TOC page must stay within its 81mm content width");
  }
});

test("finished-book estimate includes all shared front matter, titles, sources, colophon, and binding blanks", () => {
  const works = Array.from({ length: 4 }, (_, index) => ({
    id: String(index),
    title: `作品${index}`,
    author: `作者${index}`,
  }));
  const layout = calculateFinishedBookLayout(works, [1, 1, 1, 1]);

  assert.ok(layout);
  assert.equal(layout.bodyPageCount, 4);
  assert.equal(layout.tocLayout.pages.length, 1);
  assert.equal(layout.sourcePageCount, 1);
  assert.equal(layout.unpaddedPageCount, 12);
  assert.equal(layout.paddingPageCount, 4);
  assert.equal(layout.totalPageCount, 16);

  const exactlyAligned = calculateFinishedBookLayout([{ id: "exact", title: "境界作品" }], [3]);
  const onePageOver = calculateFinishedBookLayout([{ id: "over", title: "境界作品" }], [4]);
  assert.equal(exactlyAligned?.unpaddedPageCount, 8);
  assert.equal(exactlyAligned?.paddingPageCount, 0);
  assert.equal(exactlyAligned?.totalPageCount, 8);
  assert.equal(onePageOver?.unpaddedPageCount, 9);
  assert.equal(onePageOver?.paddingPageCount, 7);
  assert.equal(onePageOver?.totalPageCount, 16);
});

test("source pages use four works per page and split at the fifth work", () => {
  assert.equal(SOURCE_WORKS_PER_PAGE, 4);
  const fourWorks = Array.from({ length: 4 }, (_, index) => ({ id: String(index), title: `作品${index}` }));
  const fiveWorks = [...fourWorks, { id: "4", title: "作品4" }];

  assert.equal(calculateFinishedBookLayout(fourWorks, [1, 1, 1, 1])?.sourcePageCount, 1);
  const fiveWorkLayout = calculateFinishedBookLayout(fiveWorks, [1, 1, 1, 1, 1]);
  assert.equal(fiveWorkLayout?.sourcePageCount, 2);
  assert.equal(fiveWorkLayout?.unpaddedPageCount, 15);
  assert.equal(fiveWorkLayout?.totalPageCount, 16);
});

test("long work titles and authors use the real TOC pagination when calculating finished pages", () => {
  const shortWorks = Array.from({ length: 20 }, (_, index) => ({
    id: String(index),
    title: `作品${index}`,
    author: `作者${index}`,
  }));
  const longWorks = shortWorks.map((work, index) => ({
    ...work,
    title: `長い作品名の目次ページ割りを検証するための作品タイトル${"長".repeat(45)}${index}`,
    author: `長い著者名${"者".repeat(24)}${index}`,
  }));
  const pageCounts = shortWorks.map(() => 3);
  const shortLayout = calculateFinishedBookLayout(shortWorks, pageCounts);
  const longLayout = calculateFinishedBookLayout(longWorks, pageCounts);

  assert.ok(shortLayout && longLayout);
  assert.ok(longLayout.tocLayout.pages.length > shortLayout.tocLayout.pages.length);
  assert.equal(longLayout.totalPageCount % 8, 0);
  assert.equal(longLayout.tocLayout.pages.flat().length, longWorks.length);
});

test("zero works and invalid or incomplete body estimates do not produce a finished-page count", () => {
  assert.equal(calculateFinishedBookLayout([], []), null);
  assert.equal(calculateFinishedBookLayout([{ id: "1", title: "作品" }], []), null);
  assert.equal(calculateFinishedBookLayout([{ id: "1", title: "作品" }], [0]), null);
  assert.equal(calculateFinishedBookLayout([{ id: "1", title: "作品" }], [1.5]), null);
});

test("body-text estimates feed the same finished layout used by /final", () => {
  const text = ["短い本文です。", "別の段落です。"].join("\n\n");
  const work = { id: "work-1", title: "試験作品", author: "試験作者" };
  const bodyPageCount = estimateBodyPageCount(text);
  const layout = calculateFinishedBookLayout([work], [bodyPageCount]);

  assert.ok(layout);
  assert.equal(layout.bodyPageCount, splitTextIntoPages(text).length);
  assert.equal(layout.unpaddedPageCount, 5 + bodyPageCount);
  assert.equal(layout.totalPageCount, Math.ceil((5 + bodyPageCount) / 8) * 8);
});
