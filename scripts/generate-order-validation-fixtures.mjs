#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { calculateCoverLayout, isSubmissionPageCount } from "../lib/production.ts";
import { MAX_ORDER_ASSET_BYTES } from "../lib/order-assets.ts";

const DEFAULT_MAX_BYTES = 10_000_000;
const HIGH_MEMORY_BYTES = 20_000_000;
const NEAR_LIMIT_BYTES = 30_000_000;

function parseArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--allow-large" || arg === "--allow-high-memory" || arg === "--allow-near-limit") {
      values[arg.slice(2)] = true;
    } else if (["--out", "--sizes", "--pages", "--complex-ops-per-page"].includes(arg)) {
      values[arg.slice(2)] = args[++i];
    } else if (arg === "--png-noise") {
      values.pngNoise = true;
    } else if (arg === "--corrupt-png") {
      values.corruptPng = true;
    } else {
      throw new Error(`不明な引数です: ${arg}`);
    }
  }
  return values;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function addPngPadding(png, targetBytes) {
  if (targetBytes < png.length) throw new Error(`PNGの実データが目標サイズを超えています（${png.length}バイト）。`);
  const extra = targetBytes - png.length;
  if (extra === 0) return png;
  if (extra < 19) throw new Error("PNGを指定サイズへ調整するための余白が不足しています。別のサイズを指定してください。");
  const iend = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
  const iendAt = png.lastIndexOf(iend);
  if (iendAt < 0 || iendAt + iend.length !== png.length) throw new Error("生成したPNGの終端を確認できません。");
  const dataLength = extra - 12;
  const chunk = Buffer.allocUnsafe(extra);
  chunk.writeUInt32BE(dataLength, 0);
  chunk.write("tEXt", 4, "ascii");
  chunk.write("amuhon", 8, "ascii");
  chunk[14] = 0;
  if (dataLength > 7) chunk.fill(0x41, 15, 8 + dataLength);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + dataLength)), 8 + dataLength);
  return Buffer.concat([png.subarray(0, iendAt), chunk, iend]);
}

async function createBasePdf(pageCount, operationsPerPage) {
  const pdf = await PDFDocument.create();
  const width = 105 / 25.4 * 72;
  const height = 148 / 25.4 * 72;
  for (let i = 0; i < pageCount; i += 1) {
    const page = pdf.addPage([width, height]);
    for (let operation = 0; operation < operationsPerPage; operation += 1) {
      const x = (operation * 17) % width;
      const y = (operation * 29) % height;
      page.drawLine({ start: { x, y }, end: { x: Math.min(width, x + 2), y: Math.min(height, y + 3) }, thickness: 0.1 });
    }
  }
  return Buffer.from(await pdf.save());
}

async function createBasePng(pageCount) {
  const layout = calculateCoverLayout(pageCount);
  if (!layout) throw new Error("指定ページ数のカバー寸法を計算できません。");
  // Flat RGB pixels keep the generated PNG small; sharp still decodes the full print-size canvas.
  return sharp({
    create: { width: layout.pixelWidth, height: layout.pixelHeight, channels: 3, background: { r: 72, g: 104, b: 136 } },
  }).png().withMetadata({ density: 350 }).toBuffer();
}

