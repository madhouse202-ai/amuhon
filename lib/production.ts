/** Internal standard for the first manual print-submission test. */
export const BOOK_PRODUCTION = {
  trimWidthMm: 105,
  trimHeightMm: 148,
  bleedMm: 3,
  dpi: 350,
  binding: "right" as const,
  bindingMethod: "perfect" as const,
  bodyPaperCode: "06",
  bodyPaperLabel: "06 - 書籍用紙 クリーム色（四六判66.5kg）",
  bodyColor: "monochrome" as const,
  minBodyPages: 20,
  maxBodyPages: 500,
  // Keep the app's existing padding policy configurable; manufacturer guidance also mentions 2-page units.
  perfectBindingPageMultiple: 8,
};

/**
 * Empirical model specific to A6, right-bound perfect binding, and body paper 06
 * (cream book paper, 0.12mm / 66.5kg). It matches twelve user-supplied measurements
 * from the official calculator (20–500 pages); it is not an official published formula.
 */
export const SPINE_WIDTH_MODEL = {
  version: "empirical-a6-paper06-perfect-v1",
  minPageCount: 20,
  maxPageCount: 500,
  millimetersPerPage: 0.06,
  fixedMillimeters: 0.5,
  source: "Twelve user-provided measurements from the official calculator (20–500 pages).",
} as const;

export type CoverLayout = {
  pageCount: number;
  spineWidthMm: number;
  coverWidthMm: number;
  coverHeightMm: number;
  pixelWidth: number;
  pixelHeight: number;
  panels: {
    front: { xMm: number; widthMm: number };
    spine: { xMm: number; widthMm: number };
    back: { xMm: number; widthMm: number };
    trimTopMm: number;
    trimHeightMm: number;
  };
};

export function calculateSpineWidthMm(pageCount: number): number | null {
  if (!Number.isInteger(pageCount) || pageCount <= 0) return null;
  if (pageCount < SPINE_WIDTH_MODEL.minPageCount || pageCount > SPINE_WIDTH_MODEL.maxPageCount) return null;
  return Number((SPINE_WIDTH_MODEL.millimetersPerPage * pageCount + SPINE_WIDTH_MODEL.fixedMillimeters).toFixed(2));
}

export function isSubmissionPageCount(pageCount: number): boolean {
  return Number.isInteger(pageCount) &&
    pageCount >= BOOK_PRODUCTION.minBodyPages &&
    pageCount <= BOOK_PRODUCTION.maxBodyPages &&
    pageCount % BOOK_PRODUCTION.perfectBindingPageMultiple === 0;
}

/** Number of pages the body PDF must contain after perfect-binding end blanks are included. */
export function padPerfectBindingBodyPageCount(pageCount: number): number | null {
  if (!Number.isInteger(pageCount) || pageCount <= 0) return null;
  const multiple = BOOK_PRODUCTION.perfectBindingPageMultiple;
  return Math.ceil(pageCount / multiple) * multiple;
}

