#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { validateBodyPdf, validateCoverPng, MAX_ORDER_ASSET_BYTES } from "../lib/order-assets.ts";

function peakRssBytes() {
  const maxRss = process.resourceUsage().maxRSS;
  // Node reports maxRSS in KiB on Windows and Linux, and bytes on macOS.
  return process.platform === "darwin" ? maxRss : maxRss * 1024;
}

async function readLocalAsset(path, label, onSize) {
  const fileInfo = await stat(path);
  if (!fileInfo.isFile()) throw new Error(`${label}: 通常ファイルを指定してください。`);
  onSize(fileInfo.size);
  if (fileInfo.size > MAX_ORDER_ASSET_BYTES) {
    throw new Error(`${label}: 40,000,000バイト（40MB）の上限を超えています。`);
  }
  return new Uint8Array(await readFile(path));
}

function emit(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const [, , pdfPath, pngPath, ...extra] = process.argv;
  if (!pdfPath || !pngPath || extra.length) {
    emit({
      status: "usage",
      usage: "node --experimental-strip-types scripts/validate-order-assets.mjs <body.pdf> <cover.png>",
    });
    process.exitCode = 2;
    return;
  }

  const startedAt = performance.now();
  const beforeRssBytes = peakRssBytes();
  const startedUsage = process.resourceUsage();
  let bodyResult;
  let bodyFileBytes = 0;
  let coverResult;
  let coverFileBytes = 0;
  let bodyError;
  let coverError;

  try {
    const bytes = await readLocalAsset(pdfPath, "本文PDF", (size) => { bodyFileBytes = size; });
    bodyFileBytes = bytes.byteLength;
    bodyResult = await validateBodyPdf(bytes);
  } catch (error) {
    bodyError = error instanceof Error ? error.message : "本文PDFの検証に失敗しました。";
  }

  if (bodyResult) {
    try {
      const bytes = await readLocalAsset(pngPath, "カバーPNG", (size) => { coverFileBytes = size; });
      coverFileBytes = bytes.byteLength;
      coverResult = await validateCoverPng(bytes, bodyResult.pageCount);
    } catch (error) {
      coverError = error instanceof Error ? error.message : "カバーPNGの検証に失敗しました。";
    }
  } else {
    coverError = "本文PDFの検証に失敗したため、本文ページ数との照合を行っていません。";
  }

  const success = Boolean(bodyResult && coverResult);
  const completedUsage = process.resourceUsage();
  emit({
    status: success ? "valid" : "invalid",
    bodyPdf: bodyResult
      ? { status: "valid", bytes: bodyFileBytes, pageCount: bodyResult.pageCount }
      : { status: "invalid", bytes: bodyFileBytes, error: bodyError },
    coverPng: coverResult
      ? { status: "valid", bytes: coverFileBytes, width: coverResult.width, height: coverResult.height }
      : { status: bodyResult ? "invalid" : "not_checked", bytes: coverFileBytes, error: coverError },
    metrics: {
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      userCpuMs: Number(((completedUsage.userCPUTime - startedUsage.userCPUTime) / 1000).toFixed(1)),
      systemCpuMs: Number(((completedUsage.systemCPUTime - startedUsage.systemCPUTime) / 1000).toFixed(1)),
      processPeakRssBytes: Math.max(beforeRssBytes, peakRssBytes()),
      note: "プロセス全体のOS報告ピークRSS。単発ローカル測定値であり、デプロイ環境の上限値ではありません。",
    },
  });
  if (!success) process.exitCode = 1;
}

main().catch(() => {
  emit({ status: "error", error: "ローカルファイルの読み込みまたは検証を開始できませんでした。" });
  process.exitCode = 1;
});
