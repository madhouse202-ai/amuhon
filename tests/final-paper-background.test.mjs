import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright-core";

import { findFinalPdfChromiumExecutable } from "../lib/local-final-pdf.ts";
import { resolveFinalPdfRendererConfig } from "../lib/final-pdf-renderer-config.ts";

test("buyer page cannot export print assets; the internal renderer alone receives print layout", async () => {
  const [css, page, renderer] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/final/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-final-pdf.ts", import.meta.url), "utf8"),
  ]);

  assert.match(css, /html\[data-amuhon-pdf-renderer="true"\] \.print-root\s*\{\s*display:\s*block/);
  assert.match(css, /html:not\(\[data-amuhon-pdf-renderer="true"\]\) \.print-root\s*\{\s*display:\s*none/);
  assert.match(page, /印刷用データはブラウザーへ渡しません/);
  assert.doesNotMatch(page, /window\.print\(|本文データを保存|表紙データを保存|開発者向け：/);
  assert.match(renderer, /if \(!root\) return false;[\s\S]*?root\.dataset\.amuhonPdfRenderer = "true";[\s\S]*?new MutationObserver/);
  assert.match(renderer, /markerInstalled: document\.documentElement\?\.dataset\.amuhonPdfRenderer === "true"/);
  assert.match(renderer, /printBackground:\s*true/);
  assert.match(renderer, /validateBodyPdf\(pdfBytes\)/);
});

test("renderer marker waits for documentElement at Chromium document-start", { timeout: 30_000 }, async () => {
  const config = resolveFinalPdfRendererConfig({ ...process.env, NODE_ENV: "development" });
  const browser = await chromium.launch({
    executablePath: await findFinalPdfChromiumExecutable(config),
    headless: true,
  });

  try {
    const page = await browser.newPage();
    let pageErrorCount = 0;
    page.on("pageerror", () => { pageErrorCount += 1; });
    await page.addInitScript((expectedOrigin) => {
      if (window.location.origin !== expectedOrigin) return;
      const markDocumentElement = () => {
        const root = document.documentElement;
        if (!root) return false;
        root.dataset.amuhonPdfRenderer = "true";
        return true;
      };
      if (markDocumentElement()) return;
      const observer = new MutationObserver(() => {
        if (markDocumentElement()) observer.disconnect();
      });
      observer.observe(document, { childList: true });
    }, "null");
    await page.goto("data:text/html,<!doctype html><html><head></head><body></body></html>");

    assert.equal(await page.locator('html[data-amuhon-pdf-renderer="true"]').count(), 1);
    assert.equal(pageErrorCount, 0);
  } finally {
    await browser.close();
  }
});
