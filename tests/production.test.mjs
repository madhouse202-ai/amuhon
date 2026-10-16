import assert from "node:assert/strict";
import test from "node:test";
import {
  addPngResolutionMetadata,
  assertPngPrintProperties,
  calculateCoverLayout,
  calculateSpineWidthMm,
  isSubmissionPageCount,
  padPerfectBindingBodyPageCount,
  readPngPrintProperties,
} from "../lib/production.ts";
import { bookLayoutKey } from "../lib/book.ts";

test("spine model matches all twelve supplied calculator measurements", () => {
  for (const [pages, expected, expectedCoverWidth] of [
    [20, 1.7, 217.7],
    [40, 2.9, 218.9],
    [50, 3.5, 219.5],
    [100, 6.5, 222.5],
    [150, 9.5, 225.5],
    [200, 12.5, 228.5],
    [250, 15.5, 231.5],
    [300, 18.5, 234.5],
    [350, 21.5, 237.5],
    [400, 24.5, 240.5],
    [450, 27.5, 243.5],
    [500, 30.5, 246.5],
  ]) {
    assert.equal(calculateSpineWidthMm(pages), expected);
    const layout = calculateCoverLayout(pages);
    assert.ok(layout);
    assert.equal(layout.coverWidthMm, expectedCoverWidth);
    assert.equal(layout.coverHeightMm, 154);
    assert.equal(layout.pixelWidth, Math.round((216 + expected) * 350 / 25.4));
    assert.equal(layout.pixelHeight, Math.round(154 * 350 / 25.4));
  }
});

test("A6 trim and bleed panel coordinates have no gaps or overlaps", () => {
  const layout = calculateCoverLayout(100);
  assert.ok(layout);
  assert.deepEqual(layout.panels.front, { xMm: 3, widthMm: 105 });
  assert.deepEqual(layout.panels.spine, { xMm: 108, widthMm: 6.5 });
  assert.deepEqual(layout.panels.back, { xMm: 114.5, widthMm: 105 });
  assert.equal(layout.panels.trimTopMm, 3);
  assert.equal(layout.panels.trimHeightMm, 148);
  assert.equal(layout.coverWidthMm - (layout.panels.back.xMm + layout.panels.back.widthMm), 3);
});

test("book layout snapshot changes when the current composition changes", () => {
  const book = {
    title: "本の題名",
    editor: "編者",
    works: [{ id: "1", title: "作品", author: "著者", xhtmlUrl: "https://example.test/1" }],
  };
  const initial = bookLayoutKey(book);
  assert.notEqual(bookLayoutKey(book, "別の題名", book.editor), initial);
  assert.notEqual(bookLayoutKey({ ...book, works: [{ ...book.works[0], title: "別作品" }] }), initial);
});

test("unsupported, invalid, and out-of-product page counts are rejected separately", () => {
  assert.equal(calculateSpineWidthMm(0), null);
  assert.equal(calculateSpineWidthMm(100.5), null);
  assert.equal(calculateSpineWidthMm(19), null);
  assert.equal(calculateSpineWidthMm(501), null);
  assert.equal(calculateCoverLayout(501), null);
  assert.equal(isSubmissionPageCount(24), true);
  assert.equal(isSubmissionPageCount(496), true);
  assert.equal(isSubmissionPageCount(20), false); // The existing 8-page padding means 20 pages are never a final output count.
  assert.equal(isSubmissionPageCount(500), false); // Effective maximum is 496 while the 8-page rule remains enabled.
  assert.equal(isSubmissionPageCount(104), true);
  assert.equal(isSubmissionPageCount(16), false);
  assert.equal(isSubmissionPageCount(504), false);
  assert.equal(isSubmissionPageCount(304), true);
  assert.equal(padPerfectBindingBodyPageCount(20), 24);
  assert.equal(padPerfectBindingBodyPageCount(304), 304);
  assert.equal(padPerfectBindingBodyPageCount(496), 496);
  assert.equal(padPerfectBindingBodyPageCount(497), 504);
  assert.equal(padPerfectBindingBodyPageCount(296), 296);
});

test("PNG resolution metadata is encoded and independently read back", () => {
  const onePixelPng = Uint8Array.from(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA5sAAAAASUVORK5CYII=",
    "base64",
  ));
  const withResolution = addPngResolutionMetadata(onePixelPng);
  const withReplacedResolution = addPngResolutionMetadata(withResolution);
  const properties = readPngPrintProperties(withReplacedResolution);
  assert.ok(properties);
  assert.equal(properties.width, 1);
  assert.equal(properties.height, 1);
  assert.ok(Math.abs(properties.dpiX - 350) < 0.1);
  assert.ok(Math.abs(properties.dpiY - 350) < 0.1);
  assertPngPrintProperties(withReplacedResolution, 1, 1, 350);
  assert.throws(() => assertPngPrintProperties(withReplacedResolution, 2, 1, 350), /寸法/);
});
