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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_INPUT_BYTES = 9_000_000;
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

async function main() {
  const selfTest = process.argv.length === 3 && process.argv[2] === "--self-test";
  if (!selfTest && (process.argv.length !== 2 || process.stdin.isTTY)) {
    throw new Error("provide a bounded JSON job on stdin or use --self-test");
  }
  if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) throw new Error("production_build_missing");
  const job = selfTest ? createSelfTestJob() : await readInput();
  if (!job) throw new Error("self_test_fixture_invalid");

  const port = getPort();
  const browserExecutable = await chooseBrowserExecutable();
  const fontBytes = await loadPinnedFont();
  process.env.NODE_ENV = "production";
  process.env.ORDER_PDF_CHROMIUM_EXECUTABLE_PATH = browserExecutable;
  process.env.ORDER_PDF_RENDER_URL = `http://127.0.0.1:${port}/final`;

  let server = null;
  let result = null;
  try {
    logCode("APP_SERVER_START");
    server = await startAppServer(port);
    logCode("APP_SERVER_READY");
    result = await renderPdfRendererJob(
      job,
      fontBytes,
      (stage) => logCode(stage),
      (diagnosticCode) => logCode(diagnosticCode),
    );
    const saved = await saveAssets(result);
    logCode("WORKER_JOB_SUCCEEDED", `pages=${result.bodyPdfPageCount} ruby=${result.rubyCount} pdf_bytes=${result.bodyPdfBytes.byteLength} cover_bytes=${result.coverPngBytes.byteLength} cover_px=${result.coverWidth}x${result.coverHeight}`);
    console.log(`Output directory: ${path.relative(ROOT, saved.directory)}`);
    console.log(`Body PDF: ${path.relative(ROOT, saved.pdfPath)}`);
    console.log(`Spread cover PNG: ${path.relative(ROOT, saved.pngPath)}`);
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
    "cover_download_failed", "cover_too_large", "cover_spine_text_does_not_fit",
    "cover_navigation_failed", "pinned_font_invalid", "production_build_missing", "self_test_fixture_invalid",
  ]);
  const code = error instanceof Error && known.has(error.message) ? error.message.toUpperCase() : "WORKER_RENDER_FAILED";
  logCode(code);
  process.exitCode = 1;
});
