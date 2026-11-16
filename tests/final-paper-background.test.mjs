import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("body-only print PDF suppresses the cream page background while browser preview keeps it", async () => {
  const [css, page, renderer] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/final/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-final-pdf.ts", import.meta.url), "utf8"),
  ]);

  const printBlock = css.match(/@media print\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(printBlock, "print stylesheet block exists");
  assert.match(
    printBlock,
    /\.print-root--body-only\s+\.print-page\s*\{\s*background:\s*transparent\s*!important;\s*\}/,
    "body-only PDF pages override the React inline cream background only for print",
  );
  assert.equal((css.match(/\.print-root--body-only\s+\.print-page\s*\{/g) ?? []).length, 1);

  assert.match(page, /className="print-page"[\s\S]{0,180}background:\s*"#f8f3df"/);
  assert.match(page, /className=\{`print-root\$\{pdfOutputMode === "body-only" \? " print-root--body-only" : ""\}`\}/);

  assert.match(renderer, /classList\.add\("print-root--body-only"\)[\s\S]*?emulateMedia\(\{\s*media:\s*"print"\s*\}\)/);
  assert.match(renderer, /printBackground:\s*true/);
  assert.match(renderer, /validateBodyPdf\(pdfBytes\)/);
});
