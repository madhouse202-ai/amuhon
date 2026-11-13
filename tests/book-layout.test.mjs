import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateTocLayout,
  calculateWorkStartPages,
  estimateBodyPageCount,
  paginateTocEntries,
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
