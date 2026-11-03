import "server-only";

import { authorizeAdminSubject } from "./admin-authorization.ts";
import { createSupabaseServerClient } from "./supabase/server.ts";

export type AdminAuthFailure = { allowed: false; status: 401 | 403 | 503; reason: string };
export type AdminAuthSuccess = { allowed: true; userId: string };

export async function requireAdmin(): Promise<AdminAuthSuccess | AdminAuthFailure> {
  const adminId = process.env.AMUHON_ADMIN_USER_ID;
  const initial = authorizeAdminSubject(adminId, null, false);
  if (!initial.allowed && initial.reason === "admin_id_unconfigured") {
    return { allowed: false, status: 503, reason: "admin_id_unconfigured" };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { allowed: false, status: 503, reason: "auth_not_configured" };
  try {
    const { data, error } = await supabase.auth.getClaims();
    const claims = data?.claims as Record<string, unknown> | undefined;
    if (error || !claims || claims.aud !== "authenticated" || claims.role !== "authenticated") {
      return { allowed: false, status: 401, reason: "unauthenticated" };
    }
    const decision = authorizeAdminSubject(adminId, claims.sub, true);
    if (decision.allowed) return decision;
    return {
      allowed: false,
      status: decision.reason === "forbidden" ? 403 : 401,
      reason: decision.reason,
    };
  } catch {
    return { allowed: false, status: 401, reason: "unauthenticated" };
  }
}

export function adminAuthFailureResponse(auth: AdminAuthFailure): Response {
  const message = auth.status === 503
    ? "管理機能は現在利用できません。"
    : auth.status === 403
      ? "管理者として許可されていません。"
      : "ログインしてください。";
  return Response.json({ error: message }, { status: auth.status, headers: { "Cache-Control": "no-store" } });
}

export function validAdminMutationOrigin(request: Request): boolean {
  const configuredOrigin = process.env.ORDER_APP_ORIGIN;
  if (!configuredOrigin) return false;
  try {
    const url = new URL(configuredOrigin);
    const expected = url.origin;
    const allowedProtocol = url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
    return allowedProtocol && expected === configuredOrigin.replace(/\/$/, "") &&
      request.headers.get("origin") === expected &&
      request.headers.get("sec-fetch-site") !== "cross-site";
  } catch {
    return false;
  }
}
