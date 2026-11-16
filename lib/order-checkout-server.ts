import {
  createSupabaseServiceHeaders,
  getSupabaseServiceCredential,
  type SupabaseServiceCredential,
} from "./supabase-service-credential.ts";

export type SupabaseServerConfig = { url: URL; serviceCredential: SupabaseServiceCredential };
export type RpcResult = { ok: boolean; status: number; data: Record<string, unknown> | null };

export function getSupabaseServerConfig(): SupabaseServerConfig | null {
  const rawUrl = process.env.SUPABASE_URL;
  const serviceCredential = getSupabaseServiceCredential();
  if (!rawUrl || !serviceCredential) return null;
  try {
    const url = new URL(rawUrl);
    if ((url.protocol !== "https:" && url.hostname !== "localhost") || url.username || url.password || url.search || url.hash) return null;
    return { url, serviceCredential };
  } catch {
    return null;
  }
}

export async function callOrderRpc(
  config: SupabaseServerConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<RpcResult> {
  const response = await fetch(`${config.url.origin}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: createSupabaseServiceHeaders(config.serviceCredential, {
      "Content-Type": "application/json",
      Accept: "application/json",
    }),
    body: JSON.stringify(args),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, data };
}

export function isValidOrderId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function expectedOrderOrigin(request: Request): string | null {
  const configured = process.env.ORDER_APP_ORIGIN;
  const raw = configured || new URL(request.url).origin;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "https:" && url.hostname !== "localhost") || url.origin !== raw.replace(/\/$/, "")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function validOrderPostOrigin(request: Request): boolean {
  const expected = expectedOrderOrigin(request);
  return Boolean(expected && request.headers.get("origin") === expected);
}

export function validOrderReadOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") return false;
  const origin = request.headers.get("origin");
  return origin === null || origin === expectedOrderOrigin(request);
}
