/** Prices are integer RUB. Unknown purchase cost must never authorize an automatic write. */
export function knownPurchasePrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
export function retailPrice(competitorPrice: number | null | undefined, purchasePrice: unknown): number | null {
  if (!knownPurchasePrice(purchasePrice) || !Number.isSafeInteger(competitorPrice) || competitorPrice! <= 0) return null
  const result = Math.max(competitorPrice! - 100, purchasePrice)
  return result > 0 && result <= 5_000_000 ? result : null
}
