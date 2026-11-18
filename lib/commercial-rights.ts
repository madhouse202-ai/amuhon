export type ApprovedWorkNotice = { workId: string; sourceSha256: string; conditions: string };
export type CommercialRightsApproval = { approved: boolean; notices: ApprovedWorkNotice[] };

/** Parse the order-bound RPC, which intentionally returns only a decision bit. */
export function parseCommercialRightsDecision(value: unknown): boolean | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== 1 || typeof result.approved !== "boolean") return null;
  return result.approved;
}

/** Parse the service-only approval response and bounded, ledger-sourced print notices. */
export function parseCommercialRightsApproval(value: unknown): CommercialRightsApproval | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !["approved", "notices"].includes(key)) ||
      typeof result.approved !== "boolean" || !Array.isArray(result.notices) || result.notices.length > 100) return null;
  const notices: ApprovedWorkNotice[] = [];
  for (const value of result.notices) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const notice = value as Record<string, unknown>;
    if (Object.keys(notice).some((key) => !["workId", "sourceSha256", "conditions"].includes(key)) ||
        typeof notice.workId !== "string" || !/^\d{1,12}$/.test(notice.workId) ||
        typeof notice.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(notice.sourceSha256) ||
        typeof notice.conditions !== "string" || !notice.conditions.trim() || notice.conditions.length > 1000) return null;
    notices.push({ workId: notice.workId, sourceSha256: notice.sourceSha256, conditions: notice.conditions });
  }
  if (result.approved && notices.length === 0) return null;
  if (!result.approved && notices.length !== 0) return null;
  if (new Set(notices.map((notice) => notice.workId)).size !== notices.length) return null;
  return { approved: result.approved, notices };
}
