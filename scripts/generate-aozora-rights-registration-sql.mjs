import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyAozoraRightsWork, generateAozoraRightsRegistrationSql } from "../lib/aozora-rights-review.ts";
import { resolveAozoraRightsCatalog, resolveAozoraWorkEditions } from "../lib/aozora-edition.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = path.resolve(ROOT, ".local-assets", "rights-review");
const MAX_INPUT_BYTES = 4 * 1024 * 1024;

function parseArgs(args) {
  const result = { packagePath: null, approvalPath: null, out: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--help") return { ...result, help: true };
    if (args[index] === "--package") result.packagePath = args[++index];
    else if (args[index] === "--approval") result.approvalPath = args[++index];
    else if (args[index] === "--out") result.out = args[++index];
    else throw new Error("argument_invalid");
  }
  if (result.help) return result;
  if (!result.packagePath || !result.approvalPath || !result.out) throw new Error("required_argument_missing");
  for (const key of ["packagePath", "approvalPath", "out"]) {
    result[key] = path.resolve(ROOT, result[key]);
  }
  if (!result.out.startsWith(`${OUTPUT_ROOT}${path.sep}`) ||
      !result.packagePath.startsWith(`${OUTPUT_ROOT}${path.sep}`) ||
      !result.approvalPath.startsWith(`${OUTPUT_ROOT}${path.sep}`)) throw new Error("review_path_outside_local_output");
  return result;
}

async function readJsonBounded(filename) {
  const bytes = await readFile(filename);
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error("review_input_too_large");
  return JSON.parse(bytes.toString("utf8"));
}

function safeErrorCode(error) {
  const known = new Set([
    "catalog_fetch_failed", "catalog_redirect_rejected", "catalog_csv_missing", "catalog_too_large",
    "catalog_header_missing", "catalog_required_column_missing", "catalog_csv_unterminated_quote",
    "catalog_work_missing", "catalog_work_invalid", "edition_fetch_failed", "edition_redirect_rejected",
    "edition_body_missing", "source_too_large", "source_body_missing", "work_ids_invalid",
  ]);
  return error instanceof Error && known.has(error.message) ? error.message : "review_or_upstream_error";
}

function catalogSignature(work) {
  return JSON.stringify({
    id: work.id,
    title: work.title,
    author: work.author,
    cardUrl: work.cardUrl,
    textUrl: work.textUrl,
    xhtmlUrl: work.xhtmlUrl,
    titleReading: work.titleReading,
    sortReading: work.sortReading,
    contributors: work.contributors,
    sourceMetadata: work.sourceMetadata,
    workCopyrightFlags: work.workCopyrightFlags,
    missingWorkCopyrightFlagRows: work.missingWorkCopyrightFlagRows,
    catalogPersonCopyrightFlags: work.catalogPersonCopyrightFlags,
    missingPersonCopyrightFlagRows: work.missingPersonCopyrightFlagRows,
    incompleteContributorRows: work.incompleteContributorRows,
    sourceMetadataConflicts: work.sourceMetadataConflicts,
    catalogIssues: work.catalogIssues,
    catalogRowCount: work.catalogRowCount,
  });
}

function packageCatalogSignature(work) {
  return JSON.stringify({
    id: work.workId,
    title: work.title,
    author: work.author,
    cardUrl: work.cardUrl,
    textUrl: work.textUrl,
    xhtmlUrl: work.xhtmlUrl,
    titleReading: work.titleReading,
    sortReading: work.sortReading,
    contributors: work.contributors,
    sourceMetadata: work.sourceMetadata,
    workCopyrightFlags: work.workCopyrightFlags,
    missingWorkCopyrightFlagRows: work.missingWorkCopyrightFlagRows,
    catalogPersonCopyrightFlags: work.catalogPersonCopyrightFlags,
    missingPersonCopyrightFlagRows: work.missingPersonCopyrightFlagRows,
    incompleteContributorRows: work.incompleteContributorRows,
    sourceMetadataConflicts: work.sourceMetadataConflicts,
    catalogIssues: work.catalogIssues,
    catalogRowCount: work.catalogRowCount,
  });
}

async function pause(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node --experimental-strip-types scripts/generate-aozora-rights-registration-sql.mjs --package .local-assets/rights-review/RUN/review-package.json --approval .local-assets/rights-review/RUN/approval-confirmed.json --out .local-assets/rights-review/RUN/register-approved-a.sql");
    return;
  }
  const [reviewPackage, approval] = await Promise.all([
    readJsonBounded(options.packagePath), readJsonBounded(options.approvalPath),
  ]);
  if (!reviewPackage || reviewPackage.schema !== "amuhon-aozora-rights-review/v1" ||
      !Array.isArray(reviewPackage.works) || !reviewPackage.catalog?.sha256 ||
      !approval || approval.schema !== "amuhon-aozora-rights-approval/v1" ||
      !Array.isArray(approval.works) || approval.works.length < 1 || approval.works.length > 50) {
    throw new Error("review_schema_invalid");
  }

  // Re-download the catalog and the exact approved XHTML editions. No database credentials are read.
  const current = await resolveAozoraRightsCatalog();
  if (current.sha256 !== reviewPackage.catalog.sha256) throw new Error("catalog_snapshot_changed");
  const currentById = new Map(current.works.map((work) => [work.id, work]));
  const packageById = new Map(reviewPackage.works.map((work) => [work.workId, work]));
  for (let index = 0; index < approval.works.length; index += 1) {
    const approvalWork = approval.works[index];
    const recorded = packageById.get(approvalWork.workId);
    const currentWork = currentById.get(approvalWork.workId);
    if (!recorded || recorded.classification !== "candidate_pending_human_review" || !recorded.editionVerified ||
        !currentWork || classifyAozoraRightsWork(currentWork).classification !== "candidate_pending_human_review" ||
        catalogSignature(currentWork) !== packageCatalogSignature(recorded)) throw new Error("catalog_record_changed");
    const [edition] = await resolveAozoraWorkEditions([approvalWork.workId]);
    if (edition.sourceSha256 !== recorded.sourceSha256 || approvalWork.sourceSha256 !== recorded.sourceSha256 ||
        catalogSignature(edition) !== catalogSignature(currentWork)) throw new Error("xhtml_edition_changed");
    if (index < approval.works.length - 1) await pause(250);
  }

  const sql = generateAozoraRightsRegistrationSql(reviewPackage, approval);
  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, sql, { encoding: "utf8", flag: "wx" });
  console.log(`PASS approved records: ${approval.works.length}`);
  console.log(`PASS current official catalog and XHTML hashes: ${approval.works.length}`);
  console.log(`SQL draft: ${options.out}`);
  console.log("No database or Storage connection was made. The SQL was not executed.");
}

main().catch((error) => {
  console.error(`FAIL ${safeErrorCode(error)}`);
  process.exitCode = 1;
});
