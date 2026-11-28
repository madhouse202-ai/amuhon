export type AozoraCommercialRightsClass = "A" | "B" | "C";

export type AozoraCommercialRightsSnapshot = {
  schema: "amuhon-aozora-commercial-rights/v1";
  classification: AozoraCommercialRightsClass;
  basis: "official_aozora_copyright_flags";
  reasons: string[];
  catalogFetchedAt: string;
  catalogSha256: string;
  policy?: { policyId: string; policyVersion: string; policySha256: string };
  workFactsSha256?: string;
  workCopyrightFlags: string[];
  missingWorkCopyrightFlagRows: number;
  catalogPersonCopyrightFlags: string[];
  missingPersonCopyrightFlagRows: number;
  incompleteContributorRows: number;
  catalogRowCount: number;
  sourceMetadataConflicts: string[];
  catalogIssues: string[];
  contributors: Array<{
    name: string;
    role: string;
    personIds: string[];
    copyrightFlags: string[];
    missingCopyrightFlagRows: number;
  }>;
};

export function parseAozoraCommercialRightsSnapshot(value: unknown): AozoraCommercialRightsSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const stringList = (candidate: unknown, maxItems = 100, maxLength = 500): candidate is string[] =>
    Array.isArray(candidate) && candidate.length <= maxItems && candidate.every((item) =>
      typeof item === "string" && item.length <= maxLength);
  const count = (candidate: unknown, minimum = 0) => Number.isInteger(candidate) && (candidate as number) >= minimum && (candidate as number) <= 100_000;
  const hasPolicyBinding = raw.policy !== undefined || raw.workFactsSha256 !== undefined;
  const policy = raw.policy && typeof raw.policy === "object" && !Array.isArray(raw.policy)
    ? raw.policy as Record<string, unknown>
    : null;
  if (hasPolicyBinding && (!policy || typeof policy.policyId !== "string" || !/^[A-Z0-9][A-Z0-9_-]{2,99}$/.test(policy.policyId) ||
      typeof policy.policyVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(policy.policyVersion) ||
      typeof policy.policySha256 !== "string" || !/^[a-f0-9]{64}$/.test(policy.policySha256) ||
      typeof raw.workFactsSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.workFactsSha256))) return null;
  if (raw.schema !== "amuhon-aozora-commercial-rights/v1" ||
      !["A", "B", "C"].includes(String(raw.classification)) ||
      raw.basis !== "official_aozora_copyright_flags" ||
      typeof raw.catalogFetchedAt !== "string" || !Number.isFinite(Date.parse(raw.catalogFetchedAt)) ||
      typeof raw.catalogSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.catalogSha256) ||
      !stringList(raw.reasons, 20, 100) || raw.reasons.length === 0 ||
      !stringList(raw.workCopyrightFlags, 20, 100) ||
      !count(raw.missingWorkCopyrightFlagRows) ||
      !stringList(raw.catalogPersonCopyrightFlags, 100, 100) ||
      !count(raw.missingPersonCopyrightFlagRows) || !count(raw.incompleteContributorRows) ||
      !count(raw.catalogRowCount, 1) ||
      !stringList(raw.sourceMetadataConflicts, 50, 100) || !stringList(raw.catalogIssues, 50, 100) ||
      !Array.isArray(raw.contributors) || raw.contributors.length > 20) return null;
  const contributors: AozoraCommercialRightsSnapshot["contributors"] = [];
  for (const candidate of raw.contributors) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const person = candidate as Record<string, unknown>;
    if (typeof person.name !== "string" || !person.name.trim() || person.name.length > 300 ||
        typeof person.role !== "string" || !person.role.trim() || person.role.length > 80 ||
        !stringList(person.personIds, 20, 12) || !stringList(person.copyrightFlags, 20, 100) ||
        !count(person.missingCopyrightFlagRows)) return null;
    contributors.push({
      name: person.name,
      role: person.role,
      personIds: person.personIds,
      copyrightFlags: person.copyrightFlags,
      missingCopyrightFlagRows: person.missingCopyrightFlagRows as number,
    });
  }
  return {
    schema: "amuhon-aozora-commercial-rights/v1",
    classification: raw.classification as AozoraCommercialRightsClass,
    basis: "official_aozora_copyright_flags",
    reasons: raw.reasons,
    catalogFetchedAt: raw.catalogFetchedAt,
    catalogSha256: raw.catalogSha256,
    ...(hasPolicyBinding ? {
      policy: {
        policyId: policy!.policyId as string,
        policyVersion: policy!.policyVersion as string,
        policySha256: policy!.policySha256 as string,
      },
      workFactsSha256: raw.workFactsSha256 as string,
    } : {}),
    workCopyrightFlags: raw.workCopyrightFlags,
    missingWorkCopyrightFlagRows: raw.missingWorkCopyrightFlagRows as number,
    catalogPersonCopyrightFlags: raw.catalogPersonCopyrightFlags,
    missingPersonCopyrightFlagRows: raw.missingPersonCopyrightFlagRows as number,
    incompleteContributorRows: raw.incompleteContributorRows as number,
    catalogRowCount: raw.catalogRowCount as number,
    sourceMetadataConflicts: raw.sourceMetadataConflicts,
    catalogIssues: raw.catalogIssues,
    contributors,
  };
}
