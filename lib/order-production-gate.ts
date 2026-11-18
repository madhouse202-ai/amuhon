type RuntimeEnvironment = Record<string, string | undefined>;

/**
 * Until the pre-payment server renderer is connected, production must not use
 * the legacy buyer-supplied PDF/PNG flow. Local development keeps the existing
 * test path available; production fails closed.
 */
export function isLegacyBuyerAssetFlowEnabled(env: RuntimeEnvironment = process.env): boolean {
  return env.NODE_ENV !== "production";
}
