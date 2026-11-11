export type StripeMode = "test" | "live";

export type StripeServerConfig = {
  mode: StripeMode;
  livemode: boolean;
  secretKey: string;
};

/** A mode must be explicit, and the secret-key prefix must agree with it. */
export function getStripeServerConfig(): StripeServerConfig | null {
  const mode = process.env.STRIPE_MODE;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if ((mode !== "test" && mode !== "live") || !secretKey || secretKey.length < 16) return null;

  const expectedPrefix = mode === "live" ? "sk_live_" : "sk_test_";
  if (!secretKey.startsWith(expectedPrefix)) return null;

  return { mode, livemode: mode === "live", secretKey };
}

export function isCheckoutSessionIdForMode(value: unknown, mode: StripeMode): value is string {
  return typeof value === "string" && (mode === "live"
    ? /^cs_live_[A-Za-z0-9]+$/.test(value)
    : /^cs_test_[A-Za-z0-9]+$/.test(value));
}
