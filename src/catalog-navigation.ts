/**
 * Virtual shelves used only for navigation. The actual category name/GUID in
 * 1C, product URL, stock and 05.ru link do not change.
 */
export function storefrontPath(category: string, name: string): string {
  const base = (category || 'Без категории').trim()
  const last = base.split(' / ').at(-1) || ''
  const isPhoneLeaf = /смартфон|iphone/i.test(last) && !/аксессуар|чехл|стекл/i.test(base)
  if (!isPhoneLeaf) return base
  const iphone = name.match(/\b(?:Apple\s+)?iPhone\s*(\d{1,2})(?:\s*(Pro\s+Max|Pro|Plus|Air|Mini|e))?\b/i)
  if (iphone) {
    const variant = (iphone[2] || '').replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    const label = 'iPhone ' + iphone[1] + (variant ? ' ' + variant : '')
    if (last.toLowerCase() === label.toLowerCase()) return base
    return base + ' / ' + label
  }
  const xiaomi = name.match(/\b(?:Xiaomi|Redmi|Poco)\s+[\w-]+(?:\s+(?:Pro(?:\s+Max)?|Ultra|Plus|Lite|5G))?/i)
  if (xiaomi && !base.toLowerCase().endsWith(xiaomi[0].toLowerCase())) return base + ' / ' + xiaomi[0]
  const galaxy = name.match(/\b(?:Samsung\s+)?Galaxy\s+(?:S|A|Z)\d{2,3}(?:\s+(?:Ultra|Plus|FE|Fold|Flip))?/i)
  if (galaxy && !base.toLowerCase().endsWith(galaxy[0].toLowerCase())) return base + ' / ' + galaxy[0]
  return base
}

/** Short display label; never changes the 1C category path. */
export function browseLabel(name: string) { return name.replace(/^(?:Смартфоны|Телефоны)\s+(?=[\p{L}0-9])/iu, '') }

export type FeaturedPhone = {
  id: number; name: string; category: string; stockQty?: number; image: string
}

/** Popular is an inventory-based, deterministic display selection, not a sales statistic.
 * No fake products or out-of-stock SKUs are shown. Distribute spots across
 * brands so the first screen is not ten variants of the same iPhone.
 */
export function featuredProducts<T extends { id: number; name: string; category: string; brand?: string; stockQty?: number }>(products: T[], take = 10): T[] {
  const eligible = products.filter(product =>
    product.stockQty === undefined || product.stockQty > 0)
    .filter(product => !/чехол|стекл|кабел|зарядк|адаптер|переходник|держател|защитн.*пленк/i.test(product.name))
    .sort((a, b) => {
      const priority = (name: string) => /iphone|смартфон|galaxy|xiaomi|redmi|poco/i.test(name) ? 0
        : /ноутбук|macbook|планшет|ipad/i.test(name) ? 1 : 2
      return priority(a.name) - priority(b.name) || a.id - b.id
    })
  const result: T[] = []
  const seenBrands = new Map<string, number>()
  for (const item of eligible) {
    if (result.length >= take) break
    const brand = (item.brand || item.name.split(/\s+/)[0] || 'Другое').toLowerCase()
    if ((seenBrands.get(brand) || 0) >= 2) continue
    seenBrands.set(brand, (seenBrands.get(brand) || 0) + 1)
    result.push(item)
  }
  for (const item of eligible) {
    if (result.length >= take) break
    if (!result.some(selected => selected.id === item.id)) result.push(item)
  }
  return result
}

/** Actual Apple product photography, rather than custom SVG approximations.
 * Existing original photos uploaded to TEXHORU always take priority.
 * These are Apple CDN image URLs (not copied 05.ru media).
 * To make product shots independent from external networks, replace URLs with
 * properly licensed, locally hosted images in the product editor.
 */
export function featuredPhoneImage(name: string, image?: string) {
  if (image && !/\/products\/(?:phone|iphone-cut-[\w-]+)\.svg(?:\?|$)/.test(image)) return image
  if (!/\biphone\s*17\s*pro(?:\s*max)?\b/i.test(name)) return image || '/products/phone.svg'
  const size = /\bpro\s*max\b/i.test(name) ? 'iphone-17-pro-max' : 'iphone-17-pro'
  const color = /оранж|cosmic\s*orange|orange/i.test(name) ? 'cosmicorange'
    : /син|голуб|deep\s*blue|blue/i.test(name) ? 'deepblue'
    : 'silver'
  return 'https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/'
    + size + '-finish-select-' + color + '-202509?wid=900&hei=900&fmt=png-alpha'
}
