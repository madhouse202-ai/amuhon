import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import {
  createOrderValidationWorker,
  FINAL_ORDER_FILES_BUCKET,
  TEMP_ORDER_FILES_BUCKET,
  ValidationLeaseLostError,
} from "../lib/order-validation-worker.ts";
import { MAX_ORDER_ASSET_BYTES } from "../lib/order-assets.ts";
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

const TEST_ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TEST_ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const TEST_LEASE_ID = "33333333-3333-4333-8333-333333333333";
const NEXT_LEASE_ID = "44444444-4444-4444-8444-444444444444";
const FIXED_NOW = Date.parse("2026-10-22T00:00:00.000Z");
const TEST_JOB = {
  orderId: TEST_ORDER_ID,
  attemptId: TEST_ATTEMPT_ID,
  leaseId: TEST_LEASE_ID,
  leaseExpiresAt: new Date(FIXED_NOW + 60_000).toISOString(),
  bodyObjectKey: `${TEST_ORDER_ID}/${TEST_ATTEMPT_ID}/body.pdf`,
  coverObjectKey: `${TEST_ORDER_ID}/${TEST_ATTEMPT_ID}/cover.png`,
};

const VALID_PDF = await createPdf(24);
const VALID_PNG = await createPng(24);

function createWorkerHarness({
  jobs = [TEST_JOB],
  body = VALID_PDF,
  cover = VALID_PNG,
  now = () => FIXED_NOW,
  download,
  saveFinalObjectIfAbsent,
  commitValidatedAssets,
  readAssetCommitState,
  fail,
} = {}) {
  const events = [];
  const calls = { claim: 0, fail: [], downloads: [], saves: [], commits: [], reads: 0 };
  const finalDigests = new Map();
  const assets = new Map([
    [TEST_JOB.bodyObjectKey, body],
    [TEST_JOB.coverObjectKey, cover],
  ]);

  const rpc = {
    async claim(input) {
      calls.claim += 1;
      calls.leaseSeconds = input.leaseSeconds;
      events.push("claim");
      return jobs.shift() ?? null;
    },
    async fail(input) {
      calls.fail.push(input);
      events.push(`fail:${input.errorCode}`);
      return fail ? fail(input) : true;
    },
    async commitValidatedAssets(input) {
      calls.commits.push(input);
      events.push("commit");
      if (commitValidatedAssets) return commitValidatedAssets(input);
    },
    async readAssetCommitState(input) {
      calls.reads += 1;
      calls.readAttemptId = input.attemptId;
      events.push("read-commit-state");
      return readAssetCommitState ? readAssetCommitState(input) : "unknown";
    },
  };
  const storage = {
    async downloadTemporaryObject(input) {
      calls.downloads.push(input);
      events.push(`download:${input.key.endsWith("body.pdf") ? "body" : "cover"}`);
      if (download) return download(input, assets);
      const bytes = assets.get(input.key);
      if (!bytes) throw new Error("storage 404");
      return { sizeBytes: bytes.byteLength, bytes };
    },
    async saveFinalObjectIfAbsent(input) {
      calls.saves.push(input);
      events.push(`save:${input.contentType === "application/pdf" ? "body" : "cover"}`);
      if (saveFinalObjectIfAbsent) return saveFinalObjectIfAbsent(input, finalDigests);
      const existingDigest = finalDigests.get(input.key);
      if (existingDigest && existingDigest !== input.sha256) throw new Error("final object digest conflict");
      finalDigests.set(input.key, input.sha256);
    },
  };
  const worker = createOrderValidationWorker(rpc, storage, { now });
  return { worker, rpc, storage, calls, events, finalDigests };
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

test("mock worker validates both assets before saving and commits only after both final saves", async () => {
  const harness = createWorkerHarness();
  const result = await harness.worker.runOnce();
  assert.deepEqual(result, { status: "succeeded" });
  assert.equal(harness.calls.claim, 1);
  assert.equal(harness.calls.leaseSeconds, 300);
  assert.deepEqual(harness.events, ["claim", "download:body", "download:cover", "save:body", "save:cover", "commit"]);
  assert.equal(harness.calls.downloads[0].bucket, TEMP_ORDER_FILES_BUCKET);
  assert.ok(harness.calls.saves.every((entry) => entry.bucket === FINAL_ORDER_FILES_BUCKET));
  assert.equal(harness.calls.commits[0].bodyPdfPageCount, 24);
  assert.equal(harness.calls.commits[0].bodyObjectKey, `${TEST_ORDER_ID}/${TEST_ATTEMPT_ID}/body.pdf`);
  assert.equal(harness.calls.commits[0].coverObjectKey, `${TEST_ORDER_ID}/${TEST_ATTEMPT_ID}/cover.png`);
  assert.equal(harness.calls.fail.length, 0);
});

test("mock worker rejects invalid PDF without downloading the cover or saving files", async () => {
  const harness = createWorkerHarness({ body: new TextEncoder().encode("invalid-pdf") });
  const result = await harness.worker.runOnce();
  assert.deepEqual(result, { status: "validation_failed", errorCode: "invalid_pdf" });
  assert.deepEqual(harness.calls.fail.map((call) => call.errorCode), ["invalid_pdf"]);
  assert.equal(harness.calls.downloads.length, 1);
  assert.equal(harness.calls.saves.length, 0);
  assert.equal(harness.calls.commits.length, 0);
});

test("mock worker rejects invalid PNG after validating PDF and before any final save", async () => {
  const harness = createWorkerHarness({ cover: new TextEncoder().encode("invalid-png") });
  const result = await harness.worker.runOnce();
  assert.deepEqual(result, { status: "validation_failed", errorCode: "invalid_cover" });
  assert.deepEqual(harness.calls.fail.map((call) => call.errorCode), ["invalid_cover"]);
  assert.equal(harness.calls.downloads.length, 2);
  assert.equal(harness.calls.saves.length, 0);
});

test("mock worker treats a temporary Storage 404 as retryable and never promotes files", async () => {
  const harness = createWorkerHarness({
    download: async () => { throw new Error("storage 404"); },
  });
  const result = await harness.worker.runOnce();
  assert.deepEqual(result, { status: "retryable_failure", errorCode: "storage_unavailable" });
  assert.deepEqual(harness.calls.fail.map((call) => call.errorCode), ["storage_unavailable"]);
  assert.equal(harness.calls.saves.length, 0);
});

test("mock worker rejects an over-limit object before parsing its bytes", async () => {
  const harness = createWorkerHarness({
    download: async () => ({ sizeBytes: MAX_ORDER_ASSET_BYTES + 1, bytes: new Uint8Array(0) }),
  });
  const result = await harness.worker.runOnce();
  assert.deepEqual(result, { status: "validation_failed", errorCode: "file_too_large" });
  assert.deepEqual(harness.calls.fail.map((call) => call.errorCode), ["file_too_large"]);
  assert.equal(harness.calls.saves.length, 0);
});

test("mock worker classifies a network disconnect during download as retryable", async () => {
  const harness = createWorkerHarness({
    download: async ({ key }, assets) => {
      if (key.endsWith("cover.png")) throw new Error("connection reset");
      const bytes = assets.get(key);
      return { sizeBytes: bytes.byteLength, bytes };
    },
  });
  const result = await harness.worker.runOnce();
  assert.deepEqual(result, { status: "retryable_failure", errorCode: "storage_unavailable" });
  assert.equal(harness.calls.downloads.length, 2);
  assert.equal(harness.calls.saves.length, 0);
});

test("mock worker stops before promotion when the lease expires during validation", async () => {
  let clock = FIXED_NOW;
  const harness = createWorkerHarness({
    now: () => clock,
    download: async ({ key }, assets) => {
      const bytes = assets.get(key);
      if (key.endsWith("cover.png")) clock = FIXED_NOW + 60_001;
      return { sizeBytes: bytes.byteLength, bytes };
    },
  });
  const result = await harness.worker.runOnce();
  assert.deepEqual(result, { status: "lease_expired" });
  assert.equal(harness.calls.saves.length, 0);
  assert.equal(harness.calls.commits.length, 0);
  assert.equal(harness.calls.fail.length, 0);
});

test("mock worker leaves an already-saved body object for safe retry if cover save fails", async () => {
  const harness = createWorkerHarness({
    saveFinalObjectIfAbsent: async (input, finalDigests) => {
      if (input.contentType === "image/png") throw new Error("connection reset after body save");
      finalDigests.set(input.key, input.sha256);
    },
  });
  const result = await harness.worker.runOnce();
  assert.deepEqual(result, { status: "retryable_failure", errorCode: "storage_unavailable" });
  assert.deepEqual(harness.events.slice(-3), ["save:body", "save:cover", "fail:storage_unavailable"]);
  assert.equal(harness.calls.saves.length, 2);
  assert.equal(harness.finalDigests.size, 1);
  assert.equal(harness.calls.commits.length, 0);
  assert.equal(harness.calls.fail[0].errorCode, "storage_unavailable");
});

test("mock worker resolves an uncertain DB commit by querying state and never deletes files", async () => {
  const harness = createWorkerHarness({
    commitValidatedAssets: async () => { throw new Error("database response timeout"); },
    readAssetCommitState: async () => "unknown",
  });
  const result = await harness.worker.runOnce();
  assert.deepEqual(result, { status: "finalization_unknown" });
  assert.equal(harness.calls.saves.length, 2);
  assert.equal(harness.calls.reads, 1);
  assert.equal(harness.calls.fail.length, 0);
  assert.equal(harness.events.includes("delete"), false);
});

test("mock worker retry reuses same-digest final objects and can finish idempotently", async () => {
  const secondJob = { ...TEST_JOB, leaseId: NEXT_LEASE_ID };
  let commitCount = 0;
  const harness = createWorkerHarness({
    jobs: [{ ...TEST_JOB }, secondJob],
    commitValidatedAssets: async () => {
      commitCount += 1;
      if (commitCount === 1) throw new Error("commit response lost");
    },
    readAssetCommitState: async () => "not_committed",
  });
  assert.deepEqual(await harness.worker.runOnce(), { status: "finalization_pending" });
  const firstSaveKeys = harness.calls.saves.map((entry) => entry.key);
  assert.deepEqual(await harness.worker.runOnce(), { status: "succeeded" });
  const secondSaveKeys = harness.calls.saves.slice(2).map((entry) => entry.key);
  assert.deepEqual(secondSaveKeys, firstSaveKeys);
  assert.equal(harness.calls.claim, 2);
  assert.equal(harness.calls.commits[0].leaseId, TEST_LEASE_ID);
  assert.equal(harness.calls.commits[1].leaseId, NEXT_LEASE_ID);
  assert.equal(harness.calls.fail.length, 0);
  assert.equal(harness.finalDigests.size, 2);
});

test("mock worker does not accept an expired/stale lease for DB finalization", async () => {
  const harness = createWorkerHarness({
    commitValidatedAssets: async () => { throw new ValidationLeaseLostError(); },
  });
  const result = await harness.worker.runOnce();
  assert.deepEqual(result, { status: "lease_lost" });
  assert.equal(harness.calls.commits.length, 1);
  assert.equal(harness.calls.reads, 0);
  assert.equal(harness.calls.fail.length, 0);
  assert.equal(harness.calls.saves.length, 2);
});

test("mock worker instance admits only one in-flight runOnce call", async () => {
  let releaseClaim;
  let claimCount = 0;
  const rpc = {
    claim: () => {
      claimCount += 1;
      return new Promise((resolve) => { releaseClaim = resolve; });
    },
    fail: async () => true,
    commitValidatedAssets: async () => {},
    readAssetCommitState: async () => "unknown",
  };
  const storage = {
    downloadTemporaryObject: async () => ({ sizeBytes: 0, bytes: new Uint8Array() }),
    saveFinalObjectIfAbsent: async () => {},
  };
  const worker = createOrderValidationWorker(rpc, storage);
  const first = worker.runOnce();
  const second = await worker.runOnce();
  assert.deepEqual(second, { status: "busy" });
  assert.equal(claimCount, 1);
  releaseClaim(null);
  assert.deepEqual(await first, { status: "idle" });
});
