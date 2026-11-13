import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { parsePdfRenderJob } from "../lib/pdf-render-job.ts";
import { NOTO_SERIF_JP_FONT_SHA256 } from "../lib/final-typography-preview.ts";

const jobId = "f7728c6d-7af3-4c3c-8ac2-fd49a2dce4db";
const book = {
  title: "試験本",
  editor: "試験編者",
  coverStyle: "classic",
  coverColor: "blue",
  works: [{
    id: "000015",
    title: "作品一",
    author: "作者一",
    cardUrl: "https://www.aozora.gr.jp/cards/000000/card15.html",
    textUrl: "https://www.aozora.gr.jp/cards/000000/files/15_1.txt",
    xhtmlUrl: "https://www.aozora.gr.jp/cards/000000/files/15_1.html",
  }],
};
const validJob = {
  schemaVersion: 1,
  jobId,
  book,
  works: [{ id: "000015", title: "作品一", author: "作者一", text: "本文｜漢字《かんじ》の試験。" }],
};

test("render job accepts only an ordered bounded book and matching preloaded text", () => {
  const parsed = parsePdfRenderJob(validJob);
  assert.ok(parsed);
  assert.equal(parsed.jobId, jobId);
  assert.deepEqual(parsed.book.works.map((work) => work.id), ["000015"]);
  assert.equal(parsed.works[0].text, validJob.works[0].text);
});

test("render job rejects arbitrary render targets, mismatched text, unknown fields, and invalid job ids", () => {
  for (const mutation of [
    (input) => { input.renderUrl = "https://example.com"; },
    (input) => { input.book.works[0].textUrl = "https://example.com/story.txt"; },
    (input) => { input.works[0].title = "別作品"; },
    (input) => { input.jobId = "not-a-uuid"; },
    (input) => { input.price = 1; },
  ]) {
    const changed = structuredClone(validJob);
    mutation(changed);
    assert.equal(parsePdfRenderJob(changed), null);
  }
});

test("container and worker keep the browser, font, output, and DB boundaries explicit", async () => {
  const [dockerfile, fontScript, worker, renderer, localPdf, finalPage, docs, gitignore] = await Promise.all([
    readFile(new URL("../Dockerfile.pdf-renderer", import.meta.url), "utf8"),
    readFile(new URL("../scripts/fetch-pinned-pdf-font.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/render-order-assets-worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/pdf-renderer-worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-final-pdf.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/final/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../docs/PDF_RENDERER_WORKER.md", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);

  assert.match(dockerfile, /mcr\.microsoft\.com\/playwright:v1\.65\.0-noble/);
  assert.match(dockerfile, /npm ci[\s\S]*npm run build/);
  assert.match(fontScript, /const VERSION = "2\.003"/);
  assert.match(fontScript, /noto-cjk\/Serif\$\{VERSION\}/);
  assert.match(fontScript, new RegExp(NOTO_SERIF_JP_FONT_SHA256));
  assert.match(fontScript, /const FONT_SIZE = 24_573_864/);
  assert.match(fontScript, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(worker, /process\.env\.ORDER_PDF_RENDER_URL = `http:\/\/127\.0\.0\.1:\$\{port\}\/final`/);
  assert.match(worker, /HOSTNAME: "127\.0\.0\.1"/);
  assert.match(worker, /passage\.repeat\(140\)/);
  assert.match(worker, /minimalServerEnvironment/);
  assert.match(worker, /path\.relative\(ROOT, saved\.pdfPath\)/);
  assert.doesNotMatch(worker, /console\.log\(`Body PDF: \$\{saved\.pdfPath\}`\)/);
  assert.match(renderer, /renderLocalFinalBodyPdf\(input\.book, null/);
  assert.match(finalPage, /data-final-layout-ready=\{canPrint \? "true" : "false"\}/);
  assert.match(finalPage, /data-submission-page-count=\{submissionPageCount\}/);
  assert.match(localPdf, /data-final-layout-ready="true"/);
  assert.match(localPdf, /data-submission-page-count/);
  assert.doesNotMatch(localPdf, /実組版結果/);
  assert.match(renderer, /verifyNotoFontUsage: true/);
  assert.match(renderer, /onDiagnosticCode,/);
  assert.match(renderer, /validateCoverPng\(coverPngBytes, body\.pageCount\)/);
  assert.doesNotMatch(worker + renderer, /SUPABASE_SERVICE_ROLE_KEY|STRIPE_SECRET_KEY|checkout\.sessions|supabase\.co/);
  assert.match(docs, /not yet a production order worker/i);
  assert.match(gitignore, /\/tmp\/pdf-renderer-worker\//);
});

test("UI Geist fonts are self-hosted from the lockfile-pinned Next package without Google Fonts build fetches", async () => {
  const [layout, notice, geistSans, geistMono] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../docs/GEIST_FONT_NOTICE.md", import.meta.url), "utf8"),
    readFile(new URL("../node_modules/next/dist/next-devtools/server/font/geist-latin.woff2", import.meta.url)),
    readFile(new URL("../node_modules/next/dist/next-devtools/server/font/geist-mono-latin.woff2", import.meta.url)),
  ]);

  assert.match(layout, /from "next\/font\/local"/);
  assert.match(layout, /geist-latin\.woff2/);
  assert.match(layout, /geist-mono-latin\.woff2/);
  assert.doesNotMatch(layout, /next\/font\/google|fonts\.googleapis\.com/);
  assert.equal(createHash("sha256").update(geistSans).digest("hex").toUpperCase(),
    "1B5EBFB3A01A97343AC96873E6D59A8CB285C66012B6A1AC509CB2765E995BA8");
  assert.equal(createHash("sha256").update(geistMono).digest("hex").toUpperCase(),
    "B7AC144B394CBD81052D6397EC0C33397977B1D7E9BC095E744E652A378C6FB3");
  assert.match(notice, /SIL Open Font License 1\.1/);
  assert.match(notice, /package-lock\.json/);
});
