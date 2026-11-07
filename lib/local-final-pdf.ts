import { access } from "node:fs/promises";
import { chromium } from "playwright-core";

import type { BookData } from "./book.ts";
import { validateBodyPdf } from "./order-assets.ts";

const LOCAL_FINAL_URL = "http://localhost:3000/final";
const BROWSER_EXECUTABLES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

export type LocalFinalPdfResult = {
  pdfBytes: Uint8Array;
  pageCount: number;
  rubyCount: number;
  visualSample?: Uint8Array;
};

async function findBrowserExecutable(): Promise<string> {
  for (const executablePath of BROWSER_EXECUTABLES) {
    try {
      await access(executablePath);
      return executablePath;
    } catch {
      // Only standard local Chrome/Edge installation paths are considered.
    }
  }
  throw new Error("ローカルのChromeまたはEdgeが見つかりません。");
}

/** Render only the fixed local /final page; no caller-supplied URL, HTML, or file path is accepted. */
export async function renderLocalFinalBodyPdf(
  book: BookData,
  expectedPageCount: number,
  options: { includeVisualSample?: boolean; requireRubyNodes?: boolean } = {},
): Promise<LocalFinalPdfResult> {
  const browser = await chromium.launch({
    executablePath: await findBrowserExecutable(),
    headless: true,
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "ja-JP",
    });
    const page = await context.newPage();
    await page.addInitScript((bookData) => {
      if (location.origin === "http://localhost:3000") {
        localStorage.setItem("amuhon-book", JSON.stringify(bookData));
      }
    }, book);
    const response = await page.goto(LOCAL_FINAL_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!response?.ok()) throw new Error("ローカルの本文組版画面を開けませんでした。");

    try {
      await page.waitForFunction(() => {
        const statuses = [...document.querySelectorAll('[role="status"]')];
        return statuses.some((element) => element.textContent?.includes("実組版結果")) ||
          Boolean(document.querySelector('[role="alert"]'));
      }, null, { timeout: 120_000 });
    } catch {
      throw new Error("青空文庫本文の取得または組版が時間内に完了しませんでした。");
    }

    const alertText = await page.locator('[role="alert"]').allTextContents();
    if (alertText.some((text) => text.includes("本文を取得できなかった作品"))) {
      throw new Error("選択した作品の本文をすべて取得できませんでした。");
    }
    const status = await page.locator('[role="status"]')
      .filter({ hasText: "実組版結果" })
      .first()
      .innerText();
    const match = /本文PDF\s*(\d+)\s*ページ/.exec(status);
    const composedPageCount = match ? Number(match[1]) : NaN;
    if (composedPageCount !== expectedPageCount) {
      throw new Error("組版した本文ページ数が、/final から引き継いだ申告ページ数と一致しません。");
    }

    const sheets = await page.locator(".print-sheet").count();
    if (sheets !== expectedPageCount + 2) {
      throw new Error("印刷用ページ構成を確認できませんでした。");
    }
    const rubyCount = await page.locator(".print-character-cell__ruby").count();
    if (options.requireRubyNodes && rubyCount === 0) {
      throw new Error("ルビを含む本文組版を確認できませんでした。");
    }

    await page.locator(".print-root").evaluate((element) => element.classList.add("print-root--body-only"));
    await page.emulateMedia({ media: "print" });
    await page.evaluate(() => document.fonts.ready.then(() => true));

    let visualSample: Uint8Array | undefined;
    if (options.includeVisualSample) {
      const rubyPage = page.locator(".print-character-cell__ruby").first()
        .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' print-sheet ')][1]");
      visualSample = await rubyPage.screenshot();
    }

    const pdfBytes = new Uint8Array(await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: false,
    }));
    const validated = await validateBodyPdf(pdfBytes);
    if (validated.pageCount !== expectedPageCount) {
      throw new Error("生成した本文PDFのページ数が申告値と一致しません。");
    }
    return { pdfBytes, pageCount: validated.pageCount, rubyCount, visualSample };
  } finally {
    await browser.close();
  }
}
