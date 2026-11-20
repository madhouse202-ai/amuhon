import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertAozoraRightsBatchWorkUnchanged,
  classifyAozoraRightsWork,
  generateAozoraRightsBatchRegistrationSql,
  validateAozoraRightsBatchApproval,
} from "../lib/aozora-rights-review.ts";
import { resolveAozoraRightsCatalog, resolveAozoraWorkEditions } from "../lib/aozora-edition.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = path.resolve(ROOT, ".local-assets", "rights-review");
const POLICY_PATH = path.join(ROOT, "data", "aozora-rights-policy-v1.json");
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

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
  for (const key of ["packagePath", "approvalPath", "out"]) result[key] = path.resolve(ROOT, result[key]);
  if ([result.packagePath, result.approvalPath, result.out].some((filename) =>
    filename === OUTPUT_ROOT || !filename.startsWith(`${OUTPUT_ROOT}${path.sep}`))) {
    throw new Error("review_path_outside_local_output");
  }
  return result;
}

async function ensureLocalPath(filename, { fileMustExist = false } = {}) {
  const realRoot = await realpath(OUTPUT_ROOT);
  const existing = fileMustExist ? await realpath(filename) : await realpath(path.dirname(filename));
  if (existing !== realRoot && !existing.startsWith(`${realRoot}${path.sep}`)) throw new Error("review_path_outside_local_output");
  if (fileMustExist && (await lstat(filename)).isSymbolicLink()) throw new Error("review_symlink_rejected");
}

async function readJsonBounded(filename) {
  await ensureLocalPath(filename, { fileMustExist: true });
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
    "review_path_outside_local_output", "review_symlink_rejected", "review_input_too_large", "review_schema_invalid",
    "rights_policy_not_legally_approved_active", "rights_batch_input_invalid", "approval_review_package_mismatch",
    "approval_explicit_human_approval_required", "approval_statement_mismatch", "approval_selection_invalid",
    "approval_selection_contains_ineligible_work", "approval_exception_invalid", "approval_target_partition_incomplete",
    "approval_work_not_eligible", "catalog_record_changed", "xhtml_edition_changed", "current_catalog_snapshot_invalid",
    "approval_checked_at_invalid", "approval_reviewer_invalid", "approval_common_review_basis_invalid",
    "approval_common_permission_conditions_invalid", "approval_review_basis_mismatch", "approval_policy_reference_invalid",
  ]);
  return error instanceof Error && known.has(error.message) ? error.message : "review_or_upstream_error";
}

async function pause(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run rights:aozora:sql -- --package .local-assets/rights-review/RUN/batch-review.json --approval .local-assets/rights-review/RUN/batch-approval-confirmed.json --out .local-assets/rights-review/RUN/register-approved-a.sql");
    return;
  }
  const [batchPackage, approval, policy] = await Promise.all([
    readJsonBounded(options.packagePath),
    readJsonBounded(options.approvalPath),
    readFile(POLICY_PATH, "utf8").then((value) => JSON.parse(value)),
  ]);
  if (batchPackage?.schema !== "amuhon-aozora-rights-batch-review/v1" ||
      approval?.schema !== "amuhon-aozora-rights-batch-approval/v1") throw new Error("review_schema_invalid");

  // Reject a draft/unreviewed common policy before making any upstream request.
  validateAozoraRightsBatchApproval(batchPackage, approval, policy);
  const currentCatalog = await resolveAozoraRightsCatalog();
  const currentById = new Map(currentCatalog.works.map((work) => [work.id, work]));
  const editionsById = new Map();
  for (let index = 0; index < approval.approvedWorkIds.length; index += 1) {
    const id = approval.approvedWorkIds[index];
    assertAozoraRightsBatchWorkUnchanged(batchPackage, id, currentById.get(id));
    const currentWork = currentById.get(id);
    if (!currentWork || classifyAozoraRightsWork(currentWork).classification !== "candidate_pending_human_review") {
      throw new Error("catalog_record_changed");
    }
    const [edition] = await resolveAozoraWorkEditions([id]);
    const recorded = batchPackage.works.find((work) => work.workId === id)?.reviewWork;
    if (!recorded || edition.sourceSha256 !== recorded.sourceSha256) throw new Error("xhtml_edition_changed");
    editionsById.set(id, edition);
    if (index < approval.approvedWorkIds.length - 1) await pause(250);
  }

  const sql = generateAozoraRightsBatchRegistrationSql({
    batchPackage,
    approval,
    policy,
    currentCatalog,
    editionsById,
  });
  await ensureLocalPath(options.out);
  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, sql, { encoding: "utf8", flag: "wx" });
  console.log(`PASS approved works: ${approval.approvedWorkIds.length}`);
  console.log(`PASS current target records and XHTML hashes: ${approval.approvedWorkIds.length}`);
  console.log("PASS whole-catalog hash is retained for audit; unrelated catalog changes do not block the batch.");
  console.log(`SQL draft: ${options.out}`);
  console.log("No database or Storage connection was made. The SQL was not executed.");
}

main().catch((error) => {
  console.error(`FAIL ${safeErrorCode(error)}`);
  process.exitCode = 1;
});
