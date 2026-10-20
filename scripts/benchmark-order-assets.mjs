#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_ORDER_ASSET_BYTES } from "../lib/order-assets.ts";

const CLI = fileURLToPath(new URL("./validate-order-assets.mjs", import.meta.url));
const HIGH_MEMORY_BYTES = 20_000_000;
const NEAR_LIMIT_BYTES = 30_000_000;

function flags(args) {
  const positional = [];
  const accepted = new Set(["--allow-large", "--allow-high-memory", "--allow-near-limit", "--expect-invalid"]);
  const supplied = new Set();
  for (const arg of args) {
    if (accepted.has(arg)) supplied.add(arg);
    else if (arg.startsWith("--")) throw new Error(`不明な引数です: ${arg}`);
    else positional.push(arg);
  }
  return { positional, supplied };
}

async function main() {
  try {
    const { positional: directories, supplied } = flags(process.argv.slice(2));
    if (!directories.length) throw new Error("使用法: node --experimental-strip-types scripts/benchmark-order-assets.mjs <case-dir> [case-dir ...]");
    const cases = [];
    for (const inputDirectory of directories) {
      const directory = resolve(inputDirectory);
      const pdf = join(directory, "body.pdf");
      const png = join(directory, "cover.png");
      const [pdfStat, pngStat] = await Promise.all([stat(pdf), stat(png)]);
      if (!pdfStat.isFile() || !pngStat.isFile()) throw new Error("各ケースのディレクトリにbody.pdfとcover.pngが必要です。");
      const maxBytes = Math.max(pdfStat.size, pngStat.size);
      if (maxBytes > MAX_ORDER_ASSET_BYTES) throw new Error("40,000,000バイトを超えるファイルがあり、検証器の上限外です。");
      if (maxBytes > 10_000_000 && !supplied.has("--allow-large")) throw new Error("10MBを超える測定には --allow-large が必要です。");
      if (maxBytes > HIGH_MEMORY_BYTES && !supplied.has("--allow-high-memory")) throw new Error("20MBを超える測定はメモリ負荷があります。事前確認後に --allow-high-memory を付けてください。");
      if (maxBytes > NEAR_LIMIT_BYTES && !supplied.has("--allow-near-limit")) throw new Error("30MBを超える測定は40MB上限付近の高負荷です。事前確認後に --allow-near-limit を付けてください。");
      cases.push({ directory, pdf, png, pdfBytes: pdfStat.size, pngBytes: pngStat.size });
    }

    const rows = [];
    const expectInvalid = supplied.has("--expect-invalid");
    for (const item of cases) {
      const child = spawnSync(process.execPath, ["--experimental-strip-types", CLI, item.pdf, item.png], {
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 256 * 1024,
      });
      let report;
      try { report = JSON.parse(child.stdout); } catch { report = null; }
      rows.push({
        pdfBytes: item.pdfBytes,
        pngBytes: item.pngBytes,
        status: report?.status ?? "process_error",
        expectation: expectInvalid ? "invalid" : "valid",
        pageCount: report?.bodyPdf?.pageCount ?? null,
        elapsedMs: report?.metrics?.elapsedMs ?? null,
        userCpuMs: report?.metrics?.userCpuMs ?? null,
        systemCpuMs: report?.metrics?.systemCpuMs ?? null,
        processPeakRssBytes: report?.metrics?.processPeakRssBytes ?? null,
        exitCode: child.status,
        error: report?.bodyPdf?.error ?? report?.coverPng?.error ?? (child.error?.code === "ETIMEDOUT" ? "120秒で中断" : undefined),
      });
      if (child.error?.code === "ETIMEDOUT") break;
    }
    const expectationsMet = rows.every((row) => expectInvalid ? row.status === "invalid" : row.status === "valid");
    process.stdout.write(`${JSON.stringify({ status: expectationsMet ? "complete" : "incomplete", rows, note: "各行は独立Nodeプロセス。RSSはOS報告のピーク値で、マシン・OS依存です。" }, null, 2)}\n`);
    if (!expectationsMet) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "測定を開始できません。"}\n`);
    process.exitCode = 2;
  }
}

main();
