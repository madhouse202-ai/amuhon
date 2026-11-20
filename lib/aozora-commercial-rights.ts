import { validateAozoraCatalogUrl, type AozoraRightsCatalogWork } from "./aozora-edition.ts";
import { type AozoraCommercialRightsClass, type AozoraCommercialRightsSnapshot } from "./aozora-commercial-rights-schema.ts";

export { parseAozoraCommercialRightsSnapshot } from "./aozora-commercial-rights-schema.ts";
export type { AozoraCommercialRightsClass, AozoraCommercialRightsSnapshot } from "./aozora-commercial-rights-schema.ts";

const AUTHOR_ROLES = new Set(["著者", "作者", "原著者"]);

export function classifyAozoraCommercialRights(work: AozoraRightsCatalogWork): {
  classification: AozoraCommercialRightsClass;
  reasons: string[];
} {
  const allFlags = [...work.workCopyrightFlags, ...work.catalogPersonCopyrightFlags,
    ...work.contributors.flatMap((person) => person.copyrightFlags)];
  if (allFlags.includes("あり")) {
    return {
      classification: "C",
      reasons: [
        ...(work.workCopyrightFlags.includes("あり") ? ["work_copyright_flag_present"] : []),
        ...(work.catalogPersonCopyrightFlags.includes("あり") || work.contributors.some((person) => person.copyrightFlags.includes("あり"))
          ? ["person_copyright_flag_present"] : []),
      ],
    };
  }

  const reasons: string[] = [];
  if (work.workCopyrightFlags.length !== 1 || work.workCopyrightFlags[0] !== "なし" || work.missingWorkCopyrightFlagRows !== 0) {
    reasons.push("work_copyright_flag_unknown_missing_or_conflicting");
  }
  if (work.catalogPersonCopyrightFlags.length !== 1 || work.catalogPersonCopyrightFlags[0] !== "なし" ||
      work.missingPersonCopyrightFlagRows !== 0 || work.contributors.some((person) =>
        person.copyrightFlags.length !== 1 || person.copyrightFlags[0] !== "なし" || person.missingCopyrightFlagRows !== 0)) {
    reasons.push("person_copyright_flag_unknown_missing_or_conflicting");
  }
  if (!work.id || !/^\d{1,12}$/.test(work.id) || !work.title || work.catalogRowCount < 1 ||
      work.catalogIssues.length > 0 || work.incompleteContributorRows > 0) {
    reasons.push("catalog_identity_incomplete_or_conflicting");
  }
  if (work.contributors.length !== 1 || work.contributors[0]?.personIds.length !== 1 ||
      !AUTHOR_ROLES.has(work.contributors[0]?.role ?? "") || work.contributors[0]?.name !== work.author) {
    reasons.push("initial_single_author_scope_not_met");
  }
  if (work.sourceMetadataConflicts.length > 0) reasons.push("source_metadata_conflict");
  if (!validateAozoraCatalogUrl(work.cardUrl, work.id, "card") ||
      !validateAozoraCatalogUrl(work.textUrl, work.id, "text") ||
      !validateAozoraCatalogUrl(work.xhtmlUrl, work.id, "xhtml")) {
    reasons.push("official_source_url_invalid");
  }
  return reasons.length === 0
    ? { classification: "A", reasons: ["official_flags_none_single_author_scope"] }
    : { classification: "B", reasons: [...new Set(reasons)] };
}

export function createAozoraCommercialRightsSnapshot(
  work: AozoraRightsCatalogWork,
  catalog: { fetchedAt: string; sha256: string },
): AozoraCommercialRightsSnapshot {
  const result = classifyAozoraCommercialRights(work);
  return {
    schema: "amuhon-aozora-commercial-rights/v1",
    classification: result.classification,
    basis: "official_aozora_copyright_flags",
    reasons: result.reasons,
    catalogFetchedAt: catalog.fetchedAt,
    catalogSha256: catalog.sha256,
    workCopyrightFlags: [...work.workCopyrightFlags],
    missingWorkCopyrightFlagRows: work.missingWorkCopyrightFlagRows,
    catalogPersonCopyrightFlags: [...work.catalogPersonCopyrightFlags],
    missingPersonCopyrightFlagRows: work.missingPersonCopyrightFlagRows,
    incompleteContributorRows: work.incompleteContributorRows,
    catalogRowCount: work.catalogRowCount,
    sourceMetadataConflicts: [...work.sourceMetadataConflicts],
    catalogIssues: [...work.catalogIssues],
    contributors: work.contributors.map((person) => ({
      name: person.name,
      role: person.role,
      personIds: [...person.personIds],
      copyrightFlags: [...person.copyrightFlags],
      missingCopyrightFlagRows: person.missingCopyrightFlagRows,
    })),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Compare per-work official facts without treating a global catalog refresh as a rights change. */
export function sameAozoraRightsFacts(
  left: AozoraCommercialRightsSnapshot,
  right: AozoraCommercialRightsSnapshot,
): boolean {
  const withoutCatalogAudit = (value: AozoraCommercialRightsSnapshot) => {
    return Object.fromEntries(Object.entries(value).filter(([key]) =>
      key !== "catalogFetchedAt" && key !== "catalogSha256"));
  };
  return stableJson(withoutCatalogAudit(left)) === stableJson(withoutCatalogAudit(right));
}

export const AOZORA_ATTRIBUTION_NOTICE =
  "このファイルは、インターネットの図書館、青空文庫（https://www.aozora.gr.jp/）で作られました。入力、校正、制作にあたったのは、ボランティアの皆さんです。";
