import "server-only";

import { createClient } from "@supabase/supabase-js";

const ORDER_FILES_BUCKET = "amuhon-order-files";
const MAX_ADMIN_DOWNLOAD_BYTES = 40_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isExpectedOrderAssetPath(orderId: string, path: string, fileName: string): boolean {
  const parts = path.split("/");
  return (parts.length === 2 && parts[0] === orderId && parts[1] === fileName) ||
    (parts.length === 3 && parts[0] === orderId && UUID_PATTERN.test(parts[1]) && parts[2] === fileName);
}

export function createAdminServiceClient() {
  const rawUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !serviceRoleKey) return null;
  try {
    const url = new URL(rawUrl);
    const allowedProtocol = url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
    if (!allowedProtocol || url.username || url.password || url.search || url.hash || url.origin !== rawUrl.replace(/\/$/, "")) return null;
    return createClient(url.origin, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  } catch {
    return null;
  }
}

export type AdminAssetKind = "body_pdf" | "cover_png";

export async function fetchVerifiedAdminAsset(
  supabase: NonNullable<ReturnType<typeof createAdminServiceClient>>,
  orderId: string,
  asset: AdminAssetKind,
) {
  const { data: assetInfo, error } = await supabase.rpc("get_amuhon_admin_order_asset", {
    p_order_id: orderId,
    p_asset_kind: asset,
  });
  if (error || !assetInfo || typeof assetInfo !== "object" || Array.isArray(assetInfo)) return null;
  const info = assetInfo as Record<string, unknown>;
  const fileName = asset === "body_pdf" ? "body.pdf" : "cover.png";
  const contentType = asset === "body_pdf" ? "application/pdf" : "image/png";
  if (typeof info.storagePath !== "string" || !isExpectedOrderAssetPath(orderId, info.storagePath, fileName) ||
      info.contentType !== contentType ||
      typeof info.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(info.sha256)) return null;

  const rawUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !serviceRoleKey) return null;
  const url = new URL(rawUrl);
  const storageUrl = `${url.origin}/storage/v1/object/${ORDER_FILES_BUCKET}/${info.storagePath.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(storageUrl, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== contentType) return null;
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_ADMIN_DOWNLOAD_BYTES) {
      await response.body.cancel();
      return null;
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ADMIN_DOWNLOAD_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total < 1) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actualHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actualHash !== info.sha256) return null;
  return { bytes, fileName, contentType };
}
