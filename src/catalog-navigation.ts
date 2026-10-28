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

/** Curated from REAL 1C inventory, not invented products or stale 05.ru prices. */
export function featuredIphones<T extends FeaturedPhone>(products: T[], take = 10): T[] {
  const rank = (name: string) => /iphone\s*17\s*pro\s*max/i.test(name) ? 0
    : /iphone\s*17\s*pro\b/i.test(name) ? 1
    : /iphone\s*17\b/i.test(name) ? 2
    : /iphone\s*16\s*pro\s*max/i.test(name) ? 3
    : /iphone\s*16\s*pro\b/i.test(name) ? 4
    : 5
  const variants = products.filter(p => /iphone\s*\d+/i.test(p.name)
    && (p.stockQty === undefined || p.stockQty > 0))
    .sort((a,b) => rank(a.name)-rank(b.name) || a.id-b.id)
  // A balanced first two rows, rather than ten almost-identical Pro Max SKUs.
  const quotas = [3, 4, 2, 1, 1, take]
  const selected: T[] = []
  const used = new Set<number>()
  for (let group = 0; group < quotas.length; group++) {
    for (const item of variants.filter(v => rank(v.name) === group).slice(0, quotas[group])) {
      if (selected.length >= take) break
      selected.push(item)
      used.add(item.id)
    }
  }
  for (const item of variants) {
    if (selected.length >= take) break
    if (!used.has(item.id)) { selected.push(item); used.add(item.id) }
  }
  return selected
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
