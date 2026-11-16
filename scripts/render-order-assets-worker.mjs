import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { parsePdfRenderJob } from "../lib/pdf-render-job.ts";
import { renderPdfRendererJob } from "../lib/pdf-renderer-worker.ts";
import { resolveFinalPdfRendererConfig } from "../lib/final-pdf-renderer-config.ts";
import { createPdfRenderQueueWorker, PDF_RENDER_LEASE_SECONDS } from "../lib/pdf-render-queue-worker.ts";
import { createSupabasePdfRenderQueueAdapter } from "../lib/pdf-render-queue-supabase.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_INPUT_BYTES = 9_000_000;
const MAX_AOZORA_RESPONSE_BYTES = 8_500_000;
const MAX_TOTAL_WORK_TEXT_BYTES = 8_000_000;
const MAX_SINGLE_WORK_TEXT_BYTES = 4_000_000;
const APP_START_TIMEOUT_MS = 30_000;
const APP_STOP_TIMEOUT_MS = 5_000;
const OUTPUT_ROOT = path.join(ROOT, "tmp", "pdf-renderer-worker");
const DEFAULT_FONT_PATH = path.join(ROOT, ".local-assets", "fonts", "NotoSerifCJKjp-Regular.otf");

function logCode(code, metrics = "") {
  const safeMetrics = metrics ? ` ${metrics}` : "";
  console.log(`[pdf-renderer-worker] ${code}${safeMetrics}`);
}

async function readInput() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_INPUT_BYTES) throw new Error("job_input_too_large");
    chunks.push(bytes);
  }
  if (total === 0) throw new Error("job_input_missing");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new Error("job_input_invalid");
  }
  const job = parsePdfRenderJob(parsed);
  if (!job) throw new Error("job_input_refused");
  return job;
}

function createSelfTestJob() {
  const selected = [
    { id: "000015", title: "試作・春の記録", author: "青空文庫テスト", cardUrl: "https://www.aozora.gr.jp/cards/000000/card15.html", textUrl: "https://www.aozora.gr.jp/cards/000000/files/15_1.txt", xhtmlUrl: "https://www.aozora.gr.jp/cards/000000/files/15_1.html" },
    { id: "000016", title: "試作・雨の記録", author: "青空文庫テスト", cardUrl: "https://www.aozora.gr.jp/cards/000000/card16.html", textUrl: "https://www.aozora.gr.jp/cards/000000/files/16_1.txt", xhtmlUrl: "https://www.aozora.gr.jp/cards/000000/files/16_1.html" },
    { id: "000017", title: "試作・夜の記録", author: "青空文庫テスト", cardUrl: "https://www.aozora.gr.jp/cards/000000/card17.html", textUrl: "https://www.aozora.gr.jp/cards/000000/files/17_1.txt", xhtmlUrl: "https://www.aozora.gr.jp/cards/000000/files/17_1.html" },
  ];
  const passage = "春の風が庭を通り、古い木立には淡い光が差していた。｜小径《こみち》を歩く人は、遠くの鐘の音に耳を澄ませる。雨上がりの石畳、静かな水面、そして一冊の本。文章の配置と縦書きの流れを確かめるための合成試験本文である。\n\n";
  // Keep the synthetic book long enough for the existing cover-spine safety rule.
  const text = passage.repeat(140);
  return parsePdfRenderJob({
    schemaVersion: 1,
    jobId: randomUUID(),
    book: { title: "PDFレンダラー検証本", editor: "開発試験", coverStyle: "classic", coverColor: "blue", works: selected },
    works: selected.map((work) => ({ id: work.id, title: work.title, author: work.author, text })),
  });
}

function getPort() {
  const raw = process.env.AMUHON_PDF_RENDER_PORT ?? (process.env.AMUHON_PDF_WORKER_BROWSER_MODE === "pinned" ? "3000" : "31415");
  if (!/^\d{1,5}$/.test(raw)) throw new Error("renderer_port_invalid");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("renderer_port_invalid");
  return port;
}

async function chooseBrowserExecutable() {
  const mode = process.env.AMUHON_PDF_WORKER_BROWSER_MODE ?? "local";
  if (mode === "pinned") {
    const pinned = chromium.executablePath();
    if (!existsSync(pinned)) throw new Error("pinned_chromium_missing");
    if (process.env.ORDER_PDF_CHROMIUM_EXECUTABLE_PATH &&
        path.resolve(process.env.ORDER_PDF_CHROMIUM_EXECUTABLE_PATH) !== path.resolve(pinned)) {
      throw new Error("pinned_chromium_path_mismatch");
    }
    return pinned;
  }
  if (mode !== "local") throw new Error("browser_mode_invalid");
  const config = resolveFinalPdfRendererConfig({ NODE_ENV: "development" }, process.platform);
  for (const candidate of config.executableCandidates) if (existsSync(candidate)) return candidate;
  throw new Error("local_chromium_missing");
}

