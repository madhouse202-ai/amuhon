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

test("cover editing and final review share the preview cropped from the submitted artwork", async () => {
  const [cover, final, preview, renderer] = await Promise.all([
    source("../app/cover/page.tsx"),
    source("../app/final/page.tsx"),
    source("../app/cover-front-preview.tsx"),
    source("../lib/cover-renderer.ts"),
  ]);
  assert.match(cover, /<CoverFrontPreview/);
  assert.match(final, /<CoverFrontPreview/);
  assert.match(preview, /createFrontCoverPreviewBlob/);
  assert.match(renderer, /createSpreadCoverPngBlob\(book, bodyPdfPageCount, true\)/);
  assert.match(renderer, /getFrontCoverSourceRect\(layout, bitmap\.width, bitmap\.height\)/);
});
