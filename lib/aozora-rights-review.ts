import { createHash } from "node:crypto";
import { validateAozoraCatalogUrl, type AozoraRightsCatalogWork, type VerifiedAozoraWork } from "./aozora-edition.ts";

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

export type AozoraRightsApprovalWork = {
  workId: string;
  sourceSha256: string;
  approveAsA: boolean;
  domesticOriginalWorkConfirmed: boolean;
  allRightsAndProtectionTermConfirmed: boolean;
  noTranslationAdaptationCoauthorOrThirdPartyIssueConfirmed: boolean;
  commercialUseAndAttributionConfirmed: boolean;
  evidenceBasis: string;
  permissionConditions: string;
  holders: Array<{
    name: string;
    role: string;
    reviewedAndApprovedAsA: boolean;
    evidenceBasis: string;
    permissionConditions: string;
  }>;
};

export type AozoraRightsApprovalManifest = {
  schema: "amuhon-aozora-rights-approval/v1";
  packageSha256: string;
  catalogSha256: string;
  explicitHumanApproval: boolean;
  approvalStatement: string;
  checkedBy: string;
  checkedAt: string;
  works: AozoraRightsApprovalWork[];
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

export type AozoraRightsBatchAuditContext = {
  policySha256: string;
  currentCatalog: { fetchedAt: string; sha256: string };
  batchPackageSha256: string;
  selectionSha256: string;
  approvedSetSha256: string;
  approvedWorkIds: string[];
  approvalStatement: string;
  commonReviewBasis: string;
  policySnapshot: AozoraRightsPolicy;
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
  return stableJson({
    id: "workId" in work ? work.workId : work.id,
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
  return {
    approvedWorks,
    checkedBy,
    checkedAt,
    reviewBasis: requireText(approval.commonReviewBasis, 1000, "common_review_basis"),
    permissionConditions: requireText(approval.commonPermissionConditions, 1000, "common_permission_conditions"),
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
  const currentById = new Map(currentCatalog.works.map((work) => [work.id, work]));
  const approvedIds = approval.approvedWorkIds;
  const approvedSetSha256 = createHash("sha256").update([...approvedIds].sort().join("\n")).digest("hex");
  const currentEditions = new Map<string, VerifiedAozoraWork>();
  for (const item of validated.approvedWorks) {
    assertAozoraRightsBatchWorkUnchanged(batchPackage, item.workId, currentById.get(item.workId));
    const edition = editionsById.get(item.workId);
    if (!edition || edition.sourceSha256 !== item.reviewWork.sourceSha256 ||
        catalogRecordSignature(edition) !== catalogRecordSignature(currentById.get(item.workId)!)) {
      throw new Error("xhtml_edition_changed");
    }
    currentEditions.set(item.workId, edition);
  }

  const sourceReviewPackage = batchPackage.sourceReviewPackage;
  const legacyApproval: AozoraRightsApprovalManifest = {
    schema: "amuhon-aozora-rights-approval/v1",
    packageSha256: sourceReviewPackage.packageSha256,
    catalogSha256: sourceReviewPackage.catalog.sha256,
    explicitHumanApproval: true,
    approvalStatement: AOZORA_BATCH_APPROVAL_STATEMENT,
    checkedBy: validated.checkedBy,
    checkedAt: validated.checkedAt,
    works: validated.approvedWorks.map(({ reviewWork }) => ({
      workId: reviewWork.workId,
      sourceSha256: reviewWork.sourceSha256!,
      approveAsA: true,
      domesticOriginalWorkConfirmed: true,
      allRightsAndProtectionTermConfirmed: true,
      noTranslationAdaptationCoauthorOrThirdPartyIssueConfirmed: true,
      commercialUseAndAttributionConfirmed: true,
      evidenceBasis: validated.reviewBasis,
      permissionConditions: validated.permissionConditions,
      // These legacy-shaped fields are an internal adapter only. The SQL evidence
      // below records one batch decision; it does not claim per-holder interviews.
      holders: reviewWork.contributors.map((holder) => ({
        name: holder.name,
        role: holder.role,
        reviewedAndApprovedAsA: true,
        evidenceBasis: validated.reviewBasis,
        permissionConditions: validated.permissionConditions,
      })),
    })),
  };
  const auditContext: AozoraRightsBatchAuditContext = {
    policySha256: batchPackage.policy.sha256,
    currentCatalog: { fetchedAt: currentCatalog.fetchedAt, sha256: currentCatalog.sha256 },
    batchPackageSha256: batchPackage.packageSha256,
    selectionSha256: batchPackage.selection.sha256,
    approvedSetSha256,
    approvedWorkIds: [...approvedIds],
    approvalStatement: AOZORA_BATCH_APPROVAL_STATEMENT,
    commonReviewBasis: validated.reviewBasis,
    policySnapshot: policy,
  };
  return generateAozoraRightsRegistrationSql(sourceReviewPackage, legacyApproval, auditContext, currentEditions);
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

function evidenceJson(input: Record<string, unknown>): string {
  const value = JSON.stringify(input);
  if (value.length > 4000) throw new Error("approval_evidence_too_long");
  return value;
}

/** Creates SQL only from an explicitly human-approved manifest and exact review-package matches. */
function generateAozoraRightsRegistrationSql(
  reviewPackage: AozoraRightsReviewPackage,
  approval: AozoraRightsApprovalManifest,
  auditContext: AozoraRightsBatchAuditContext,
  currentEditions: Map<string, VerifiedAozoraWork>,
): string {
  if (!reviewPackage || reviewPackage.schema !== "amuhon-aozora-rights-review/v1" ||
      calculateReviewPackageSha256(reviewPackage) !== reviewPackage.packageSha256 ||
      !approval || approval.schema !== "amuhon-aozora-rights-approval/v1" ||
      approval.packageSha256 !== reviewPackage.packageSha256 || approval.catalogSha256 !== reviewPackage.catalog.sha256 ||
      !auditContext || !/^[a-f0-9]{64}$/.test(auditContext.policySha256) ||
      !/^[a-f0-9]{64}$/.test(auditContext.batchPackageSha256) ||
      !/^[a-f0-9]{64}$/.test(auditContext.selectionSha256) ||
      !/^[a-f0-9]{64}$/.test(auditContext.approvedSetSha256) ||
      !/^[a-f0-9]{64}$/.test(auditContext.currentCatalog.sha256) ||
      !Number.isFinite(Date.parse(auditContext.currentCatalog.fetchedAt)) ||
      calculateAozoraRightsPolicySha256(auditContext.policySnapshot) !== auditContext.policySha256 ||
      auditContext.policySnapshot.status !== "active" || !policyReady(auditContext.policySnapshot) ||
      auditContext.approvalStatement !== AOZORA_BATCH_APPROVAL_STATEMENT ||
      auditContext.approvalStatement !== approval.approvalStatement ||
      !Array.isArray(auditContext.approvedWorkIds) ||
      stableJson(auditContext.approvedWorkIds) !== stableJson(approval.works.map((item) => item.workId)) ||
      createHash("sha256").update([...auditContext.approvedWorkIds].sort().join("\n")).digest("hex") !== auditContext.approvedSetSha256) {
    throw new Error("approval_review_package_mismatch");
  }
  requireTrue(approval.explicitHumanApproval, "explicit_human_approval");
  if (approval.approvalStatement !== AOZORA_BATCH_APPROVAL_STATEMENT) throw new Error("approval_statement_mismatch");
  const checkedBy = requireText(approval.checkedBy, 200, "reviewer");
  if (/[\u0000-\u001f\u007f]/.test(checkedBy)) throw new Error("approval_reviewer_invalid");
  const checkedAt = requireText(approval.checkedAt, 100, "checked_at");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(checkedAt) || !Number.isFinite(Date.parse(checkedAt))) {
    throw new Error("approval_checked_at_invalid");
  }
  if (!Array.isArray(approval.works) || approval.works.length < 1 || approval.works.length > 50) throw new Error("approval_works_invalid");
  const packageById = new Map(reviewPackage.works.map((work) => [work.workId, work]));
  const seenIds = new Set<string>();
  const parentRows: string[] = [];
  const holderRows: string[] = [];
  for (const item of approval.works) {
    if (!item || typeof item !== "object" || seenIds.has(item.workId)) throw new Error("approval_work_duplicate_or_invalid");
    seenIds.add(item.workId);
    const source = packageById.get(item.workId);
    if (!source || source.classification !== "candidate_pending_human_review" || !source.editionVerified ||
        !source.sourceSha256 || !/^[a-f0-9]{64}$/.test(source.sourceSha256) || item.sourceSha256 !== source.sourceSha256 ||
        classifyAozoraRightsWork({
          id: source.workId,
          title: source.title,
          titleReading: source.titleReading,
          sortReading: source.sortReading,
          author: source.author,
          cardUrl: source.cardUrl,
          textUrl: source.textUrl,
          xhtmlUrl: source.xhtmlUrl,
          contributors: source.contributors,
          sourceMetadata: source.sourceMetadata,
          workCopyrightFlags: source.workCopyrightFlags,
          missingWorkCopyrightFlagRows: source.missingWorkCopyrightFlagRows,
          catalogPersonCopyrightFlags: source.catalogPersonCopyrightFlags,
          missingPersonCopyrightFlagRows: source.missingPersonCopyrightFlagRows,
          incompleteContributorRows: source.incompleteContributorRows,
          sourceMetadataConflicts: source.sourceMetadataConflicts,
          catalogIssues: source.catalogIssues,
          catalogRowCount: source.catalogRowCount,
        }).classification !== "candidate_pending_human_review") throw new Error("approval_work_not_current_candidate");
    for (const [field, label] of [
      [item.approveAsA, "approve_as_a"],
      [item.domesticOriginalWorkConfirmed, "domestic_original_work"],
      [item.allRightsAndProtectionTermConfirmed, "rights_and_term"],
      [item.noTranslationAdaptationCoauthorOrThirdPartyIssueConfirmed, "related_rights"],
      [item.commercialUseAndAttributionConfirmed, "commercial_use_and_attribution"],
    ] as const) requireTrue(field, label);
    const workEvidence = requireText(item.evidenceBasis, 1000, "work_evidence");
    if (workEvidence !== auditContext.commonReviewBasis) throw new Error("approval_review_basis_mismatch");
    const workConditions = requireText(item.permissionConditions, 1000, "work_permission_conditions");
    if (!Array.isArray(item.holders) || item.holders.length !== source.contributors.length || item.holders.length < 1) {
      throw new Error("approval_holder_set_mismatch");
    }
    const sourceHolders = new Set(source.contributors.map((person) => `${person.name}\u0000${person.role}`));
    const holderIdentities = new Set<string>();
    const contributorJson = JSON.stringify(source.contributors.map(({ name, role }) => ({ name, role })));
    const policyReferences = Array.isArray(auditContext.policySnapshot.references)
      ? auditContext.policySnapshot.references.map((reference) => {
        if (!reference || typeof reference !== "object" || typeof (reference as { url?: unknown }).url !== "string") {
          throw new Error("rights_policy_reference_invalid");
        }
        return (reference as { url: string }).url;
      })
      : [];
    const autoEvidence = {
      kind: "Amuhon common-policy batch rights review",
      policy: {
        id: auditContext.policySnapshot.policyId,
        version: auditContext.policySnapshot.version,
        sha256: auditContext.policySha256,
        status: auditContext.policySnapshot.status,
        legalReviewStatus: auditContext.policySnapshot.legalReviewStatus,
        approvedBy: auditContext.policySnapshot.approvedBy,
        approvedAt: auditContext.policySnapshot.approvedAt,
        legalReviewedBy: auditContext.policySnapshot.legalReviewedBy,
        legalReviewedAt: auditContext.policySnapshot.legalReviewedAt,
        legalReviewEvidence: auditContext.policySnapshot.legalReviewEvidence,
        references: policyReferences,
      },
      catalogUrl: reviewPackage.catalog.url,
      reviewCatalogFetchedAt: reviewPackage.catalog.fetchedAt,
      reviewCatalogSha256: reviewPackage.catalog.sha256,
      latestCatalogFetchedAt: auditContext.currentCatalog.fetchedAt,
      latestCatalogSha256: auditContext.currentCatalog.sha256,
      sourceReviewPackageSha256: reviewPackage.packageSha256,
      batchPackageSha256: auditContext.batchPackageSha256,
      selectionSha256: auditContext.selectionSha256,
      approvedSetSha256: auditContext.approvedSetSha256,
      approvedWorkIds: auditContext.approvedWorkIds,
      batchApproval: {
        statement: auditContext.approvalStatement,
        checkedBy: approval.checkedBy,
        checkedAt: approval.checkedAt,
        commonReviewBasis: auditContext.commonReviewBasis,
        commonPermissionConditions: item.permissionConditions,
      },
      officialWorkCopyrightFlags: source.workCopyrightFlags,
      officialContributorCopyrightFlags: source.catalogPersonCopyrightFlags,
      officialContributors: source.contributors.map(({ name, role, personIds, copyrightFlags }) => ({ name, role, personIds, copyrightFlags })),
      missingWorkCopyrightFlagRows: source.missingWorkCopyrightFlagRows,
      missingPersonCopyrightFlagRows: source.missingPersonCopyrightFlagRows,
    };
    const evidenceBasis = evidenceJson(autoEvidence);
    const sourceMetadataJson = JSON.stringify(source.sourceMetadata);
    const currentEdition = currentEditions.get(source.workId);
    if (!currentEdition || currentEdition.sourceSha256 !== source.sourceSha256 ||
        catalogRecordSignature(currentEdition) !== catalogRecordSignature({ ...source, id: source.workId })) {
      throw new Error("xhtml_edition_changed");
    }
    const textEditionRef = `aozora-xhtml-sha256:${source.sourceSha256}`;
    parentRows.push(`(${[
      sqlLiteral(source.workId), sqlLiteral(textEditionRef), sqlLiteral(source.sourceSha256), sqlLiteral(source.title),
      sqlLiteral(source.author), sqlLiteral(source.cardUrl), sqlLiteral(source.textUrl), sqlLiteral(source.xhtmlUrl),
      `${sqlLiteral(contributorJson)}::jsonb`, `${sqlLiteral(sourceMetadataJson)}::jsonb`, sqlLiteral("A"),
      sqlLiteral(evidenceBasis), `${sqlLiteral(checkedAt)}::timestamptz`, sqlLiteral(checkedBy), "true", sqlLiteral(workConditions),
    ].join(", ")})`);
    for (const holder of item.holders) {
      const identity = `${holder.name}\u0000${holder.role}`;
      if (!sourceHolders.has(identity) || holderIdentities.has(identity)) throw new Error("approval_holder_identity_mismatch");
      holderIdentities.add(identity);
      requireTrue(holder.reviewedAndApprovedAsA, "holder_review");
      requireText(holder.evidenceBasis, 3000, "holder_evidence");
      const holderConditions = requireText(holder.permissionConditions, 1000, "holder_permission_conditions");
      const holderBasis = evidenceJson({
        ...autoEvidence,
        rightsHolder: { name: holder.name, role: holder.role },
        batchCoverageNote: "この権利者は承認対象作品の関係者一覧に含まれる。一括基準の適用記録であり、独立した個別審査を行った記録ではない。",
      });
      holderRows.push(`(${[
        sqlLiteral(source.workId), sqlLiteral(source.xhtmlUrl), sqlLiteral(source.sourceSha256), sqlLiteral(holder.name),
        sqlLiteral(holder.role), sqlLiteral("A"), sqlLiteral(holderBasis), `${sqlLiteral(checkedAt)}::timestamptz`,
        sqlLiteral(checkedBy), sqlLiteral(holderConditions),
      ].join(", ")})`);
    }
  }

  const parentPreflight = approval.works.map(({ workId }) => {
    const source = packageById.get(workId)!;
    return `  if exists (select 1 from public.amuhon_work_commercial_rights where work_id = ${sqlLiteral(source.workId)} and xhtml_url = ${sqlLiteral(source.xhtmlUrl)} and source_sha256 = ${sqlLiteral(source.sourceSha256!)}) then raise exception 'RIGHTS_BATCH_RECORD_ALREADY_EXISTS'; end if;`;
  }).join("\n");
  const holderPreflight = approval.works.flatMap(({ workId }) => {
    const source = packageById.get(workId)!;
    return source.contributors.map((holder) => `  if exists (select 1 from public.amuhon_work_rights_holders where work_id = ${sqlLiteral(source.workId)} and xhtml_url = ${sqlLiteral(source.xhtmlUrl)} and source_sha256 = ${sqlLiteral(source.sourceSha256!)} and person_name = ${sqlLiteral(holder.name)} and role = ${sqlLiteral(holder.role)}) then raise exception 'RIGHTS_BATCH_HOLDER_ALREADY_EXISTS'; end if;`);
  }).join("\n");

  return [
    "-- HUMAN-APPROVED DATA DRAFT generated from an exact catalog and XHTML review package.",
    `-- Reviewer: ${checkedBy.replace(/[\r\n]/g, " ")}`,
    `-- Checked at: ${checkedAt}`,
    `-- Catalog SHA-256: ${reviewPackage.catalog.sha256}`,
    `-- Review package SHA-256: ${reviewPackage.packageSha256}`,
    "-- Review source flags, criteria version, and human evidence are stored in evidence_basis.",
    "-- This script inserts only; any existing exact parent/holder record aborts before changes.",
    "begin;",
    "do $rights_batch_preflight$",
    "begin",
    parentPreflight,
    holderPreflight,
    "end;",
    "$rights_batch_preflight$;",
    `insert into public.amuhon_work_commercial_rights (work_id, text_edition_ref, source_sha256, title, author, card_url, text_url, xhtml_url, catalog_contributors, catalog_source_metadata, status, evidence_basis, checked_at, checked_by, rights_reviews_complete, permission_conditions) values\n${parentRows.join(",\n")};`,
    `insert into public.amuhon_work_rights_holders (work_id, xhtml_url, source_sha256, person_name, role, status, evidence_basis, checked_at, checked_by, permission_conditions) values\n${holderRows.join(",\n")};`,
    "commit;",
    "",
  ].join("\n");
}
