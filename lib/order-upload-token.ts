import { createHash, timingSafeEqual } from "node:crypto";

export function hashOrderUploadToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isValidOrderUploadToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function equalHexDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
