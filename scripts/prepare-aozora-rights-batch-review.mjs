import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  calculateAozoraRightsPolicySha256,
  createAozoraRightsBatchApprovalTemplate,
  createAozoraRightsBatchReviewPackage,
} from "../lib/aozora-rights-review.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = path.resolve(ROOT, ".local-assets", "rights-review");
const POLICY_PATH = path.join(ROOT, "data", "aozora-rights-policy-v1.json");
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

function parseArgs(args) {
  const result = { packagePath: null, out: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--help") return { ...result, help: true };
    if (args[index] === "--package") result.packagePath = args[++index];
    else if (args[index] === "--out") result.out = args[++index];
    else throw new Error("argument_invalid");
  }
  if (result.help) return result;
  if (!result.packagePath || !result.out) throw new Error("required_argument_missing");
  result.packagePath = path.resolve(ROOT, result.packagePath);
  result.out = path.resolve(ROOT, result.out);
  if (result.packagePath === OUTPUT_ROOT || result.out === OUTPUT_ROOT ||
      !result.packagePath.startsWith(`${OUTPUT_ROOT}${path.sep}`) || !result.out.startsWith(`${OUTPUT_ROOT}${path.sep}`)) {
    throw new Error("review_path_outside_local_output");
  }
  return result;
}

async function readJsonBounded(filename) {
  if ((await lstat(filename)).isSymbolicLink()) throw new Error("review_symlink_rejected");
  const realRoot = await realpath(OUTPUT_ROOT);
  const realFile = await realpath(filename);
  if (!realFile.startsWith(`${realRoot}${path.sep}`)) throw new Error("review_path_outside_local_output");
  const bytes = await readFile(filename);
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error("review_input_too_large");
  return JSON.parse(bytes.toString("utf8"));
}

function csvCell(value) {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function safeErrorCode(error) {
  const known = new Set([
    "argument_invalid", "required_argument_missing", "review_path_outside_local_output", "review_symlink_rejected",
    "review_input_too_large", "rights_batch_input_invalid", "review_schema_invalid",
  ]);
  return error instanceof Error && known.has(error.message) ? error.message : "review_package_invalid";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run rights:aozora:batch -- --package .local-assets/rights-review/RUN/review-package.json --out .local-assets/rights-review/RUN");
    return;
  }
  const [sourcePackage, policy] = await Promise.all([
    readJsonBounded(options.packagePath),
    readFile(POLICY_PATH, "utf8").then((value) => JSON.parse(value)),
  ]);
  if (sourcePackage?.schema !== "amuhon-aozora-rights-review/v1" || policy?.schema !== "amuhon-aozora-rights-policy/v1") {
    throw new Error("review_schema_invalid");
  }
  const batchPackage = createAozoraRightsBatchReviewPackage(sourcePackage, policy);
  const approvalTemplate = createAozoraRightsBatchApprovalTemplate(batchPackage);
  const rows = [[
    "基準ID", "基準バージョン", "基準SHA-256", "審査パッケージSHA-256", "対象セットSHA-256", "作品ID", "作品名", "関係者・役割",
    "分類", "理由", "作品フラグ", "人物フラグ", "図書カードURL", "本文XHTML URL", "本文SHA-256", "底本", "初出",
  ]];
  for (const work of batchPackage.works) {
    const source = work.reviewWork;
    rows.push([
      policy.policyId, policy.version, batchPackage.policy.sha256, batchPackage.packageSha256, batchPackage.selection.sha256,
      source.workId, source.title, source.contributors.map(({ name, role }) => `${name}（${role}）`).join("; "), work.category,
      work.reasons.join("; "), source.workCopyrightFlags, source.catalogPersonCopyrightFlags, source.cardUrl,
      source.xhtmlUrl, source.sourceSha256 ?? "", source.sourceMetadata.baseText, source.sourceMetadata.firstPublication,
    ]);
  }
  const summary = {
    schema: "amuhon-aozora-rights-batch-summary/v1",
    policy: {
      id: policy.policyId,
      version: policy.version,
      sha256: calculateAozoraRightsPolicySha256(policy),
      status: policy.status,
      legalReviewStatus: policy.legalReviewStatus,
      aRegistrationAllowed: batchPackage.screening.aRegistrationAllowed,
    },
    sourceReviewPackageSha256: sourcePackage.packageSha256,
    batchPackageSha256: batchPackage.packageSha256,
    candidateSetSha256: batchPackage.selection.sha256,
    screening: batchPackage.screening,
    note: "bulk_candidateは公式CSV等の機械スクリーニング候補。法務・基準承認・対象一覧への人間の明示承認が終わるまでAではなく、SQL生成もできません。",
  };

  const realRoot = await realpath(OUTPUT_ROOT);
  const realParent = await realpath(path.dirname(options.out));
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) throw new Error("review_path_outside_local_output");
  await mkdir(options.out, { recursive: true });
  if ((await lstat(options.out)).isSymbolicLink()) throw new Error("review_symlink_rejected");
  const realOutput = await realpath(options.out);
  if (realOutput !== realRoot && !realOutput.startsWith(`${realRoot}${path.sep}`)) throw new Error("review_path_outside_local_output");
  const files = [
    ["batch-review.json", `${JSON.stringify(batchPackage, null, 2)}\n`],
    ["batch-review.csv", toCsv(rows)],
    ["batch-approval-template.json", `${JSON.stringify(approvalTemplate, null, 2)}\n`],
    ["batch-summary.json", `${JSON.stringify(summary, null, 2)}\n`],
  ];
  for (const [name, contents] of files) {
    await writeFile(path.join(options.out, name), contents, { encoding: "utf8", flag: "wx" });
  }
  console.log(`Policy: ${policy.policyId} v${policy.version} (${policy.status}; legal=${policy.legalReviewStatus})`);
  console.log(`Policy SHA-256: ${summary.policy.sha256}`);
  console.log(`Batch screening: ${JSON.stringify(summary.screening)}`);
  console.log(`Batch files: ${options.out}`);
  console.log("No human approval was recorded. No A registration SQL was generated.");
}

main().catch((error) => {
  console.error(`FAIL ${safeErrorCode(error)}`);
  process.exitCode = 1;
});
