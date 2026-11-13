import { chromium } from "playwright-core";
import type { Download } from "playwright-core";

import { bookLayoutKey, type BookData } from "./book.ts";
import {
  NOTO_SERIF_JP_FONT_SHA256,
  NOTO_SERIF_JP_FONT_SIZE_BYTES,
  type FinalPreviewWorkText,
} from "./final-typography-preview.ts";
import { resolveFinalPdfRendererConfig } from "./final-pdf-renderer-config.ts";
import {
  findFinalPdfChromiumExecutable,
  renderLocalFinalBodyPdf,
  type LocalFinalPdfDiagnosticCode,
} from "./local-final-pdf.ts";
import { MAX_ORDER_ASSET_BYTES, validateCoverPng } from "./order-assets.ts";
import { calculateSpineTextLayout } from "./production.ts";
import { createHash } from "node:crypto";

export type PdfRendererStage =
  | "BODY_RENDER_START"
  | "BODY_RENDER_COMPLETE"
  | "COVER_RENDER_START"
  | "COVER_RENDER_COMPLETE"
  | "ASSET_QUALITY_CHECK_COMPLETE";

export type PdfRendererAssetResult = {
  bodyPdfBytes: Uint8Array;
  coverPngBytes: Uint8Array;
  bodyPdfPageCount: number;
  rubyCount: number;
  bodyPdfSha256: string;
  coverPngSha256: string;
  coverWidth: number;
  coverHeight: number;
};

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function downloadBytes(download: Download): Promise<Uint8Array> {
  if (await download.failure()) throw new Error("cover_download_failed");
  const stream = await download.createReadStream();
  if (!stream) throw new Error("cover_download_failed");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_ORDER_ASSET_BYTES) {
      stream.destroy();
      throw new Error("cover_too_large");
    }
    chunks.push(bytes);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

async function renderCoverPng(book: BookData, pageCount: number): Promise<Uint8Array> {
  if (!calculateSpineTextLayout(pageCount, book.title, book.editor)) {
    throw new Error("cover_spine_text_does_not_fit");
  }
  const config = resolveFinalPdfRendererConfig();
  const browser = await chromium.launch({
    executablePath: await findFinalPdfChromiumExecutable(config),
    headless: true,
    timeout: 30_000,
  });
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1440, height: 1000 },
      locale: "ja-JP",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.route("**/*", async (route) => {
      let requestUrl: URL;
      try {
        requestUrl = new URL(route.request().url());
      } catch {
        await route.abort("blockedbyclient");
        return;
      }
      if (requestUrl.origin !== config.renderOrigin || requestUrl.pathname.startsWith("/api/")) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await page.addInitScript(({ bookData, renderOrigin, bodyPdfPageCount, worksKey }) => {
      if (location.origin !== renderOrigin) return;
      localStorage.setItem("amuhon-book", JSON.stringify(bookData));
      sessionStorage.setItem("amuhon-cover-page-count", JSON.stringify({ bodyPdfPageCount, worksKey }));
    }, {
      bookData: book,
      renderOrigin: config.renderOrigin,
      bodyPdfPageCount: pageCount,
      worksKey: bookLayoutKey(book, book.title, book.editor),
    });

    const response = await page.goto(`${config.renderOrigin}/cover`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!response?.ok()) throw new Error("cover_navigation_failed");
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) =>
      button.textContent?.trim() === "見開きカバーPNGをダウンロード" &&
      !(button as HTMLButtonElement).disabled));

    const button = page.getByRole("button", { name: "見開きカバーPNGをダウンロード", exact: true });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      button.click(),
    ]);
    return await downloadBytes(download);
  } finally {
    await browser.close();
  }
}

/** Generate files using the real /final and /cover pages, then run existing validators. */
export async function renderPdfRendererJob(
  input: { book: BookData; works: FinalPreviewWorkText[] },
  notoFontBytes: Uint8Array,
  onStage?: (stage: PdfRendererStage) => void,
  onDiagnosticCode?: (code: LocalFinalPdfDiagnosticCode) => void,
): Promise<PdfRendererAssetResult> {
  if (notoFontBytes.byteLength !== NOTO_SERIF_JP_FONT_SIZE_BYTES ||
      digest(notoFontBytes).toUpperCase() !== NOTO_SERIF_JP_FONT_SHA256) {
    throw new Error("pinned_font_invalid");
  }

  onStage?.("BODY_RENDER_START");
  const body = await renderLocalFinalBodyPdf(input.book, null, {
    bodyTypography: "noto-serif-jp",
    preloadedWorks: input.works,
    verifyNotoFontUsage: true,
    notoFontBytes,
    blockExternalRequests: true,
    timeoutMs: 180_000,
    onDiagnosticCode,
  });
  onStage?.("BODY_RENDER_COMPLETE");

  onStage?.("COVER_RENDER_START");
  const coverPngBytes = await renderCoverPng(input.book, body.pageCount);
  onStage?.("COVER_RENDER_COMPLETE");

  const cover = await validateCoverPng(coverPngBytes, body.pageCount);
  onStage?.("ASSET_QUALITY_CHECK_COMPLETE");
  return {
    bodyPdfBytes: body.pdfBytes,
    coverPngBytes,
    bodyPdfPageCount: body.pageCount,
    rubyCount: body.rubyCount,
    bodyPdfSha256: digest(body.pdfBytes),
    coverPngSha256: cover.sha256,
    coverWidth: cover.width,
    coverHeight: cover.height,
  };
}
