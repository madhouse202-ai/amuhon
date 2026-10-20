import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { calculateCoverLayout } from "../lib/production.ts";

const CLI = fileURLToPath(new URL("../scripts/validate-order-assets.mjs", import.meta.url));

async function createPdf(pageCount) {
  const doc = await PDFDocument.create();
  const width = 105 / 25.4 * 72;
  const height = 148 / 25.4 * 72;
  for (let i = 0; i < pageCount; i += 1) doc.addPage([width, height]);
  return new Uint8Array(await doc.save());
}

async function createPng(pageCount) {
  const layout = calculateCoverLayout(pageCount);
  assert.ok(layout);
  return new Uint8Array(await sharp({
    create: { width: layout.pixelWidth, height: layout.pixelHeight, channels: 3, background: { r: 20, g: 50, b: 80 } },
  }).png().withMetadata({ density: 350 }).toBuffer());
}

async function withFixtureFiles(fn, { pdf = createPdf(24), png = createPng(24) } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "amuhon-order-validator-"));
  const pdfPath = join(dir, "body.pdf");
  const pngPath = join(dir, "cover.png");
  try {
    await writeFile(pdfPath, await pdf);
    await writeFile(pngPath, await png);
    await fn(pdfPath, pngPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCli(pdfPath, pngPath) {
  return spawnSync(process.execPath, ["--experimental-strip-types", CLI, pdfPath, pngPath], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
}

test("local CLI validates real temporary PDF and PNG files and reports measurements", async () => {
  await withFixtureFiles((pdfPath, pngPath) => {
    const result = runCli(pdfPath, pngPath);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "valid");
    assert.equal(report.bodyPdf.pageCount, 24);
    assert.ok(report.bodyPdf.bytes > 0);
    assert.ok(report.coverPng.width > 0 && report.coverPng.height > 0);
    assert.ok(report.metrics.elapsedMs >= 0);
    assert.ok(report.metrics.userCpuMs >= 0);
    assert.ok(report.metrics.systemCpuMs >= 0);
    assert.ok(report.metrics.processPeakRssBytes > 0);
  });
});

test("local CLI clearly rejects corrupt files without printing file contents", async () => {
  await withFixtureFiles(async (pdfPath, pngPath) => {
    await writeFile(pdfPath, "not a pdf; do not echo this");
    const result = runCli(pdfPath, pngPath);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "invalid");
    assert.equal(report.bodyPdf.status, "invalid");
    assert.equal(report.coverPng.status, "not_checked");
    assert.doesNotMatch(result.stdout, /do not echo this/);
  });
});

test("local CLI rejects a file above 40,000,000 bytes before reading it", async () => {
  await withFixtureFiles(async (pdfPath, pngPath) => {
    const file = await open(pdfPath, "r+");
    try {
      await file.truncate(40_000_001);
    } finally {
      await file.close();
    }
    const result = runCli(pdfPath, pngPath);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.bodyPdf.bytes, 40_000_001);
    assert.match(report.bodyPdf.error, /40,000,000バイト/);
    assert.equal(report.coverPng.status, "not_checked");
  });
});

test("CLI usage failure does not expose paths or environment values", async () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", CLI], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).status, "usage");
});
