import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import { calculateCoverLayout, isSubmissionPageCount } from "./production.ts";

// Decimal 40 MB, kept below the Supabase Free project-wide 50 MB file cap.
export const MAX_ORDER_ASSET_BYTES = 40_000_000;
export const MAX_ORDER_UPLOAD_BODY_BYTES = MAX_ORDER_ASSET_BYTES * 2 + 128 * 1024;
export const ORDER_UPLOAD_TOKEN_BYTES = 32;
const A6_WIDTH_PT = 105 / 25.4 * 72;
const A6_HEIGHT_PT = 148 / 25.4 * 72;
const PAGE_SIZE_TOLERANCE_PT = 1.5;
const MAX_COVER_PIXELS = 10_000_000;
const MAX_PNG_CHUNKS = 4096;

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  CRC32_TABLE[index] = value >>> 0;
}

export type ValidatedBodyPdf = { pageCount: number; sha256: string };
export type ValidatedCoverPng = { width: number; height: number; sha256: string };

export function assertOrderAssetSize(byteLength: number, assetName: "本文PDF" | "カバーPNG"): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_ORDER_ASSET_BYTES) {
    throw new Error(`${assetName}のファイルサイズが上限を超えています（40,000,000バイト／40MB）。`);
  }
}

export function assertDeclaredPdfPageCount(actualPageCount: number, declaredPageCount: unknown): void {
  if (declaredPageCount !== null && declaredPageCount !== undefined && declaredPageCount !== actualPageCount) {
    throw new Error(`本文PDFの実ページ数（${actualPageCount}ページ）が注文下書きの申告値と一致しません。`);
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readPngContainer(bytes: Uint8Array): { width: number; height: number; dpi: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) throw new Error("invalid_png");
  let width = 0;
  let height = 0;
  let dpi = 0;
  let sawHeader = false;
  let sawData = false;
  let sawResolution = false;
  let sawEnd = false;
  let chunkCount = 0;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS) throw new Error("invalid_png");
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    if (length > bytes.length - offset - 12) throw new Error("invalid_png");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    if (crc32(bytes.subarray(offset + 4, crcOffset)) !== new DataView(bytes.buffer, bytes.byteOffset + crcOffset, 4).getUint32(0)) {
      throw new Error("invalid_png");
    }
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) throw new Error("invalid_png");
      sawHeader = true;
      const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart, length);
      width = view.getUint32(0);
      height = view.getUint32(4);
      if (!width || !height || width * height > MAX_COVER_PIXELS) throw new Error("invalid_png");
    } else if (type === "IHDR") {
      throw new Error("invalid_png");
    }
    if (type === "IDAT") sawData = true;
    if (type === "pHYs") {
      if (sawResolution || length !== 9 || bytes[dataStart + 8] !== 1) throw new Error("invalid_png");
      sawResolution = true;
      const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart, length);
      const xDpi = view.getUint32(0) * 0.0254;
      const yDpi = view.getUint32(4) * 0.0254;
      if (Math.abs(xDpi - yDpi) > 0.1) throw new Error("invalid_png");
      dpi = (xDpi + yDpi) / 2;
    }
    offset = crcOffset + 4;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length) throw new Error("invalid_png");
      sawEnd = true;
      break;
    }
  }
  if (!sawHeader || !sawData || !sawResolution || !sawEnd) throw new Error("invalid_png");
  return { width, height, dpi };
}

function isA6PageBox(box: { width: number; height: number }): boolean {
  return Math.abs(box.width - A6_WIDTH_PT) <= PAGE_SIZE_TOLERANCE_PT &&
    Math.abs(box.height - A6_HEIGHT_PT) <= PAGE_SIZE_TOLERANCE_PT;
}

/** Parse the actual PDF structure; never use the browser-declared page count as truth. */
export async function validateBodyPdf(bytes: Uint8Array): Promise<ValidatedBodyPdf> {
  assertOrderAssetSize(bytes.byteLength, "本文PDF");
  if (bytes.byteLength < 8 || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
    throw new Error("本文PDFの形式を確認してください。");
  }

  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  } catch {
    throw new Error("本文PDFが破損しているか、暗号化されているため読み取れません。");
  }
  const pages = document.getPages();
  const pageCount = pages.length;
  if (!isSubmissionPageCount(pageCount)) {
    throw new Error("本文PDFは末尾白紙を含む24〜496ページ（8ページ単位）である必要があります。");
  }
  for (const page of pages) {
    const media = page.getMediaBox();
    const crop = page.getCropBox();
    if (page.getRotation().angle % 360 !== 0 || !isA6PageBox(media) || !isA6PageBox(crop)) {
      throw new Error("本文PDFのすべてのページがA6縦（105 × 148mm）ではありません。");
    }
  }
  return { pageCount, sha256: digest(bytes) };
}

/** Decode the whole PNG and verify print pixels, RGB color model, and pHYs density. */
export async function validateCoverPng(bytes: Uint8Array, bodyPdfPageCount: number): Promise<ValidatedCoverPng> {
  assertOrderAssetSize(bytes.byteLength, "カバーPNG");
  if (bytes.byteLength < 33) throw new Error("カバーPNGのファイルサイズまたは形式を確認してください。");
  const layout = calculateCoverLayout(bodyPdfPageCount);
  if (!layout) throw new Error("本文ページ数からカバー寸法を計算できません。");

  try {
    const container = readPngContainer(bytes);
    if (container.width !== layout.pixelWidth || container.height !== layout.pixelHeight) {
      throw new Error("カバーPNGの画像形式またはピクセル寸法が本文ページ数と一致しません。");
    }
    if (Math.abs(container.dpi - 350) > 0.1) throw new Error("カバーPNGの解像度メタデータが350dpiではありません。");
    const image = sharp(bytes, { limitInputPixels: MAX_COVER_PIXELS, failOn: "error" });
    const metadata = await image.metadata();
    if (metadata.format !== "png" || metadata.width !== layout.pixelWidth || metadata.height !== layout.pixelHeight) {
      throw new Error("カバーPNGの画像形式またはピクセル寸法が本文ページ数と一致しません。");
    }
    if (!metadata.space?.toLowerCase().includes("rgb") || (metadata.channels ?? 0) < 3) {
      throw new Error("カバーPNGはRGB形式で出力してください。");
    }
    if (!metadata.density || Math.abs(metadata.density - 350) > 0.1) {
      throw new Error("カバーPNGの解像度メタデータが350dpiではありません。");
    }
    const decoded = await image.stats();
    if (decoded.channels.length < 3) throw new Error("カバーPNGの画素データを確認できません。");
    return { width: metadata.width, height: metadata.height, sha256: digest(bytes) };
  } catch (error) {
    if (error instanceof Error && /カバーPNG/.test(error.message)) throw error;
    throw new Error("カバーPNGが破損しているか、正しいPNGとして読み取れません。");
  }
}
