import { createHash } from "node:crypto";
import { validateAozoraCatalogUrl, type AozoraRightsCatalogWork, type VerifiedAozoraWork } from "./aozora-edition.ts";
import { createAozoraRightsWorkFacts, calculateAozoraRightsWorkFactsSha256 } from "./aozora-rights-policy.ts";
import { AOZORA_ATTRIBUTION_NOTICE } from "./aozora-commercial-rights.ts";

export type RightsScreeningClass = "candidate_pending_human_review" | "B" | "C";

export type AozoraRightsScreeningResult = {
  classification: RightsScreeningClass;
  reasons: string[];
  manualChecks: string[];
};

export type AozoraRightsReviewPackageWork = {
  workId: string;
  title: string;
  titleReading: string;
  sortReading: string;
  author: string;
  classification: RightsScreeningClass;
  reasons: string[];
  manualChecks: string[];
  cardUrl: string;
  textUrl: string;
  xhtmlUrl: string;
  sourceSha256: string | null;
  editionVerified: boolean;
  workCopyrightFlags: string[];
  missingWorkCopyrightFlagRows: number;
  catalogPersonCopyrightFlags: string[];
  missingPersonCopyrightFlagRows: number;
  contributors: AozoraRightsCatalogWork["contributors"];
  incompleteContributorRows: number;
  sourceMetadata: AozoraRightsCatalogWork["sourceMetadata"];
  sourceMetadataConflicts: string[];
  catalogIssues: string[];
  catalogRowCount: number;
};

export type AozoraRightsReviewPackage = {
  schema: "amuhon-aozora-rights-review/v1";
  catalog: { url: string; fetchedAt: string; sha256: string; workCount: number };
  screeningCounts: { candidate_pending_human_review: number; B: number; C: number };
  selection: { limit: number; selectedIds: string[]; rule: string; sha256: string };
  works: AozoraRightsReviewPackageWork[];
  packageSha256: string;
};

const AUTHOR_ROLES = new Set(["著者", "作者", "原著者"]);

/**
 * Screens only facts present in the official CSV. A shortlisted record is not
 * an A decision: the catalog cannot establish domestic originality, third
 * party material, term details, or Amuhon's use conditions.
 */
export function classifyAozoraRightsWork(work: AozoraRightsCatalogWork): AozoraRightsScreeningResult {
  const reasons: string[] = [];
  const workFlags = work.workCopyrightFlags;
  const contributorFlags = [...new Set([...work.catalogPersonCopyrightFlags, ...work.contributors.flatMap((person) => person.copyrightFlags)])];
  const hasProtectedFlag = workFlags.includes("あり") || contributorFlags.includes("あり");
  if (hasProtectedFlag) {
    if (workFlags.includes("あり")) reasons.push("work_copyright_flag_present");
    if (contributorFlags.includes("あり")) reasons.push("contributor_copyright_flag_present");
    return { classification: "C", reasons, manualChecks: ["商用利用許諾の原本・範囲・期限を別途確認"] };
  }

  if (workFlags.length !== 1 || workFlags[0] !== "なし" || work.missingWorkCopyrightFlagRows > 0) {
    reasons.push("work_copyright_flag_missing_unknown_or_conflicting");
  }
  if (work.catalogIssues.length > 0) reasons.push(...work.catalogIssues);
  if (work.contributors.length === 0 || work.incompleteContributorRows > 0) reasons.push("contributor_data_missing_or_incomplete");
  if (work.missingPersonCopyrightFlagRows > 0 || contributorFlags.length !== 1 || contributorFlags[0] !== "なし" ||
      work.contributors.some((person) => person.copyrightFlags.length !== 1 || person.copyrightFlags[0] !== "なし" || person.missingCopyrightFlagRows > 0)) {
    reasons.push("contributor_copyright_flag_missing_unknown_or_conflicting");
  }
  if (work.contributors.some((person) => person.personIds.length !== 1 || !person.name || !person.role)) {
    reasons.push("contributor_identity_incomplete_or_conflicting");
  }
  if (work.contributors.length !== 1 || !AUTHOR_ROLES.has(work.contributors[0]?.role ?? "")) {
    reasons.push("translation_adaptation_collective_or_non_author_role_requires_review");
  }
  if (work.sourceMetadataConflicts.length > 0) reasons.push("bibliographic_metadata_conflict");
  if (!work.title || !validateAozoraCatalogUrl(work.cardUrl, work.id, "card") ||
      !validateAozoraCatalogUrl(work.textUrl, work.id, "text") ||
      !validateAozoraCatalogUrl(work.xhtmlUrl, work.id, "xhtml")) {
    reasons.push("official_source_urls_or_title_incomplete");
  }

  if (reasons.length > 0) {
    return {
      classification: "B",
      reasons: [...new Set(reasons)],
      manualChecks: ["作品・関係者・本文版の個別権利根拠を確認", "不明点が残る間は販売対象外"],
    };
  }

  return {
    classification: "candidate_pending_human_review",
    reasons: ["official_flags_none_and_single_author_role_only"],
    manualChecks: [
      "国内の単独オリジナル作品であることを公式資料で確認（CSVだけでは確認できない）",
      "翻訳・翻案・共同著作・編者・校訂者・第三者素材がないことを作品とカードで確認",
      "日本での保護期間、経過措置、外国著作物等を確認",
      "青空文庫の出典表示と編む本の有償製本利用条件を確認",
      "本文XHTMLの取得とSHA-256を承認直前に再確認",
    ],
  };
}

