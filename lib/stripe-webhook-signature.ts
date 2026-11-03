import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_TOLERANCE_SECONDS = 300;

export function verifyStripeWebhookSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader || !secret.startsWith("whsec_") || secret.length < 16) return false;
  const fields = signatureHeader.split(",");
  const timestamps = fields.filter((field) => field.startsWith("t=")).map((field) => field.slice(2));
  const signatures = fields.filter((field) => field.startsWith("v1=")).map((field) => field.slice(3));
  if (timestamps.length !== 1 || signatures.length < 1 || !/^\d{1,12}$/.test(timestamps[0])) return false;
  const timestamp = Number(timestamps[0]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const candidate = Buffer.from(signature, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}