export function calculateCoverLayout(pageCount: number): CoverLayout | null {
  const spineWidthMm = calculateSpineWidthMm(pageCount);
  if (spineWidthMm === null) return null;

  const { trimWidthMm, trimHeightMm, bleedMm, dpi } = BOOK_PRODUCTION;
  const coverWidthMm = trimWidthMm * 2 + spineWidthMm + bleedMm * 2;
  const coverHeightMm = trimHeightMm + bleedMm * 2;
  const pixelWidth = Math.round(coverWidthMm * dpi / 25.4);
  const pixelHeight = Math.round(coverHeightMm * dpi / 25.4);
  if (!Number.isFinite(coverWidthMm) || !Number.isFinite(coverHeightMm) || pixelWidth <= 0 || pixelHeight <= 0) return null;

  return {
    pageCount,
    spineWidthMm,
    coverWidthMm,
    coverHeightMm,
    pixelWidth,
    pixelHeight,
    panels: {
      front: { xMm: bleedMm, widthMm: trimWidthMm },
      spine: { xMm: bleedMm + trimWidthMm, widthMm: spineWidthMm },
      back: { xMm: bleedMm + trimWidthMm + spineWidthMm, widthMm: trimWidthMm },
      trimTopMm: bleedMm,
      trimHeightMm,
    },
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function addPngResolutionMetadata(png: Uint8Array, dpi = BOOK_PRODUCTION.dpi): Uint8Array {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => png[index] === byte) || png.length < 33) {
    throw new Error("PNGのヘッダーを確認できません。");
  }

  const ihdrLength = new DataView(png.buffer, png.byteOffset + 8, 4).getUint32(0);
  if (ihdrLength !== 13 || String.fromCharCode(...png.subarray(12, 16)) !== "IHDR") {
    throw new Error("PNGのIHDRチャンクが不正です。");
  }

  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([112, 72, 89, 115], 4); // pHYs
  view.setUint32(8, ppm);
  view.setUint32(12, ppm);
  chunk[16] = 1;
  view.setUint32(17, crc32(chunk.subarray(4, 17)));

  const insertAt = 8 + 12 + ihdrLength;
  const output = new Uint8Array(png.length + chunk.length);
  output.set(png.subarray(0, insertAt));
  output.set(chunk, insertAt);
  let sourceOffset = insertAt;
  let outputOffset = insertAt + chunk.length;
  let foundIend = false;
  while (sourceOffset + 12 <= png.length) {
    const length = new DataView(png.buffer, png.byteOffset + sourceOffset, 4).getUint32(0);
    if (length > png.length - sourceOffset - 12) throw new Error("PNGチャンクが途中で切れています。");
    const type = String.fromCharCode(...png.subarray(sourceOffset + 4, sourceOffset + 8));
    const nextOffset = sourceOffset + length + 12;
    if (type !== "pHYs") {
      output.set(png.subarray(sourceOffset, nextOffset), outputOffset);
      outputOffset += nextOffset - sourceOffset;
    }
    sourceOffset = nextOffset;
    if (type === "IEND") {
      foundIend = true;
      break;
    }
  }
  if (!foundIend || sourceOffset !== png.length) throw new Error("PNGの終端チャンクが不正です。");
  return output.slice(0, outputOffset);
}

export type PngPrintProperties = { width: number; height: number; dpiX: number; dpiY: number };

export function readPngPrintProperties(bytes: Uint8Array): PngPrintProperties | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) return null;

  let width = 0;
  let height = 0;
  let dpiX = 0;
  let dpiY = 0;
  let sawIend = false;
  let sawPhys = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    if (length > bytes.length - offset - 12) return null;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const dataOffset = offset + 8;
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, length);
      width = view.getUint32(0);
      height = view.getUint32(4);
    } else if (type === "pHYs" && length === 9 && bytes[dataOffset + 8] === 1) {
      if (sawPhys) return null;
      sawPhys = true;
      const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, length);
      dpiX = view.getUint32(0) * 0.0254;
      dpiY = view.getUint32(4) * 0.0254;
    } else if (type === "IEND") {
      if (length !== 0) return null;
      sawIend = true;
      break;
    }
    offset += length + 12;
  }

  return sawIend && width > 0 && height > 0 ? { width, height, dpiX, dpiY } : null;
}

export function assertPngPrintProperties(
  bytes: Uint8Array,
  expectedWidth: number,
  expectedHeight: number,
  expectedDpi = BOOK_PRODUCTION.dpi,
): void {
  const properties = readPngPrintProperties(bytes);
  if (!properties) throw new Error("PNGの形式または解像度メタデータを確認できません。");
  if (properties.width !== expectedWidth || properties.height !== expectedHeight) {
    throw new Error(`PNGのピクセル寸法が想定と異なります（${properties.width} × ${properties.height}px）。`);
  }
  if (Math.abs(properties.dpiX - expectedDpi) > 0.1 || Math.abs(properties.dpiY - expectedDpi) > 0.1) {
    throw new Error(`PNGの解像度メタデータが${expectedDpi}dpiと一致しません。`);
  }
}
