// Kept in sync with src/catalog-navigation.ts; covered by catalog HTTP tests.
export function storefrontPath(category: string, name: string): string {
  const base = (category || 'Без категории').trim()
  const last = base.split(' / ').at(-1) || ''
  const isPhoneLeaf = (/смартфон|iphone/i.test(last) || /(?:^| \/ )смартфоны?(?: \/|$)/i.test(base))
    && !/аксессуар|чехл|стекл/i.test(base)
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


export function isSmartphonePath(path: string) {
  return /смартфон|smartphone/i.test(path) && !/аксессуар|чехол|чехлы|защитн|кабель/i.test(path)
}
