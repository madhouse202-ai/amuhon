import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import {
  assertDeclaredPdfPageCount,
  validateBodyPdf,
  validateCoverPng,
} from "../lib/order-assets.ts";
import { calculateCoverLayout } from "../lib/production.ts";

async function makePdf(pageCount, widthPt = 105 / 25.4 * 72, heightPt = 148 / 25.4 * 72) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) pdf.addPage([widthPt, heightPt]);
  return new Uint8Array(await pdf.save());
}

async function makeCover(pageCount, density = 350, dimensions = null) {
  const layout = calculateCoverLayout(pageCount);
  assert.ok(layout);
  const width = dimensions?.width ?? layout.pixelWidth;
  const height = dimensions?.height ?? layout.pixelHeight;
  return new Uint8Array(await sharp({
    create: { width, height, channels: 3, background: { r: 60, g: 80, b: 100 } },
  }).png().withMetadata({ density }).toBuffer());
}

test("server accepts an A6 24-page body PDF and reads its actual count and digest", async () => {
  const validated = await validateBodyPdf(await makePdf(24));
  assert.equal(validated.pageCount, 24);
  assert.match(validated.sha256, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => assertDeclaredPdfPageCount(validated.pageCount, 24));
});

test("server rejects page-count mismatch, invalid PDF, wrong page size, and unsupported range", async () => {
  const valid = await validateBodyPdf(await makePdf(24));
  assert.throws(() => assertDeclaredPdfPageCount(valid.pageCount, 32), /一致しません/);
  await assert.rejects(validateBodyPdf(new TextEncoder().encode("not a pdf")), /形式/);
  await assert.rejects(validateBodyPdf(await makePdf(24, 420, 595)), /A6縦/);
  await assert.rejects(validateBodyPdf(await makePdf(16)), /24〜496/);
  assert.match(valid.sha256, /^[a-f0-9]{64}$/);
});

test("server decodes an RGB cover PNG and verifies expected pixels and 350dpi", async () => {
  const png = await makeCover(24);
  const validated = await validateCoverPng(png, 24);
  const layout = calculateCoverLayout(24);
  assert.ok(layout);
  assert.deepEqual([validated.width, validated.height], [layout.pixelWidth, layout.pixelHeight]);
  assert.match(validated.sha256, /^[a-f0-9]{64}$/);
});

test("server rejects cover dimension, DPI, and PNG corruption mismatches", async () => {
  await assert.rejects(validateCoverPng(await makeCover(24, 350, { width: 100, height: 100 }), 24), /寸法/);
  await assert.rejects(validateCoverPng(await makeCover(24, 72), 24), /350dpi/);
  await assert.rejects(validateCoverPng(new Uint8Array([1, 2, 3, 4]), 24), /ファイルサイズ/);
  const png = await makeCover(24);
  png[png.length - 4] = 0;
  await assert.rejects(validateCoverPng(png, 24), /破損/);
});
