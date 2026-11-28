import type { AozoraRightsCatalogWork } from "./aozora-edition.ts";
import { classifyAozoraCommercialRights } from "./aozora-commercial-rights.ts";
import { calculateAozoraRightsWorkFactsSha256 } from "./aozora-rights-policy.ts";

export type AozoraApprovedScopeMember = { workId: string; factsSha256: string };

/** Keeps only official-A works whose current catalog facts match the reviewed scope. */
export function filterAozoraWorksByApprovedScope(
  catalog: AozoraRightsCatalogWork[],
  scope: AozoraApprovedScopeMember[],
): AozoraRightsCatalogWork[] {
  const approved = new Map(scope.map((item) => [item.workId, item.factsSha256]));
  return catalog.filter((work) => classifyAozoraCommercialRights(work).classification === "A" &&
    approved.get(work.id) === calculateAozoraRightsWorkFactsSha256(work));
}
