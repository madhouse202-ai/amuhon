import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAozoraRightsReviewPackage,
  classifyAozoraCatalog,
  classifyAozoraRightsWork,
  isAozoraRightsBatchCandidate,
  calculateAozoraRightsPolicySha256,
  createAozoraRightsBatchApprovalTemplate,
  createAozoraRightsBatchReviewPackage,
} from "../lib/aozora-rights-review.ts";
import { resolveAozoraRightsCatalog, resolveAozoraWorkEditions } from "../lib/aozora-edition.ts";

const CATALOG_URL = "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip";
const REGRESSION_IDS = ["000042", "000799", "001927"];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = path.resolve(ROOT, ".local-assets", "rights-review");
const POLICY_PATH = path.join(ROOT, "data", "aozora-rights-policy-v1.json");

function usage() {
  console.log("Usage: node --experimental-strip-types scripts/prepare-aozora-rights-review.mjs [--limit 50] [--out .local-assets/rights-review/RUN_ID]");
}

function parseArgs(args) {
  const result = { limit: 50, out: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--help") return { ...result, help: true };
    if (args[index] === "--limit") result.limit = Number(args[++index]);
    else if (args[index] === "--out") result.out = args[++index];
    else throw new Error("argument_invalid");
  }
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 50) throw new Error("limit_invalid");
  const directory = path.resolve(OUTPUT_ROOT, result.out ?? new Date().toISOString().replace(/[:.]/g, "-"));
  if (directory !== OUTPUT_ROOT && !directory.startsWith(`${OUTPUT_ROOT}${path.sep}`)) throw new Error("output_path_invalid");
  result.directory = directory;
  return result;
}

function compareIds(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : left.localeCompare(right);
}

function csvCell(value) {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

async function ensureSafeOutputDirectory(directory) {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const realRoot = await realpath(OUTPUT_ROOT);
  const relative = path.relative(OUTPUT_ROOT, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("review_path_outside_local_output");
  let cursor = OUTPUT_ROOT;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error("review_symlink_rejected");
      if (!stat.isDirectory()) throw new Error("review_output_not_directory");
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
      await mkdir(cursor);
    }
    const realCursor = await realpath(cursor);
    if (realCursor === realRoot || !realCursor.startsWith(`${realRoot}${path.sep}`)) throw new Error("review_path_outside_local_output");
  }
}

function safeErrorCode(error) {
  const known = new Set([
    "catalog_fetch_failed", "catalog_redirect_rejected", "catalog_csv_missing", "catalog_too_large",
    "catalog_header_missing", "catalog_required_column_missing", "catalog_csv_unterminated_quote",
    "catalog_work_missing", "catalog_work_invalid", "edition_fetch_failed", "edition_redirect_rejected",
    "edition_body_missing", "source_too_large", "source_body_missing", "work_ids_invalid",
    "review_path_outside_local_output", "review_symlink_rejected", "review_output_not_directory",
  ]);
  return error instanceof Error && known.has(error.message) ? error.message : "upstream_or_catalog_error";
}

