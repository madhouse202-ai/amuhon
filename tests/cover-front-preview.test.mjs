import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateCoverLayout } from "../lib/production.ts";
import { getFrontCoverSourceRect } from "../lib/cover-renderer.ts";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("front cover preview crops the print PNG trim panel without changing print dimensions", () => {
  const layout = calculateCoverLayout(72);
  assert.ok(layout);
  assert.equal(layout.pixelWidth, 3043);
  assert.equal(layout.pixelHeight, 2122);

  const crop = getFrontCoverSourceRect(layout, layout.pixelWidth, layout.pixelHeight);
  assert.ok(Math.abs(crop.x - (3 / layout.coverWidthMm * layout.pixelWidth)) < 0.001);
  assert.ok(Math.abs(crop.y - (3 / layout.coverHeightMm * layout.pixelHeight)) < 0.001);
  assert.ok(Math.abs(crop.width - (105 / layout.coverWidthMm * layout.pixelWidth)) < 0.001);
  assert.ok(Math.abs(crop.height - (148 / layout.coverHeightMm * layout.pixelHeight)) < 0.001);
});

test("buyer cover editing uses a screen-sized spread; print cover generation is renderer-only", async () => {
  const [cover, final, preview, renderer] = await Promise.all([
    source("../app/cover/page.tsx"),
    source("../app/final/page.tsx"),
    source("../app/cover-spread-preview.tsx"),
    source("../lib/cover-renderer.ts"),
  ]);
  const printRenderer = await source("../lib/print-cover-renderer.ts");
  assert.match(cover, /<CoverSpreadPreview/);
  assert.match(final, /<CoverFrontPreview/);
  assert.match(preview, /createSpreadCoverPreviewBlob/);
  assert.match(renderer, /renderSpreadCoverPng\(book, bodyPdfPageCount, true, 96\)/);
  assert.match(printRenderer, /BOOK_PRODUCTION\.dpi/);
  assert.match(cover, /rendererInternalMode && <button/);
  assert.match(cover, /await import\("@\/lib\/print-cover-renderer"\)/);
  assert.doesNotMatch(cover, /import \{ createSpreadCoverPngBlob \} from/);
});

test("cover preview is always available and survives title/editor edits without trusting a stale work list", async () => {
  const [cover, preview] = await Promise.all([
    source("../app/cover/page.tsx"),
    source("../app/cover-spread-preview.tsx"),
  ]);
  assert.match(cover, /PREVIEW_ONLY_BODY_PAGE_COUNT = 80/);
  assert.match(cover, /storedPageCountMatchesWorks\(coverPageCount\.worksKey, currentBook\)/);
  assert.match(cover, /const previewBodyPageCount = confirmedBodyPageCount \?\? PREVIEW_ONLY_BODY_PAGE_COUNT/);
  assert.match(cover, /<CoverSpreadPreview[\s\S]*?pageCount=\{previewBodyPageCount\}/);
  assert.match(cover, /背幅はプレビュー用の仮設定/);
  assert.match(cover, /confirmedBodyPageCount === null/);
  assert.match(preview, /JSON\.stringify\(\[title, editor, coverStyle, coverColor, pageCount\]\)/);
  assert.match(preview, /createSpreadCoverPreviewBlob\(\{ title, editor, coverStyle, coverColor \}, pageCount\)/);
  assert.match(preview, /alt="表表紙・背表紙・裏表紙の全体プレビュー"/);
});
