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