async function pause(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();

  const [snapshot, policy] = await Promise.all([
    resolveAozoraRightsCatalog(),
    readFile(POLICY_PATH, "utf8").then((value) => JSON.parse(value)),
  ]);
  const candidates = snapshot.works.filter(isAozoraRightsBatchCandidate).sort((a, b) => compareIds(a.id, b.id));
  const candidateById = new Map(candidates.map((work) => [work.id, work]));
  const selectedIds = [];
  for (const id of REGRESSION_IDS) if (candidateById.has(id) && selectedIds.length < options.limit) selectedIds.push(id);
  for (const candidate of candidates) {
    if (selectedIds.length >= options.limit) break;
    if (!selectedIds.includes(candidate.id)) selectedIds.push(candidate.id);
  }

  const editionsById = new Map();
  const editionFailures = new Map();
  for (let index = 0; index < selectedIds.length; index += 1) {
    const id = selectedIds[index];
    try {
      const [edition] = await resolveAozoraWorkEditions([id]);
      editionsById.set(id, edition);
    } catch (error) {
      editionFailures.set(id, safeErrorCode(error));
    }
    if (index < selectedIds.length - 1) await pause(250);
  }

  const reviewPackage = createAozoraRightsReviewPackage({
    catalogUrl: CATALOG_URL,
    fetchedAt: snapshot.fetchedAt,
    catalogSha256: snapshot.sha256,
    catalogWorks: snapshot.works,
    selectionLimit: options.limit,
    selectedIds,
    editionsById,
  });
  const failedPackageWorks = reviewPackage.works.map((work) => editionFailures.has(work.workId)
    ? { ...work, editionFailureCode: editionFailures.get(work.workId) }
    : work);
  const packageForOutput = { ...reviewPackage, works: failedPackageWorks };
  // Re-sign after attaching bounded failure codes to the report package.
  const unsigned = { ...packageForOutput };
  delete unsigned.packageSha256;
  const { createHash } = await import("node:crypto");
  packageForOutput.packageSha256 = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  const batchPackage = createAozoraRightsBatchReviewPackage(packageForOutput, policy);
  const batchApprovalTemplate = createAozoraRightsBatchApprovalTemplate(batchPackage);

  const allRows = [[
    "カタログ取得日時", "カタログCSV SHA-256", "作品ID", "作品名", "読み", "著者表示", "CSV段階分類（版未取得）", "分類理由", "作品著作権フラグ", "人物著作権フラグ",
    "関係者・役割・人物フラグ",
    "図書カードURL", "テキスト配布URL", "XHTML URL", "底本", "底本出版社", "初出", "入力者", "校正者", "CSV行数", "人手確認項目",
  ]];
  for (const work of snapshot.works) {
    const screening = classifyAozoraRightsWork(work);
    allRows.push([
      snapshot.fetchedAt, snapshot.sha256, work.id, work.title, work.titleReading || work.sortReading, work.author, screening.classification,
      screening.reasons.join("; "), work.workCopyrightFlags, work.catalogPersonCopyrightFlags,
      work.contributors.map(({ name, role, personIds, copyrightFlags }) => ({ name, role, personIds, copyrightFlags })),
      work.cardUrl, work.textUrl, work.xhtmlUrl, work.sourceMetadata.baseText, work.sourceMetadata.basePublisher,
      work.sourceMetadata.firstPublication, work.sourceMetadata.inputter, work.sourceMetadata.proofreader,
      String(work.catalogRowCount), screening.manualChecks.join("; "),
    ]);
  }
  const selectedRows = [[
    "カタログ取得日時", "カタログCSV SHA-256", "対象セットSHA-256", "審査パッケージSHA-256", "作品ID", "作品名", "著者・関係者", "機械分類",
    "分類理由", "作品フラグ", "人物フラグ", "図書カードURL", "テキストURL", "XHTML URL", "本文実バイトSHA-256",
    "底本", "底本出版社", "初出", "入力者", "校正者", "版検証", "人間が確認すること",
  ]];
  for (const work of packageForOutput.works) selectedRows.push([
    snapshot.fetchedAt, snapshot.sha256, reviewPackage.selection.sha256, packageForOutput.packageSha256,
    work.workId, work.title, work.contributors.map(({ name, role }) => `${name}（${role}）`).join("; "), work.classification,
    work.reasons.join("; "), work.workCopyrightFlags, work.catalogPersonCopyrightFlags,
    work.cardUrl, work.textUrl, work.xhtmlUrl, work.sourceSha256 ?? "", work.sourceMetadata.baseText,
    work.sourceMetadata.basePublisher, work.sourceMetadata.firstPublication, work.sourceMetadata.inputter,
    work.sourceMetadata.proofreader, work.editionVerified ? "verified" : `failed:${editionFailures.get(work.workId) ?? "not_attempted"}`,
    work.manualChecks.join("; "),
  ]);
  const report = {
    generatedAt: new Date().toISOString(),
    source: { url: CATALOG_URL, catalogFetchedAt: snapshot.fetchedAt, catalogCsvSha256: snapshot.sha256 },
    catalogWorkCount: snapshot.works.length,
    metadataScreeningCounts: classifyAozoraCatalog(snapshot.works),
    approvedCount: 0,
    note: "metadataScreeningCountsはCSV全件の機械的な一次分類（本文版未取得）。candidate_pending_human_reviewは短縮候補のみ。全ての販売・注文状態はB扱いで、原作性・法的保護期間・利用条件の人手確認と明示承認なしにA登録できません。CSV全件のXHTMLは取得していません。",
    selection: { limit: options.limit, ids: selectedIds, selectionSha256: reviewPackage.selection.sha256 },
    editionHashVerifiedCount: editionsById.size,
    editionFailureCount: editionFailures.size,
    editionFailureCodes: Object.fromEntries(editionFailures),
    packageSha256: packageForOutput.packageSha256,
    batchPackageSha256: batchPackage.packageSha256,
    policySha256: calculateAozoraRightsPolicySha256(policy),
    batchScreening: batchPackage.screening,
  };
  const batchRows = [[
    "基準ID", "基準バージョン", "基準SHA-256", "審査パッケージSHA-256", "対象セットSHA-256", "作品ID", "作品名", "関係者・役割",
    "分類", "理由", "作品フラグ", "人物フラグ", "図書カードURL", "本文XHTML URL", "本文SHA-256", "底本", "初出",
  ]];
  for (const work of batchPackage.works) {
    const source = work.reviewWork;
    batchRows.push([
      policy.policyId, policy.version, batchPackage.policy.sha256, batchPackage.packageSha256, batchPackage.selection.sha256,
      source.workId, source.title, source.contributors.map(({ name, role }) => `${name}（${role}）`).join("; "), work.category,
      work.reasons.join("; "), source.workCopyrightFlags, source.catalogPersonCopyrightFlags, source.cardUrl,
      source.xhtmlUrl, source.sourceSha256 ?? "", source.sourceMetadata.baseText, source.sourceMetadata.firstPublication,
    ]);
  }
  const batchSummary = {
    schema: "amuhon-aozora-rights-batch-summary/v1",
    policy: {
      id: policy.policyId,
      version: policy.version,
      sha256: calculateAozoraRightsPolicySha256(policy),
      status: policy.status,
      legalReviewStatus: policy.legalReviewStatus,
      aRegistrationAllowed: batchPackage.screening.aRegistrationAllowed,
    },
    sourceReviewPackageSha256: packageForOutput.packageSha256,
    batchPackageSha256: batchPackage.packageSha256,
    candidateSetSha256: batchPackage.selection.sha256,
    screening: batchPackage.screening,
    note: "bulk_candidateは公式CSV等の機械スクリーニング候補。法務確認・基準承認・対象一覧への人間の明示承認が終わるまでAではなく、SQL生成もできません。",
  };
  await ensureSafeOutputDirectory(options.directory);
  await Promise.all([
    writeFile(path.join(options.directory, "catalog-classification.csv"), toCsv(allRows), { encoding: "utf8", flag: "wx" }),
    writeFile(path.join(options.directory, "review-50.csv"), toCsv(selectedRows), { encoding: "utf8", flag: "wx" }),
    writeFile(path.join(options.directory, "review-package.json"), `${JSON.stringify(packageForOutput, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
    writeFile(path.join(options.directory, "batch-review.json"), `${JSON.stringify(batchPackage, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
    writeFile(path.join(options.directory, "batch-review.csv"), toCsv(batchRows), { encoding: "utf8", flag: "wx" }),
    writeFile(path.join(options.directory, "batch-approval-template.json"), `${JSON.stringify(batchApprovalTemplate, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
    writeFile(path.join(options.directory, "batch-summary.json"), `${JSON.stringify(batchSummary, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
    writeFile(path.join(options.directory, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
  ]);
  console.log(`Catalog works: ${snapshot.works.length}`);
  console.log(`Metadata screening: ${JSON.stringify(report.metadataScreeningCounts)}`);
  console.log(`Review sample: ${selectedIds.length}; XHTML verified: ${editionsById.size}; XHTML failures: ${editionFailures.size}`);
  console.log(`Catalog CSV SHA-256: ${snapshot.sha256}`);
  console.log(`Review package SHA-256: ${packageForOutput.packageSha256}`);
  console.log(`Batch policy SHA-256: ${batchSummary.policy.sha256}`);
  console.log(`Batch screening: ${JSON.stringify(batchPackage.screening)}`);
  console.log(`Output directory: ${options.directory}`);
  console.log("No legacy per-work approval template was generated.");
  console.log("No database or Storage connection was made. No rights status was approved.");
}

main().catch((error) => {
  console.error(`FAIL ${safeErrorCode(error)}`);
  process.exitCode = 1;
});