export function isAozoraRightsBatchCandidate(work: AozoraRightsCatalogWork): boolean {
  return classifyAozoraRightsWork(work).classification === "candidate_pending_human_review";
}

export function classifyAozoraCatalog(works: AozoraRightsCatalogWork[]) {
  const counts = { candidate_pending_human_review: 0, B: 0, C: 0 };
  for (const work of works) counts[classifyAozoraRightsWork(work).classification] += 1;
  return counts;
}

export const AOZORA_BATCH_APPROVAL_STATEMENT = "私は、適用する審査基準、対象作品一覧、版情報、根拠および除外条件を確認し、提示された範囲の作品について一括承認します。";

export type AozoraRightsPolicy = {
  schema: "amuhon-aozora-rights-policy/v1";
  policyId: string;
  version: string;
  title: string;
  status: "draft" | "active" | "suspended";
  legalReviewStatus: "unconfirmed" | "confirmed";
  approvedBy: string | null;
  approvedAt: string | null;
  legalReviewedBy: string | null;
  legalReviewedAt: string | null;
  legalReviewEvidence: string | null;
  [key: string]: unknown;
};

export type AozoraRightsBatchCategory = "bulk_candidate" | "individual_review" | "excluded";

export type AozoraRightsBatchReviewPackage = {
  schema: "amuhon-aozora-rights-batch-review/v1";
  policy: { sha256: string; snapshot: AozoraRightsPolicy };
  sourceReviewPackage: AozoraRightsReviewPackage;
  screening: {
    bulkCandidateCount: number;
    individualReviewCount: number;
    excludedCount: number;
    registrationEligibleCount: number;
    aRegistrationAllowed: boolean;
  };
  selection: { proposedWorkIds: string[]; sha256: string };
  works: Array<{
    workId: string;
    category: AozoraRightsBatchCategory;
    reasons: string[];
    reviewWork: AozoraRightsReviewPackageWork;
  }>;
  packageSha256: string;
};

