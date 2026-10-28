import { identity, normalize } from '../price-monitor/product-matching'

type Variant = {
  name: string
  brand?: string | null
  gtin?: string | null
  mpn?: string | null
  attributes?: unknown
  category?: { name: string } | null
  categoryName?: string | null
}

/**
 * Conservative exact-phone-variant key. Do not collapse merely similar names
 * (e.g. Pro / Pro Max or 256 / 512, different colours, SIM or condition).
 * 1C GUID/SKU is intentionally NOT part of this key: duplicate records can
 * have different GUIDs, but they must not create identical storefront cards.
 */
export function phoneVariantKey(item: Variant): string | null {
  const category = item.categoryName || item.category?.name || ''
  if (!/(?:смартфон|smartphone)/i.test(category)) return null
  const key = identity(item)
  // Without variant details there is not enough evidence to merge 1C SKUs.
  if (!key.model || !key.storage || !key.color) return null
  return JSON.stringify([
    normalize(category), normalize(item.name),
    key.brand || normalize(item.brand || ''),
    key.model, key.storage, key.ram || '',
    key.color, key.sim || '', key.condition || '',
    key.gtin || '', key.mpn || '',
  ])
}

/** Stable first-observed representative; records are never deleted. */
export function uniquePhoneProducts<T extends Variant>(rows: T[]): T[] {
  const seen = new Set<string>()
  return rows.filter(row => {
    const key = phoneVariantKey(row)
    if (!key) return true
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