async function createIsolatedNextRuntime() {
  const runtimeDirectory = path.join(OUTPUT_ROOT, `server-${randomUUID()}`);
  try {
    try {
      await mkdir(runtimeDirectory, { recursive: true });
    } catch {
      throw new Error("app_runtime_directory_create_failed");
    }
    const buildDirectory = path.join(ROOT, ".next");
    try {
      await cp(buildDirectory, path.join(runtimeDirectory, ".next"), {
        recursive: true,
        filter: (source) => {
          const relative = path.relative(buildDirectory, source);
          const firstSegment = relative.split(path.sep)[0];
          return !["cache", "dev", "diagnostics", "types"].includes(firstSegment);
        },
      });
    } catch {
      throw new Error("app_runtime_copy_next_build_failed");
    }
    for (const name of ["public", "package.json", "next.config.ts"]) {
      const source = path.join(ROOT, name);
      if (!existsSync(source)) continue;
      try {
        await cp(source, path.join(runtimeDirectory, name), { recursive: true });
      } catch {
        throw new Error(`app_runtime_copy_${name.replace(/[^a-z]/gi, "_")}_failed`);
      }
    }
  } catch (error) {
    await rm(runtimeDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof Error && /^app_runtime_[a-z_]+_failed$/.test(error.message)) throw error;
    throw new Error("app_runtime_prepare_failed");
  }
  return runtimeDirectory;
}

function minimalServerEnvironment(port) {
  const allowed = ["PATH", "HOME", "TMP", "TEMP", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC"];
  const safe = Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
  return {
    ...safe,
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

async function waitForLocalServer(child, origin, didSpawnFail) {
  const deadline = Date.now() + APP_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (didSpawnFail()) throw new Error("app_server_spawn_failed");
    if (child.exitCode !== null) throw new Error("app_server_exited");
    try {
      const response = await fetch(`${origin}/final`, { signal: AbortSignal.timeout(1_000), cache: "no-store" });
      const body = await response.text();
      if (response.status === 200 && new URL(response.url).origin === origin && body.includes("__next")) return;
    } catch {
      // Retry only this fixed loopback URL until the private server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("app_server_start_timeout");
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error) => reject(new Error(error?.code === "EADDRINUSE"
      ? "renderer_port_in_use"
      : "renderer_port_probe_failed")));
    probe.listen(port, "127.0.0.1", () => probe.close((error) => error ? reject(error) : resolve()));
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return true;
  child.kill();
  const stopped = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), APP_STOP_TIMEOUT_MS)),
  ]);
  return stopped === true || child.exitCode !== null;
}

