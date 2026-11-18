import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(renderer, /document\.documentElement\.dataset\.amuhonPdfRenderer = "true"/);
  assert.match(renderer, /printBackground:\s*true/);
  assert.match(renderer, /validateBodyPdf\(pdfBytes\)/);
});
