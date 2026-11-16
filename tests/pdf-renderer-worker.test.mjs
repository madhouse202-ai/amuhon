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
  const [dockerfile, fontScript, worker, renderer, localPdf, finalPage, docs, cloudHandoff, gitignore, packageJson, packageLock] = await Promise.all([
    readFile(new URL("../Dockerfile.pdf-renderer", import.meta.url), "utf8"),
    readFile(new URL("../scripts/fetch-pinned-pdf-font.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/render-order-assets-worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/pdf-renderer-worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-final-pdf.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/final/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../docs/PDF_RENDERER_WORKER.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/CLOUD_RUN_HANDOFF.md", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  ]);

  assert.match(dockerfile, /mcr\.microsoft\.com\/playwright:v1\.65\.0-noble/);
  assert.match(dockerfile, /npm ci --include=dev[\s\S]*npm run build[\s\S]*npm prune --omit=dev[\s\S]*require\('playwright-core'\)/);
  const parsedPackage = JSON.parse(packageJson);
  const parsedLock = JSON.parse(packageLock);
  assert.equal(parsedPackage.dependencies["playwright-core"], "1.65.0");
  assert.equal(parsedPackage.devDependencies["playwright-core"], undefined);
  assert.equal(parsedLock.packages[""].dependencies["playwright-core"], "1.65.0");
  assert.equal(parsedLock.packages[""].devDependencies["playwright-core"], undefined);
  assert.equal(parsedLock.packages["node_modules/playwright-core"].version, "1.65.0");
  assert.equal(parsedLock.packages["node_modules/playwright-core"].dev, undefined);
  assert.match(fontScript, /const VERSION = "2\.003"/);
  assert.match(fontScript, /noto-cjk\/Serif\$\{VERSION\}/);
  assert.match(fontScript, new RegExp(NOTO_SERIF_JP_FONT_SHA256));
  assert.match(fontScript, /const FONT_SIZE = 24_573_864/);
  assert.match(fontScript, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(worker, /process\.env\.ORDER_PDF_RENDER_URL = `http:\/\/127\.0\.0\.1:\$\{port\}\/final`/);
  assert.match(worker, /HOSTNAME: "127\.0\.0\.1"/);
  assert.match(worker, /passage\.repeat\(140\)/);
  assert.match(worker, /if \(selfTest && result\.rubyCount <= 0\) throw new Error\("self_test_ruby_missing"\)/);
  assert.match(worker, /minimalServerEnvironment/);
  assert.match(worker, /--run-queue-once/);
  assert.match(worker, /AMUHON_PDF_QUEUE_ENABLED !== "true"/);
  assert.match(worker, /AMUHON_PDF_WORKER_BROWSER_MODE !== "pinned"/);
  assert.match(worker, /claimedQueueJob\.leaseId,[\s\S]*?"worker_unavailable"[\s\S]*?PDF_QUEUE_FAILURE_RECORDING_PENDING/);
  assert.ok(worker.indexOf("queueAdapter.claim(PDF_RENDER_LEASE_SECONDS)") < worker.indexOf("server = await startAppServer(port)"),
    "idle queue executions must not start the app server/browser runtime");
  const isolatedEnvironment = worker.slice(worker.indexOf("function minimalServerEnvironment"), worker.indexOf("async function waitForLocalServer"));
  assert.doesNotMatch(isolatedEnvironment, /SUPABASE_URL|SUPABASE_SECRET_KEY|STRIPE_SECRET|AMUHON_ADMIN_USER_ID/);
  assert.match(worker, /path\.relative\(ROOT, saved\.pdfPath\)/);
  assert.doesNotMatch(worker, /console\.log\(`Body PDF: \$\{saved\.pdfPath\}`\)/);
  assert.match(renderer, /renderLocalFinalBodyPdf\(input\.book, expectedBodyPdfPageCount/);
  assert.match(finalPage, /data-final-layout-ready=\{canPrint \? "true" : "false"\}/);
  assert.match(finalPage, /data-submission-page-count=\{submissionPageCount\}/);
  assert.match(localPdf, /data-final-layout-ready="true"/);
  assert.match(localPdf, /data-submission-page-count/);
  assert.doesNotMatch(localPdf, /実組版結果/);
  assert.match(renderer, /verifyNotoFontUsage: true/);
  assert.match(renderer, /onDiagnosticCode,/);
  assert.match(renderer, /validateCoverPng\(coverPngBytes, body\.pageCount\)/);
  assert.doesNotMatch(worker + renderer, /SUPABASE_SERVICE_ROLE_KEY|STRIPE_SECRET_KEY|checkout\.sessions|supabase\.co/);
  assert.match(docs, /Paid-order queue \(implementation present; not deployed\)/i);
  assert.match(docs, /AMUHON_PDF_QUEUE_PROJECT_REF/);
  assert.match(docs, /docker run --rm --network none --mount[\s\S]*--self-test/);
  assert.match(docs, /target=\/app\/tmp\/pdf-renderer-worker/);
  assert.match(docs, /Test-Path -LiteralPath \$bodyPdf -PathType Leaf/);
  assert.match(docs, /Test-Path -LiteralPath \$coverPng -PathType Leaf/);
  assert.match(docs, /Invoke-Item \$bodyPdf[\s\S]*Invoke-Item \$coverPng/);
  assert.match(cloudHandoff, /--platform linux\/amd64/);
  assert.match(cloudHandoff, /--run-queue-once/);
  assert.match(cloudHandoff, /--tasks=1 --parallelism=1 --max-retries=0 --task-timeout=20m/);
  assert.match(cloudHandoff, /35 \* \* \* \*/);
  assert.match(cloudHandoff, /`\/app\/tmp\/pdf-renderer-worker`/);
  assert.match(cloudHandoff, /--max-retry-attempts=0/);
  const jobCreateExample = cloudHandoff.match(/gcloud run jobs create[\s\S]*?```/)?.[0] ?? "";
  assert.ok(jobCreateExample);
  assert.doesNotMatch(jobCreateExample, /--execute-now/);
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