async function createNoisyPng(pageCount) {
  const layout = calculateCoverLayout(pageCount);
  if (!layout) throw new Error("指定ページ数のカバー寸法を計算できません。");
  const pixels = Buffer.allocUnsafe(layout.pixelWidth * layout.pixelHeight * 3);
  let state = 0x6d2b79f5;
  for (let i = 0; i < pixels.length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[i] = state & 0xff;
  }
  return sharp(pixels, { raw: { width: layout.pixelWidth, height: layout.pixelHeight, channels: 3 } })
    .png({ compressionLevel: 6 }).withMetadata({ density: 350 }).toBuffer();
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (!options.out || !options.sizes) throw new Error("--out と --sizes は必須です。");
    const sizes = options.sizes.split(",").map((value) => Number(value.trim()));
    if (!sizes.length || sizes.some((value) => !Number.isSafeInteger(value) || value < 1 || value > MAX_ORDER_ASSET_BYTES)) {
      throw new Error("--sizes は1〜40,000,000の整数バイトをカンマ区切りで指定してください。");
    }
    const maxSize = Math.max(...sizes);
    if (maxSize > DEFAULT_MAX_BYTES && !options["allow-large"]) {
      throw new Error("10MBを超える生成には --allow-large が必要です。");
    }
    if (maxSize > HIGH_MEMORY_BYTES && !options["allow-high-memory"]) {
      throw new Error("20MBを超える生成はメモリ負荷を伴います。事前確認後に --allow-high-memory を付けてください。");
    }
    if (maxSize > NEAR_LIMIT_BYTES && !options["allow-near-limit"]) {
      throw new Error("30MBを超える生成は40MB上限付近の高負荷テストです。事前確認後に --allow-near-limit を付けてください。");
    }
    const pageCount = options.pages === undefined ? 24 : Number(options.pages);
    if (!isSubmissionPageCount(pageCount)) throw new Error("--pages は現在の入稿条件に合う8ページ単位のページ数を指定してください。");
    const operationsPerPage = options["complex-ops-per-page"] === undefined ? 0 : Number(options["complex-ops-per-page"]);
    if (!Number.isSafeInteger(operationsPerPage) || operationsPerPage < 0 || operationsPerPage > 10_000) {
      throw new Error("--complex-ops-per-page は0〜10,000の整数にしてください。");
    }
    if (operationsPerPage > 0 && !options["allow-large"]) throw new Error("複雑PDF生成には --allow-large が必要です。");
    if (operationsPerPage > 2_000 && !options["allow-high-memory"]) throw new Error("2,000超のPDF描画命令生成には事前確認後 --allow-high-memory が必要です。");
    if (operationsPerPage > 5_000 && !options["allow-near-limit"]) throw new Error("5,000超のPDF描画命令生成には事前確認後 --allow-near-limit が必要です。");
    if (options.pngNoise && !options["allow-high-memory"]) throw new Error("ノイズPNGは大きなraw pixel bufferを作ります。事前確認後 --allow-high-memory を付けてください。");

    const outputRoot = resolve(options.out);
    await mkdir(dirname(outputRoot), { recursive: true });
    await mkdir(outputRoot, { recursive: false });
    const pdfBase = await createBasePdf(pageCount, operationsPerPage);
    const pngBase = options.pngNoise ? await createNoisyPng(pageCount) : await createBasePng(pageCount);
    const cases = [];
    for (const targetBytes of sizes) {
      if (targetBytes < pdfBase.length) throw new Error(`PDF目標サイズが最小生成PDFより小さいです（最低${pdfBase.length}バイト）。`);
      const caseDirectory = join(outputRoot, String(targetBytes));
      await mkdir(caseDirectory, { recursive: false });
      const pdfPath = join(caseDirectory, "body.pdf");
      const pngPath = join(caseDirectory, "cover.png");
      // PDF trailing whitespace is valid padding and stresses file read/hash/parser scan without adding page objects.
      await writeFile(pdfPath, Buffer.concat([pdfBase, Buffer.alloc(targetBytes - pdfBase.length, 0x20)]));
      const paddedPng = addPngPadding(pngBase, targetBytes);
      if (options.corruptPng) paddedPng[paddedPng.length - 13] ^= 0x01;
      await writeFile(pngPath, paddedPng);
      cases.push({ targetBytes, bodyPdfBytes: targetBytes, coverPngBytes: paddedPng.length, directory: caseDirectory });
    }
    process.stdout.write(`${JSON.stringify({ status: "generated", pageCount, operationsPerPage, pngNoise: Boolean(options.pngNoise), corruptPng: Boolean(options.corruptPng), cases, note: "合成データ。サイズ調整用のPDF末尾空白とPNG tEXtチャンクは実作品の複雑さを再現しません。描画命令数とノイズPNGは負荷比較用の合成指標です。" }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "生成に失敗しました。"}\n`);
    process.exitCode = 1;
  }
}

main();
