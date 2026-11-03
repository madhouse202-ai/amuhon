const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AdminAuthorization =
  | { allowed: true; userId: string }
  | { allowed: false; reason: "admin_id_unconfigured" | "unauthenticated" | "forbidden" };

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function authorizeAdminSubject(configuredAdminId: string | undefined, subject: unknown, authenticated: boolean): AdminAuthorization {
  if (!configuredAdminId || configuredAdminId.trim() !== configuredAdminId || !isUuid(configuredAdminId)) {
    return { allowed: false, reason: "admin_id_unconfigured" };
  }
  if (!authenticated || !isUuid(subject)) return { allowed: false, reason: "unauthenticated" };
  if (subject.toLowerCase() !== configuredAdminId.toLowerCase()) return { allowed: false, reason: "forbidden" };
  return { allowed: true, userId: subject.toLowerCase() };
}

export type AdminOrderAccessState = {
  status: string;
  assetsVerified: boolean;
  fulfillmentStatus: string;
};

export function canDownloadAdminOrderAssets(order: AdminOrderAccessState): boolean {
  return order.status === "paid" && order.assetsVerified;
}

export function canMarkOrderSubmitted(order: AdminOrderAccessState): boolean {
  return canDownloadAdminOrderAssets(order) && order.fulfillmentStatus === "not_submitted";
}
