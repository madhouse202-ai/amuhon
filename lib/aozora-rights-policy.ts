import { createHash } from "node:crypto";
import policyDefinition from "../data/aozora-rights-policy-v1.json" with { type: "json" };
import type { AozoraRightsCatalogWork } from "./aozora-edition.ts";

export type AozoraRightsPolicyDefinition = typeof policyDefinition;

type RuntimePolicyStatus = Record<string, unknown>;

export const CURRENT_AOZORA_RIGHTS_POLICY = policyDefinition as AozoraRightsPolicyDefinition;

export type AozoraRightsPolicyBinding = {
  policyId: string;
  policyVersion: string;
  policySha256: string;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function calculateAozoraRightsPolicySha256(policy: unknown = CURRENT_AOZORA_RIGHTS_POLICY): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

export function getCurrentAozoraRightsPolicyBinding(): AozoraRightsPolicyBinding {
  return {
    policyId: CURRENT_AOZORA_RIGHTS_POLICY.policyId,
    policyVersion: CURRENT_AOZORA_RIGHTS_POLICY.version,
    policySha256: calculateAozoraRightsPolicySha256(),
  };
}

function named(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function timestamp(value: unknown): boolean {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

/** The static definition must itself carry real operator and legal review records before use. */
export function isCurrentAozoraRightsPolicyReady(): boolean {
  const policy = CURRENT_AOZORA_RIGHTS_POLICY as unknown as RuntimePolicyStatus;
  const nonEmptyList = (value: unknown) => Array.isArray(value) && value.length > 0 && value.length <= 100 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 2000);
  const references = policy.references;
  const validReferences = Array.isArray(references) && references.length > 0 && references.length <= 50 &&
    references.every((item) => item && typeof item === "object" &&
      typeof (item as Record<string, unknown>).title === "string" &&
      typeof (item as Record<string, unknown>).url === "string" &&
      typeof (item as Record<string, unknown>).purpose === "string");
  return policy.schema === "amuhon-aozora-rights-policy/v1" &&
    typeof policy.policyId === "string" && /^[A-Z0-9][A-Z0-9_-]{2,99}$/.test(policy.policyId) &&
    typeof policy.version === "string" && /^\d+\.\d+\.\d+$/.test(policy.version) &&
    named(policy.title) && nonEmptyList(policy.scope) && nonEmptyList(policy.eligibilityCriteria) &&
    nonEmptyList(policy.individualReviewConditions) && nonEmptyList(policy.exclusionConditions) &&
    nonEmptyList(policy.humanReviewRequirements) && validReferences && named(policy.attributionRule) &&
    Number.isInteger(policy.maxBatchSize) && (policy.maxBatchSize as number) >= 1 && (policy.maxBatchSize as number) <= 50 &&
    policy.status === "active" && policy.legalReviewStatus === "confirmed" &&
    named(policy.approvedBy) && timestamp(policy.approvedAt) &&
    named(policy.legalReviewedBy) && timestamp(policy.legalReviewedAt) &&
    typeof policy.legalReviewEvidence === "string" && policy.legalReviewEvidence.trim().length > 0 &&
    policy.legalReviewEvidence.trim().length <= 1000;
}

/**
 * Facts whose change requires a new common-scope review. The whole-catalog
 * digest and XHTML bytes are intentionally separate: the latter is checked by
 * edition validation and a global catalog refresh does not invalidate every
 * approval.
 */
export function createAozoraRightsWorkFacts(work: AozoraRightsCatalogWork | Record<string, unknown>) {
  const raw = work as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : raw.workId;
  return {
    id,
    title: raw.title,
    author: raw.author,
    cardUrl: raw.cardUrl,
    textUrl: raw.textUrl,
    xhtmlUrl: raw.xhtmlUrl,
    titleReading: raw.titleReading,
    sortReading: raw.sortReading,
    contributors: raw.contributors,
    sourceMetadata: raw.sourceMetadata,
    workCopyrightFlags: raw.workCopyrightFlags,
    missingWorkCopyrightFlagRows: raw.missingWorkCopyrightFlagRows,
    catalogPersonCopyrightFlags: raw.catalogPersonCopyrightFlags,
    missingPersonCopyrightFlagRows: raw.missingPersonCopyrightFlagRows,
    incompleteContributorRows: raw.incompleteContributorRows,
    sourceMetadataConflicts: raw.sourceMetadataConflicts,
    catalogIssues: raw.catalogIssues,
    catalogRowCount: raw.catalogRowCount,
  };
}

export function calculateAozoraRightsWorkFactsSha256(work: AozoraRightsCatalogWork | Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(createAozoraRightsWorkFacts(work))).digest("hex");
}

export function parseAozoraSellableWorkFacts(value: unknown): Array<{ workId: string; factsSha256: string }> | null {
  if (!Array.isArray(value) || value.length > 50_000) return null;
  const result: Array<{ workId: string; factsSha256: string }> = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const raw = item as Record<string, unknown>;
    if (typeof raw.workId !== "string" || !/^\d{1,12}$/.test(raw.workId) || ids.has(raw.workId) ||
        typeof raw.factsSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.factsSha256)) return null;
    ids.add(raw.workId);
    result.push({ workId: raw.workId, factsSha256: raw.factsSha256 });
  }
  return result;
}