async function startAppServer(port) {
  await assertPortAvailable(port);
  const runtimeDirectory = await createIsolatedNextRuntime();
  const nextCli = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  let child;
  try {
    child = spawn(process.execPath, [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: runtimeDirectory,
      env: minimalServerEnvironment(port),
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    await rm(runtimeDirectory, { recursive: true, force: true });
    throw new Error("app_server_spawn_failed");
  }
  let spawnFailed = false;
  child.once("error", () => { spawnFailed = true; });
  try {
    await waitForLocalServer(child, `http://127.0.0.1:${port}`, () => spawnFailed);
  } catch (error) {
    await stopChild(child);
    await rm(runtimeDirectory, { recursive: true, force: true });
    throw error;
  }
  return { child, runtimeDirectory };
}

async function loadPinnedFont() {
  const fontPath = process.env.AMUHON_PDF_FONT_PATH ||
    (process.env.AMUHON_PDF_WORKER_BROWSER_MODE === "pinned"
      ? "/opt/amuhon/fonts/NotoSerifCJKjp-Regular.otf"
      : DEFAULT_FONT_PATH);
  const bytes = new Uint8Array(await readFile(fontPath));
  return bytes;
}

async function saveAssets(result) {
  const directory = path.join(OUTPUT_ROOT, `render-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const pdfPath = path.join(directory, "body.pdf");
  const pngPath = path.join(directory, "cover.png");
  await writeFile(pdfPath, result.bodyPdfBytes, { flag: "wx" });
  await writeFile(pngPath, result.coverPngBytes, { flag: "wx" });
  return { directory, pdfPath, pngPath };
}

async function readBoundedResponse(response, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("aozora_response_too_large");
  }
  if (!response.body) throw new Error("aozora_response_empty");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("aozora_response_too_large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function loadAozoraWorks(renderOrigin, book) {
  const works = new Array(book.works.length);
  let nextIndex = 0;
  let totalTextBytes = 0;
  const controller = new AbortController();
  const overallTimeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  async function loadOne() {
    while (true) {
      const index = nextIndex++;
      if (index >= book.works.length) return;
      const selected = book.works[index];
      const endpoint = new URL("/api/aozora", renderOrigin);
      endpoint.searchParams.set("url", selected.xhtmlUrl);
      endpoint.searchParams.set("ruby", "1");
      let response;
      try {
        response = await fetch(endpoint, {
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        });
      } catch {
        controller.abort();
        throw new Error("aozora_unavailable");
      }
      if (!response.ok || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        await response.body?.cancel().catch(() => undefined);
        controller.abort();
        throw new Error("aozora_unavailable");
      }
      let record;
      try {
        record = JSON.parse(await readBoundedResponse(response, MAX_AOZORA_RESPONSE_BYTES));
      } catch {
        controller.abort();
        throw new Error("aozora_unavailable");
      }
      if (!record || typeof record !== "object" || Array.isArray(record) ||
          record.sourceUrl !== selected.xhtmlUrl || typeof record.text !== "string" || !record.text.trim()) {
        controller.abort();
        throw new Error("aozora_unavailable");
      }
      const bytes = Buffer.byteLength(record.text, "utf8");
      totalTextBytes += bytes;
      if (bytes > MAX_SINGLE_WORK_TEXT_BYTES || totalTextBytes > MAX_TOTAL_WORK_TEXT_BYTES) {
        controller.abort();
        throw new Error("invalid_snapshot");
      }
      works[index] = {
        id: selected.id,
        title: selected.title,
        author: selected.author,
        text: record.text,
      };
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(8, book.works.length) }, () => loadOne()));
    return works;
  } finally {
    clearTimeout(overallTimeout);
  }
}

async function runQueueOnce(renderOrigin, fontBytes, adapter, claimedJob) {
  const queue = createPdfRenderQueueWorker({
    rpc: {
      claim: async () => claimedJob,
      fail: (orderId, leaseId, errorCode) => adapter.fail(orderId, leaseId, errorCode),
      complete: (input) => adapter.complete(input),
    },
    storage: adapter,
    loadWorkTexts: (book) => loadAozoraWorks(renderOrigin, book),
    render: async ({ book, works, expectedPageCount }) => {
      let transientCode = null;
      let renderFailureCode = null;
      try {
        return await renderPdfRendererJob(
          { book, works },
          fontBytes,
          (stage) => logCode(stage),
          (diagnosticCode) => {
            logCode(diagnosticCode);
            if (diagnosticCode === "CHROMIUM_FAILURE") transientCode = "worker_unavailable";
            if (diagnosticCode === "LAYOUT_WAIT_TIMEOUT_FAILURE") transientCode = "processing_timeout";
            if (diagnosticCode === "LAYOUT_PAGE_COUNT_FAILURE") renderFailureCode = "page_count_mismatch";
          },
          expectedPageCount,
        );
      } catch {
        throw new Error(renderFailureCode ?? transientCode ?? "invalid_render");
      }
    },
  });
  const result = await queue.runOnce();
  const codeByStatus = {
    idle: "PDF_QUEUE_IDLE",
    succeeded: "PDF_QUEUE_JOB_SUCCEEDED",
    busy: "PDF_QUEUE_BUSY",
    lease_expired: "PDF_QUEUE_LEASE_EXPIRED",
    lease_lost: "PDF_QUEUE_LEASE_LOST",
    finalization_unknown: "PDF_QUEUE_FINALIZATION_UNKNOWN",
    retry_queued: "PDF_QUEUE_RETRY_QUEUED",
    terminal_failure: "PDF_QUEUE_TERMINAL_FAILURE",
    failure_recording_pending: "PDF_QUEUE_FAILURE_RECORDING_PENDING",
    claim_failed: "PDF_QUEUE_CLAIM_FAILED",
    claim_contract_mismatch: "PDF_QUEUE_CLAIM_CONTRACT_MISMATCH",
    internal_failure: "PDF_QUEUE_INTERNAL_FAILURE",
  };
  logCode(codeByStatus[result.status] ?? "PDF_QUEUE_INTERNAL_FAILURE");
  if (!["idle", "succeeded"].includes(result.status)) process.exitCode = 1;
}

async function main() {
  const selfTest = process.argv.length === 3 && process.argv[2] === "--self-test";
  const queueMode = process.argv.length === 3 && process.argv[2] === "--run-queue-once";
  if (!selfTest && !queueMode && (process.argv.length !== 2 || process.stdin.isTTY)) {
    throw new Error("provide a bounded JSON job on stdin, --self-test, or --run-queue-once");
  }
  if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) throw new Error("production_build_missing");
  if (queueMode && (process.env.NODE_ENV !== "production" ||
      process.env.AMUHON_PDF_WORKER_BROWSER_MODE !== "pinned" ||
      process.env.AMUHON_PDF_QUEUE_ENABLED !== "true")) {
    throw new Error("queue_worker_not_enabled");
  }
  // Validate the exact project host and required secret before starting a server
  // or attempting any queue/Storage request.
  const queueAdapter = queueMode ? createSupabasePdfRenderQueueAdapter() : null;
  const job = queueMode ? null : selfTest ? createSelfTestJob() : await readInput();
  if (!queueMode && !job) throw new Error("self_test_fixture_invalid");

  const port = getPort();
  const browserExecutable = await chooseBrowserExecutable();
  const fontBytes = await loadPinnedFont();
  let claimedQueueJob = null;
  if (queueMode) {
    try {
      claimedQueueJob = await queueAdapter.claim(PDF_RENDER_LEASE_SECONDS);
    } catch {
      logCode("PDF_QUEUE_CLAIM_FAILED");
      process.exitCode = 1;
      return;
    }
    if (!claimedQueueJob) {
      logCode("PDF_QUEUE_IDLE");
      return;
    }
  }
  process.env.NODE_ENV = "production";
  process.env.ORDER_PDF_CHROMIUM_EXECUTABLE_PATH = browserExecutable;
  process.env.ORDER_PDF_RENDER_URL = `http://127.0.0.1:${port}/final`;

  let server = null;
  let result = null;
  try {
    logCode("APP_SERVER_START");
    server = await startAppServer(port);
    logCode("APP_SERVER_READY");
    if (queueMode) {
      await runQueueOnce(`http://127.0.0.1:${port}`, fontBytes, queueAdapter, claimedQueueJob);
    } else {
      result = await renderPdfRendererJob(
        job,
        fontBytes,
        (stage) => logCode(stage),
        (diagnosticCode) => logCode(diagnosticCode),
      );
      if (selfTest && result.rubyCount <= 0) throw new Error("self_test_ruby_missing");
      const saved = await saveAssets(result);
      logCode("WORKER_JOB_SUCCEEDED", `pages=${result.bodyPdfPageCount} ruby=${result.rubyCount} pdf_bytes=${result.bodyPdfBytes.byteLength} cover_bytes=${result.coverPngBytes.byteLength} cover_px=${result.coverWidth}x${result.coverHeight}`);
      console.log(`Output directory: ${path.relative(ROOT, saved.directory)}`);
      console.log(`Body PDF: ${path.relative(ROOT, saved.pdfPath)}`);
      console.log(`Spread cover PNG: ${path.relative(ROOT, saved.pngPath)}`);
    }
  } catch {
    if (!queueMode || !claimedQueueJob) throw new Error("worker_render_failed");
    try {
      const recorded = await queueAdapter.fail(
        claimedQueueJob.orderId,
        claimedQueueJob.leaseId,
        "worker_unavailable",
      );
      logCode(recorded ? "PDF_QUEUE_FAILURE_RECORDED" : "PDF_QUEUE_LEASE_LOST");
    } catch {
      // Leave an unconfirmed lease authoritative; it can be reclaimed after expiry.
      logCode("PDF_QUEUE_FAILURE_RECORDING_PENDING");
    }
    process.exitCode = 1;
  } finally {
    if (server) {
      const stopped = await stopChild(server.child);
      await rm(server.runtimeDirectory, { recursive: true, force: true });
      if (!stopped) {
        logCode("APP_SERVER_STOP_UNCONFIRMED");
        process.exitCode = 1;
      } else {
        logCode("APP_SERVER_STOPPED");
      }
    }
  }
}

main().catch((error) => {
  const known = new Set([
    "job_input_too_large", "job_input_missing", "job_input_invalid", "job_input_refused",
    "pinned_chromium_missing", "pinned_chromium_path_mismatch", "browser_mode_invalid",
    "local_chromium_missing", "renderer_port_invalid", "renderer_port_in_use", "renderer_port_probe_failed",
    "app_runtime_prepare_failed", "app_runtime_directory_create_failed", "app_runtime_copy_next_build_failed",
    "app_runtime_copy_public_failed", "app_runtime_copy_package_json_failed",
    "app_runtime_copy_next_config_ts_failed", "app_server_spawn_failed", "app_server_exited", "app_server_start_timeout",
    "cover_download_failed", "cover_too_large", "cover_spine_text_does_not_fit", "self_test_ruby_missing",
    "cover_navigation_failed", "pinned_font_invalid", "production_build_missing", "self_test_fixture_invalid",
    "queue_worker_not_enabled",
  ]);
  const code = error instanceof Error && known.has(error.message) ? error.message.toUpperCase() : "WORKER_RENDER_FAILED";
  logCode(code);
  process.exitCode = 1;
});
