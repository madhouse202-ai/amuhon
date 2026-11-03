export type OrderPrice = { pageCount: number; amountYen: number; currency: "JPY" };

const PRICE_BANDS = [
  { min: 24, max: 100, amountYen: 1_980 },
  { min: 101, max: 150, amountYen: 2_280 },
  { min: 151, max: 200, amountYen: 2_580 },
  { min: 201, max: 250, amountYen: 2_880 },
  { min: 251, max: 300, amountYen: 3_180 },
] as const;

/** Display-only mirror of the authoritative pricing RPC. Never use this result to charge. */
export function quoteOrderPrice(pageCount: number): OrderPrice | null {
  if (!Number.isSafeInteger(pageCount)) return null;
  const band = PRICE_BANDS.find(({ min, max }) => pageCount >= min && pageCount <= max);
  return band ? { pageCount, amountYen: band.amountYen, currency: "JPY" } : null;
}