export type AozoraRightsBatchApproval = {
  schema: "amuhon-aozora-rights-batch-approval/v1";
  packageSha256: string;
  policySha256: string;
  selectionSha256: string;
  explicitHumanApproval: boolean;
  approvalStatement: string;
  checkedBy: string;
  checkedAt: string;
  proposedWorkIds: string[];
  approvedWorkIds: string[];
  exceptions: Array<{ workId: string; disposition: "individual_review" | "excluded"; reason: string }>;
  commonReviewBasis: string;
  commonPermissionConditions: string;
};

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export function calculateReviewPackageSha256(reviewPackage: Omit<AozoraRightsReviewPackage, "packageSha256"> | AozoraRightsReviewPackage): string {
  const payload = { ...reviewPackage } as Record<string, unknown>;
  delete payload.packageSha256;
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function toReviewPackageWork(work: AozoraRightsCatalogWork, edition?: VerifiedAozoraWork): AozoraRightsReviewPackageWork {
  const screening = classifyAozoraRightsWork(work);
  let classification = screening.classification;
  let reasons = screening.reasons;
  let manualChecks = screening.manualChecks;
  if (classification === "candidate_pending_human_review" && !edition) {
    classification = "B";
    reasons = [...reasons, "xhtml_hash_not_verified"];
    manualChecks = ["公式XHTMLの再取得・実バイトSHA-256検証に失敗したため承認候補から除外"];
  }
  return {
    workId: work.id,
    title: work.title,
    author: work.author,
    classification,
    reasons,
    manualChecks,
    cardUrl: work.cardUrl,
    textUrl: work.textUrl,
    xhtmlUrl: work.xhtmlUrl,
    sourceSha256: edition?.sourceSha256 ?? null,
    editionVerified: Boolean(edition),
    workCopyrightFlags: work.workCopyrightFlags,
    missingWorkCopyrightFlagRows: work.missingWorkCopyrightFlagRows,
    catalogPersonCopyrightFlags: work.catalogPersonCopyrightFlags,
    missingPersonCopyrightFlagRows: work.missingPersonCopyrightFlagRows,
    titleReading: work.titleReading,
    sortReading: work.sortReading,
    contributors: work.contributors,
    incompleteContributorRows: work.incompleteContributorRows,
    sourceMetadata: work.sourceMetadata,
    sourceMetadataConflicts: work.sourceMetadataConflicts,
    catalogIssues: work.catalogIssues,
    catalogRowCount: work.catalogRowCount,
  };
}

export function createAozoraRightsReviewPackage(input: {
  catalogUrl: string;
  fetchedAt: string;
  catalogSha256: string;
  catalogWorks: AozoraRightsCatalogWork[];
  selectionLimit: number;
  selectedIds: string[];
  editionsById: Map<string, VerifiedAozoraWork>;
}): AozoraRightsReviewPackage {
  if (!Number.isInteger(input.selectionLimit) || input.selectionLimit < 1 || input.selectionLimit > 50 ||
      !/^[a-f0-9]{64}$/.test(input.catalogSha256) || input.selectedIds.length > input.selectionLimit ||
      new Set(input.selectedIds).size !== input.selectedIds.length) throw new Error("review_package_input_invalid");
  const worksById = new Map(input.catalogWorks.map((work) => [work.id, work]));
  const selectedWorks = input.selectedIds.map((id) => {
    const work = worksById.get(id);
    if (!work) throw new Error("review_selection_not_in_catalog");
    return toReviewPackageWork(work, input.editionsById.get(id));
  });
  const payload: Omit<AozoraRightsReviewPackage, "packageSha256"> = {
    schema: "amuhon-aozora-rights-review/v1",
    catalog: { url: input.catalogUrl, fetchedAt: input.fetchedAt, sha256: input.catalogSha256, workCount: input.catalogWorks.length },
    screeningCounts: classifyAozoraCatalog(input.catalogWorks),
    selection: {
      limit: input.selectionLimit,
      selectedIds: input.selectedIds,
      rule: "先に指定した回帰作品（鼻・夢十夜・注文の多い料理店）を含め、残りは作品ID数値昇順の機械候補から選択。本文取得は選択作品だけを直列に実施。",
      sha256: createHash("sha256").update(input.catalogSha256 + "\n" + input.selectedIds.join("\n")).digest("hex"),
    },
    works: selectedWorks,
  };
  return { ...payload, packageSha256: calculateReviewPackageSha256(payload) };
}

export function calculateAozoraRightsPolicySha256(policy: AozoraRightsPolicy): string {
  return createHash("sha256").update(stableJson(policy)).digest("hex");
}

export function calculateAozoraRightsBatchPackageSha256(batchPackage: Omit<AozoraRightsBatchReviewPackage, "packageSha256"> | AozoraRightsBatchReviewPackage): string {
  const payload = { ...batchPackage } as Record<string, unknown>;
  delete payload.packageSha256;
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function policyDefinitionValid(policy: AozoraRightsPolicy): boolean {
  const isText = (value: unknown) => typeof value === "string" && value.trim().length > 0 &&
    value.trim().length <= 1000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  const sections = ["scope", "eligibilityCriteria", "individualReviewConditions", "exclusionConditions", "humanReviewRequirements"];
  if (!/^[A-Z0-9][A-Z0-9_-]{2,99}$/.test(policy.policyId) || !/^\d+\.\d+\.\d+$/.test(policy.version) ||
      !isText(policy.title) || !isText(policy.attributionRule) ||
      !Number.isInteger(policy.maxBatchSize) || Number(policy.maxBatchSize) < 1 || Number(policy.maxBatchSize) > 50) return false;
  for (const key of sections) {
    const values = policy[key];
    if (!Array.isArray(values) || values.length < 1 || values.length > 50 || values.some((value) => !isText(value))) return false;
  }
  if (!Array.isArray(policy.references) || policy.references.length < 1 || policy.references.length > 50) return false;
  return policy.references.every((reference) => {
    if (!reference || typeof reference !== "object" || !isText(reference.title) || typeof reference.url !== "string") return false;
    try {
      const url = new URL(reference.url);
      return url.protocol === "https:" && !url.username && !url.password && !url.hash;
    } catch {
      return false;
    }
  });
}

function policyReady(policy: AozoraRightsPolicy): boolean {
  const isIso = (value: unknown) => typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
  const isNamed = (value: unknown) => typeof value === "string" && value.trim().length > 0 &&
    value.trim().length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
  return policyDefinitionValid(policy) && policy.status === "active" && policy.legalReviewStatus === "confirmed" &&
    isNamed(policy.approvedBy) && isIso(policy.approvedAt) &&
    isNamed(policy.legalReviewedBy) && isIso(policy.legalReviewedAt) &&
    typeof policy.legalReviewEvidence === "string" && policy.legalReviewEvidence.trim().length > 0 &&
    policy.legalReviewEvidence.trim().length <= 1000;
}

export function createAozoraRightsBatchReviewPackage(
  sourceReviewPackage: AozoraRightsReviewPackage,
  policy: AozoraRightsPolicy,
): AozoraRightsBatchReviewPackage {
  if (!sourceReviewPackage || sourceReviewPackage.schema !== "amuhon-aozora-rights-review/v1" ||
      calculateReviewPackageSha256(sourceReviewPackage) !== sourceReviewPackage.packageSha256 ||
      !policy || policy.schema !== "amuhon-aozora-rights-policy/v1" || !policyDefinitionValid(policy) ||
      !["draft", "active", "suspended"].includes(policy.status) ||
      !["unconfirmed", "confirmed"].includes(policy.legalReviewStatus)) throw new Error("rights_batch_input_invalid");

  const works = sourceReviewPackage.works.map((reviewWork) => {
    const screening = classifyAozoraRightsWork({
      id: reviewWork.workId,
      title: reviewWork.title,
      titleReading: reviewWork.titleReading,
      sortReading: reviewWork.sortReading,
      author: reviewWork.author,
      cardUrl: reviewWork.cardUrl,
      textUrl: reviewWork.textUrl,
      xhtmlUrl: reviewWork.xhtmlUrl,
      contributors: reviewWork.contributors,
      sourceMetadata: reviewWork.sourceMetadata,
      workCopyrightFlags: reviewWork.workCopyrightFlags,
      missingWorkCopyrightFlagRows: reviewWork.missingWorkCopyrightFlagRows,
      catalogPersonCopyrightFlags: reviewWork.catalogPersonCopyrightFlags,
      missingPersonCopyrightFlagRows: reviewWork.missingPersonCopyrightFlagRows,
      incompleteContributorRows: reviewWork.incompleteContributorRows,
      sourceMetadataConflicts: reviewWork.sourceMetadataConflicts,
      catalogIssues: reviewWork.catalogIssues,
      catalogRowCount: reviewWork.catalogRowCount,
    });
    if (screening.classification === "C") {
      return { workId: reviewWork.workId, category: "excluded" as const, reasons: screening.reasons, reviewWork };
    }
    if (screening.classification !== "candidate_pending_human_review" || !reviewWork.editionVerified ||
        !reviewWork.sourceSha256 || reviewWork.classification !== "candidate_pending_human_review") {
      return {
        workId: reviewWork.workId,
        category: "individual_review" as const,
        reasons: [...new Set([...screening.reasons, ...reviewWork.reasons])],
        reviewWork,
      };
    }
    return {
      workId: reviewWork.workId,
      category: "bulk_candidate" as const,
      reasons: ["official_catalog_screen_passed; human and policy approval still required"],
      reviewWork,
    };
  });
  const proposedWorkIds = works.filter((work) => work.category === "bulk_candidate").map((work) => work.workId);
  const policySnapshot = JSON.parse(JSON.stringify(policy)) as AozoraRightsPolicy;
  const payload: Omit<AozoraRightsBatchReviewPackage, "packageSha256"> = {
    schema: "amuhon-aozora-rights-batch-review/v1",
    policy: { sha256: calculateAozoraRightsPolicySha256(policySnapshot), snapshot: policySnapshot },
    sourceReviewPackage,
    screening: {
      bulkCandidateCount: proposedWorkIds.length,
      individualReviewCount: works.filter((work) => work.category === "individual_review").length,
      excludedCount: works.filter((work) => work.category === "excluded").length,
      registrationEligibleCount: policyReady(policy) ? proposedWorkIds.length : 0,
      aRegistrationAllowed: policyReady(policy),
    },
    selection: {
      proposedWorkIds,
      sha256: createHash("sha256").update(JSON.stringify({
        sourceReviewPackageSha256: sourceReviewPackage.packageSha256,
        policySha256: calculateAozoraRightsPolicySha256(policySnapshot),
        proposedWorkIds,
      })).digest("hex"),
    },
    works,
  };
  return { ...payload, packageSha256: calculateAozoraRightsBatchPackageSha256(payload) };
}

export function createAozoraRightsBatchApprovalTemplate(batchPackage: AozoraRightsBatchReviewPackage): {
  schema: "amuhon-aozora-rights-batch-approval/v1";
  packageSha256: string;
  policySha256: string;
  selectionSha256: string;
  explicitHumanApproval: false;
  approvalStatement: string;
  checkedBy: "";
  checkedAt: "";
  proposedWorkIds: string[];
  approvedWorkIds: [];
  exceptions: [];
  commonReviewBasis: "";
  commonPermissionConditions: "";
} {
  return {
    schema: "amuhon-aozora-rights-batch-approval/v1",
    packageSha256: batchPackage.packageSha256,
    policySha256: batchPackage.policy.sha256,
    selectionSha256: batchPackage.selection.sha256,
    explicitHumanApproval: false,
    approvalStatement: AOZORA_BATCH_APPROVAL_STATEMENT,
    checkedBy: "",
    checkedAt: "",
    proposedWorkIds: [...batchPackage.selection.proposedWorkIds],
    approvedWorkIds: [],
    exceptions: [],
    commonReviewBasis: "",
    commonPermissionConditions: "",
  };
}

function catalogRecordSignature(work: AozoraRightsCatalogWork | AozoraRightsBatchReviewPackage["works"][number]["reviewWork"]): string {
  return stableJson(createAozoraRightsWorkFacts(work));
}

function requireIsoTimestamp(value: unknown, code: string): string {
  const text = requireText(value, 100, code);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new Error(`approval_${code}_invalid`);
  }
  return text;
}

export function validateAozoraRightsBatchApproval(
  batchPackage: AozoraRightsBatchReviewPackage,
  approval: AozoraRightsBatchApproval,
  policy: AozoraRightsPolicy,
): { approvedWorks: AozoraRightsBatchReviewPackage["works"]; checkedBy: string; checkedAt: string; reviewBasis: string; permissionConditions: string } {
  if (!batchPackage || batchPackage.schema !== "amuhon-aozora-rights-batch-review/v1" ||
      calculateAozoraRightsBatchPackageSha256(batchPackage) !== batchPackage.packageSha256 ||
      !approval || approval.schema !== "amuhon-aozora-rights-batch-approval/v1" ||
      !policy || policy.schema !== "amuhon-aozora-rights-policy/v1" ||
      calculateAozoraRightsPolicySha256(policy) !== batchPackage.policy.sha256 ||
      stableJson(batchPackage.policy.snapshot) !== stableJson(policy) ||
      approval.packageSha256 !== batchPackage.packageSha256 || approval.policySha256 !== batchPackage.policy.sha256 ||
      approval.selectionSha256 !== batchPackage.selection.sha256 ||
      calculateReviewPackageSha256(batchPackage.sourceReviewPackage) !== batchPackage.sourceReviewPackage.packageSha256) {
    throw new Error("approval_review_package_mismatch");
  }
  if (policy.status !== "active" || !policyReady(policy)) throw new Error("rights_policy_not_legally_approved_active");
  requireTrue(approval.explicitHumanApproval, "explicit_human_approval");
  if (approval.approvalStatement !== AOZORA_BATCH_APPROVAL_STATEMENT) throw new Error("approval_statement_mismatch");
  const checkedBy = requireText(approval.checkedBy, 200, "reviewer");
  if (/[\u0000-\u001f\u007f]/.test(checkedBy)) throw new Error("approval_reviewer_invalid");
  const checkedAt = requireIsoTimestamp(approval.checkedAt, "checked_at");
  const proposedIds = batchPackage.selection.proposedWorkIds;
  if (!Array.isArray(approval.proposedWorkIds) || stableJson(approval.proposedWorkIds) !== stableJson(proposedIds) ||
      !Array.isArray(approval.approvedWorkIds) || approval.approvedWorkIds.length < 1 || approval.approvedWorkIds.length > 50 ||
      new Set(approval.approvedWorkIds).size !== approval.approvedWorkIds.length ||
      !Array.isArray(approval.exceptions)) throw new Error("approval_selection_invalid");
  const proposedSet = new Set(proposedIds);
  const approvedSet = new Set(approval.approvedWorkIds);
  if (approval.approvedWorkIds.some((id) => !proposedSet.has(id))) throw new Error("approval_selection_contains_ineligible_work");
  const exceptionById = new Map<string, AozoraRightsBatchApproval["exceptions"][number]>();
  for (const exception of approval.exceptions) {
    if (!exception || !proposedSet.has(exception.workId) || approvedSet.has(exception.workId) || exceptionById.has(exception.workId) ||
        !["individual_review", "excluded"].includes(exception.disposition)) throw new Error("approval_exception_invalid");
    requireText(exception.reason, 1000, "exception_reason");
    exceptionById.set(exception.workId, exception);
  }
  if ([...proposedSet].some((id) => !approvedSet.has(id) && !exceptionById.has(id))) throw new Error("approval_target_partition_incomplete");
  const approvedWorks = approval.approvedWorkIds.map((id) => {
    const work = batchPackage.works.find((item) => item.workId === id);
    if (!work || work.category !== "bulk_candidate" || !work.reviewWork.editionVerified || !work.reviewWork.sourceSha256) {
      throw new Error("approval_work_not_eligible");
    }
    return work;
  });
  const permissionConditions = requireText(approval.commonPermissionConditions, 1000, "common_permission_conditions");
  if (permissionConditions !== AOZORA_ATTRIBUTION_NOTICE) throw new Error("approval_common_permission_conditions_invalid");
  return {
    approvedWorks,
    checkedBy,
    checkedAt,
    reviewBasis: requireText(approval.commonReviewBasis, 1000, "common_review_basis"),
    permissionConditions,
  };
}

export function assertAozoraRightsBatchWorkUnchanged(
  batchPackage: AozoraRightsBatchReviewPackage,
  workId: string,
  current: AozoraRightsCatalogWork | undefined,
): AozoraRightsBatchReviewPackage["works"][number] {
  const recorded = batchPackage.works.find((work) => work.workId === workId);
  if (!recorded || recorded.category !== "bulk_candidate" || !current || current.id !== workId ||
      classifyAozoraRightsWork(current).classification !== "candidate_pending_human_review" ||
      catalogRecordSignature(recorded.reviewWork) !== catalogRecordSignature(current)) throw new Error("catalog_record_changed");
  return recorded;
}

export function generateAozoraRightsBatchRegistrationSql(input: {
  batchPackage: AozoraRightsBatchReviewPackage;
  approval: AozoraRightsBatchApproval;
  policy: AozoraRightsPolicy;
  currentCatalog: { fetchedAt: string; sha256: string; works: AozoraRightsCatalogWork[] };
  editionsById: Map<string, VerifiedAozoraWork>;
}): string {
  const { batchPackage, approval, policy, currentCatalog, editionsById } = input;
  const validated = validateAozoraRightsBatchApproval(batchPackage, approval, policy);
  if (!/^[a-f0-9]{64}$/.test(currentCatalog.sha256) || !Number.isFinite(Date.parse(currentCatalog.fetchedAt))) {
    throw new Error("current_catalog_snapshot_invalid");
  }
  if (validated.permissionConditions !== "このファイルは、インターネットの図書館、青空文庫（https://www.aozora.gr.jp/）で作られました。入力、校正、制作にあたったのは、ボランティアの皆さんです。") {
    throw new Error("approval_common_permission_conditions_invalid");
  }
  const currentById = new Map(currentCatalog.works.map((work) => [work.id, work]));
  const approvedIds = approval.approvedWorkIds;
  const approvedSet = new Set(approvedIds);
  const exceptionById = new Map(approval.exceptions.map((item) => [item.workId, item]));
  const approvedSetSha256 = createHash("sha256").update([...approvedIds].sort().join("\n")).digest("hex");
  const approvedWorks = new Map(validated.approvedWorks.map((item) => [item.workId, item]));
  const memberRows: string[] = [];

  for (const item of batchPackage.works) {
    const current = currentById.get(item.workId);
    if (!current || catalogRecordSignature(item.reviewWork) !== catalogRecordSignature(current)) {
      throw new Error("catalog_record_changed");
    }
    let disposition: "approved" | "individual_review" | "excluded";
    let reason: string;
    if (item.category === "bulk_candidate" && approvedSet.has(item.workId)) {
      const approved = approvedWorks.get(item.workId);
      const edition = editionsById.get(item.workId);
      if (!approved || !edition || edition.sourceSha256 !== item.reviewWork.sourceSha256 ||
          catalogRecordSignature(edition) !== catalogRecordSignature(current)) {
        throw new Error("xhtml_edition_changed");
      }
      disposition = "approved";
      reason = "approved_by_common_policy_scope";
    } else if (item.category === "bulk_candidate") {
      const exception = exceptionById.get(item.workId);
      if (!exception) throw new Error("approval_target_partition_incomplete");
      disposition = exception.disposition;
      reason = exception.reason;
    } else if (item.category === "individual_review") {
      disposition = "individual_review";
      reason = item.reasons.join("; ") || "catalog_screen_requires_individual_review";
    } else {
      disposition = "excluded";
      reason = item.reasons.join("; ") || "official_rights_flags_require_exclusion";
    }
    const facts = createAozoraRightsWorkFacts(current);
    memberRows.push(`(${[
      sqlLiteral(item.workId), sqlLiteral(disposition), sqlLiteral(reason.slice(0, 2000)),
      sqlLiteral(calculateAozoraRightsWorkFactsSha256(current)), `${sqlLiteral(JSON.stringify(facts))}::jsonb`,
    ].join(", ")})`);
  }

  const auditJson = JSON.stringify({
    policy: {
      id: policy.policyId,
      version: policy.version,
      sha256: batchPackage.policy.sha256,
      approvedBy: policy.approvedBy,
      approvedAt: policy.approvedAt,
      legalReviewedBy: policy.legalReviewedBy,
      legalReviewedAt: policy.legalReviewedAt,
      legalReviewEvidence: policy.legalReviewEvidence,
      references: policy.references,
    },
    sourceReviewPackageSha256: batchPackage.sourceReviewPackage.packageSha256,
    batchPackageSha256: batchPackage.packageSha256,
    selectionSha256: batchPackage.selection.sha256,
    approvedSetSha256,
    selectedWorkIds: batchPackage.works.map((item) => item.workId),
    approvedWorkIds: [...approvedIds],
    exceptions: approval.exceptions,
    approvalStatement: approval.approvalStatement,
    checkedBy: validated.checkedBy,
    checkedAt: validated.checkedAt,
    commonReviewBasis: validated.reviewBasis,
    commonPermissionConditions: validated.permissionConditions,
    currentCatalogFetchedAt: currentCatalog.fetchedAt,
    currentCatalogSha256: currentCatalog.sha256,
  });
  const policyId = sqlLiteral(policy.policyId);
  const policyVersion = sqlLiteral(policy.version);
  const policySha = sqlLiteral(batchPackage.policy.sha256);
  const approvedBy = sqlLiteral(String(policy.approvedBy));
  const approvedAt = `${sqlLiteral(String(policy.approvedAt))}::timestamptz`;
  const legalReviewedBy = sqlLiteral(String(policy.legalReviewedBy));
  const legalReviewedAt = `${sqlLiteral(String(policy.legalReviewedAt))}::timestamptz`;
  const legalEvidence = sqlLiteral(String(policy.legalReviewEvidence));
  const checkedAt = `${sqlLiteral(validated.checkedAt)}::timestamptz`;

  return [
    "-- Common-policy work-scope registration generated after explicit operator approval.",
    "-- One shared policy decision and work scope are recorded; no individual rights-holder approvals are created.",
    `-- Policy SHA-256: ${batchPackage.policy.sha256}`,
    `-- Batch package SHA-256: ${batchPackage.packageSha256}`,
    `-- Selection SHA-256: ${batchPackage.selection.sha256}`,
    `-- Approved-set SHA-256: ${approvedSetSha256}`,
    "begin;",
    `insert into public.amuhon_aozora_rights_policy_registry (policy_id, policy_version, definition_sha256, policy_status, legal_review_status, policy_definition, approved_by, approved_at, legal_reviewed_by, legal_reviewed_at, legal_review_evidence)
values (${policyId}, ${policyVersion}, ${policySha}, 'active', 'confirmed', ${sqlLiteral(JSON.stringify(policy))}::jsonb, ${approvedBy}, ${approvedAt}, ${legalReviewedBy}, ${legalReviewedAt}, ${legalEvidence})
on conflict (policy_id, policy_version) do update set definition_sha256 = excluded.definition_sha256, policy_status = excluded.policy_status, legal_review_status = excluded.legal_review_status, policy_definition = excluded.policy_definition, approved_by = excluded.approved_by, approved_at = excluded.approved_at, legal_reviewed_by = excluded.legal_reviewed_by, legal_reviewed_at = excluded.legal_reviewed_at, legal_review_evidence = excluded.legal_review_evidence, updated_at = clock_timestamp()
where public.amuhon_aozora_rights_policy_registry.policy_status = 'draft' and public.amuhon_aozora_rights_policy_registry.legal_review_status = 'unconfirmed' and public.amuhon_aozora_rights_policy_registry.approved_by is null and public.amuhon_aozora_rights_policy_registry.approved_at is null and public.amuhon_aozora_rights_policy_registry.legal_reviewed_by is null and public.amuhon_aozora_rights_policy_registry.legal_reviewed_at is null and public.amuhon_aozora_rights_policy_registry.legal_review_evidence is null;`,
    `do $rights_scope_preflight$
begin
  if not exists (select 1 from public.amuhon_aozora_rights_policy_registry where policy_id = ${policyId} and policy_version = ${policyVersion} and definition_sha256 = ${policySha} and policy_status = 'active' and legal_review_status = 'confirmed' and approved_by = ${approvedBy} and approved_at = ${approvedAt} and legal_reviewed_by = ${legalReviewedBy} and legal_reviewed_at = ${legalReviewedAt} and legal_review_evidence = ${legalEvidence}) then raise exception 'RIGHTS_POLICY_REGISTRY_MISMATCH'; end if;
  if exists (select 1 from public.amuhon_aozora_rights_scope_batches where batch_package_sha256 = ${sqlLiteral(batchPackage.packageSha256)}) then raise exception 'RIGHTS_SCOPE_BATCH_ALREADY_REGISTERED'; end if;
end;
$rights_scope_preflight$;`,
    `with inserted_scope as (
  insert into public.amuhon_aozora_rights_scope_batches (
    policy_id, policy_version, policy_sha256, scope_status, scope_kind,
    catalog_fetched_at, catalog_sha256, source_package_sha256, batch_package_sha256,
    selection_sha256, approved_set_sha256, approval_statement, approved_by, approved_at,
    common_review_basis, permission_conditions, batch_audit
  ) values (
    ${policyId}, ${policyVersion}, ${policySha}, 'active', 'explicit_work_id_set',
    ${sqlLiteral(currentCatalog.fetchedAt)}::timestamptz, ${sqlLiteral(currentCatalog.sha256)},
    ${sqlLiteral(batchPackage.sourceReviewPackage.packageSha256)}, ${sqlLiteral(batchPackage.packageSha256)},
    ${sqlLiteral(batchPackage.selection.sha256)}, ${sqlLiteral(approvedSetSha256)},
    ${sqlLiteral(approval.approvalStatement)}, ${sqlLiteral(validated.checkedBy)}, ${checkedAt},
    ${sqlLiteral(validated.reviewBasis)}, ${sqlLiteral(validated.permissionConditions)}, ${sqlLiteral(auditJson)}::jsonb
  ) returning scope_id
)
insert into public.amuhon_aozora_rights_scope_members (scope_id, work_id, disposition, reason, facts_sha256, facts_snapshot)
select inserted_scope.scope_id, member.work_id, member.disposition, member.reason, member.facts_sha256, member.facts_snapshot
from inserted_scope cross join (values
${memberRows.join(",\n")}
) as member(work_id, disposition, reason, facts_sha256, facts_snapshot);`,
    "commit;",
    "",
  ].join("\n");
}
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function requireText(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`approval_${field}_invalid`);
  return value.trim();
}

function requireTrue(value: unknown, field: string): void {
  if (value !== true) throw new Error(`approval_${field}_required`);
}
