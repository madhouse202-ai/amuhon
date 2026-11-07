import type { BookData } from "./book.ts";
import {
  BOOK_PRODUCTION,
  addPngResolutionMetadata,
  assertPngPrintProperties,
  calculateCoverLayout,
  calculateSpineTextLayout,
  isSubmissionPageCount,
} from "./production.ts";

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("PNG画像を生成できませんでした。")),
      "image/png",
    );
  });
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const sourceLine of text.split(/\r?\n/)) {
    let line = "";
    for (const char of Array.from(sourceLine)) {
      const candidate = line + char;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = char;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Create the same print-ready spread PNG used by the cover download button. */
export async function createSpreadCoverPngBlob(
  book: Pick<BookData, "title" | "editor" | "coverStyle" | "coverColor">,
  bodyPdfPageCount: number,
  showSpineText = true,
): Promise<Blob> {
  if (typeof document === "undefined") throw new Error("カバー画像はブラウザーで生成してください。");
  if (!isSubmissionPageCount(bodyPdfPageCount)) {
    throw new Error("本文PDFのページ数が対象範囲外です。");
  }

  const layout = calculateCoverLayout(bodyPdfPageCount);
  if (!layout) throw new Error("本文ページ数からカバー寸法を計算できません。");

  const palette = {
    red: { background: "#9e2f2f", foreground: "#fff8eb" },
    blue: { background: "#315f8f", foreground: "#f7f4e9" },
    green: { background: "#47704e", foreground: "#f7f4e9" },
  }[book.coverColor];
  const title = book.title.trim() || "わたしの本";
  const editor = book.editor.trim() || "編者";
  const heightMm = layout.coverHeightMm;
  const spineTextLayout = showSpineText
    ? calculateSpineTextLayout(bodyPdfPageCount, title, editor)
    : null;
  const canvas = document.createElement("canvas");
  canvas.width = layout.pixelWidth;
  canvas.height = layout.pixelHeight;
  if (canvas.width !== layout.pixelWidth || canvas.height !== layout.pixelHeight) {
    throw new Error("ブラウザーが必要なPNG寸法を確保できませんでした。");
  }

  const context = canvas.getContext("2d");
  if (!context) throw new Error("画像描画を開始できませんでした。");

  // Right binding: front cover on the left, spine in the center, back cover on the right.
  // The selected background is one continuous fill across all three panels and bleed.
  const scaleX = canvas.width / layout.coverWidthMm;
  const scaleY = canvas.height / heightMm;
  context.scale(scaleX, scaleY);
  context.fillStyle = palette.background;
  context.fillRect(0, 0, layout.coverWidthMm, heightMm);

  const frontX = layout.panels.front.xMm;
  const frontCenterX = frontX + layout.panels.front.widthMm / 2;
  const frontCenterY = heightMm / 2;
  const pxPerMmX = canvas.width / layout.coverWidthMm;
  const pxPerMmY = canvas.height / heightMm;
  const titleFontPx = 20 * BOOK_PRODUCTION.dpi / 72;
  const authorFontPx = 9 * BOOK_PRODUCTION.dpi / 72;
  const maxTextWidthPx = (BOOK_PRODUCTION.trimWidthMm - 24) * pxPerMmX;

  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = palette.foreground;
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.font = `bold ${titleFontPx}px "Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP", serif`;
  const titleLines = wrapCanvasText(context, title, maxTextWidthPx);
  const titleLineHeight = titleFontPx * 1.5;
  const titleBlockHeight = titleLines.length * titleLineHeight;
  const authorGapPx = 12 * pxPerMmY;
  const authorHeight = authorFontPx * 1.4;
  const centerYPx = frontCenterY * pxPerMmY;
  const titleTopPx = centerYPx - (titleBlockHeight + authorGapPx + authorHeight) / 2;
  const frontCenterXPx = frontCenterX * pxPerMmX;
  const baselineOffset = titleFontPx * 0.86;
  titleLines.forEach((line, index) => {
    context.fillText(line, frontCenterXPx, titleTopPx + baselineOffset + index * titleLineHeight);
  });
  context.globalAlpha = 0.85;
  context.font = `${authorFontPx}px "Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP", serif`;
  context.fillText(editor, frontCenterXPx, titleTopPx + titleBlockHeight + authorGapPx + authorFontPx);
  context.restore();

  if (spineTextLayout) {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = palette.foreground;
    context.globalAlpha = 0.92;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `${spineTextLayout.fontSizeMm * pxPerMmX}px "Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP", serif`;
    const spineCenterXPx = (layout.panels.spine.xMm + layout.panels.spine.widthMm / 2) * pxPerMmX;
    Array.from(spineTextLayout.text).forEach((character, index) => {
      context.fillText(character, spineCenterXPx, (spineTextLayout.startYmm + index * spineTextLayout.lineHeightMm) * pxPerMmY);
    });
    context.restore();
  }

  if (book.coverStyle === "classic") {
    context.save();
    context.strokeStyle = palette.foreground;
    context.lineWidth = 0.25 * pxPerMmX;
    context.strokeRect(
      BOOK_PRODUCTION.bleedMm * pxPerMmX + 6 * pxPerMmX,
      BOOK_PRODUCTION.bleedMm * pxPerMmY + 6 * pxPerMmY,
      (BOOK_PRODUCTION.trimWidthMm - 12) * pxPerMmX,
      (layout.panels.trimHeightMm - 12) * pxPerMmY,
    );
    context.restore();
  }

  const rawBlob = await canvasBlob(canvas);
  const pngBytes = new Uint8Array(await rawBlob.arrayBuffer());
  const printBytes = addPngResolutionMetadata(pngBytes, BOOK_PRODUCTION.dpi);
  assertPngPrintProperties(printBytes, layout.pixelWidth, layout.pixelHeight, BOOK_PRODUCTION.dpi);
  const printBuffer = new ArrayBuffer(printBytes.byteLength);
  new Uint8Array(printBuffer).set(printBytes);
  return new Blob([printBuffer], { type: "image/png" });
}
