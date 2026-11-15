/**
 * Virtual shelves used only for navigation. The actual category name/GUID in
 * 1C, product URL, stock and 05.ru link do not change.
 */
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

/** Locally hosted product images. Match model AND colour; preserve uploaded photos. */
const iphonePhotoColors: Record<string, readonly string[]> = {
  '11': ['black'],
  '11-pro-max': ['graphite'],
  '12': ['blue'],
  '13': ['black', 'white', 'blue'],
  '14': ['black', 'white'],
  '15': ['black', 'pink', 'blue'],
  '16': ['black', 'white', 'green', 'pink', 'ultramarine'],
  '16e': ['black'],
  '17': ['black', 'white', 'blue', 'green'],
  'air': ['black'],
  '17-pro': ['white', 'blue', 'orange'],
  '17-pro-max': ['white', 'blue', 'orange'],
}
const pilotWebpPhotos = new Set(['11-black', '11-pro-max-graphite', '16-ultramarine'])
export function featuredPhoneImage(name: string, image?: string) {
  if (image && !/\/products\/(?:phone(?:-alt)?|iphone-cut-[\w-]+)\.svg(?:[?#]|$)/.test(image)) return image
  const fallback = image || '/products/phone.svg'
  if (/чехол|накладк|стекл|кабел|пленк|плёнк|защитн|линз|\b(?:case|cover|glass|protector)\b/i.test(name)) return fallback

  if (/\bhonor\s*600\b(?!\s*pro)/i.test(name) && /ч[её]рн|black|графит|graphite/i.test(name)) {
    return '/products/honor/honor-600-black.webp'
  }
  if (/\bhonor\s*x9d\b/i.test(name) && /ч[её]рн|black|графит|graphite/i.test(name)) {
    return '/products/honor/honor-x9d-graphite.webp'
  }

  const match = name.match(/\biphone\s*(1[1-7])\s*(pro\s*max|pro|plus|mini|air|e)?\b/i)
  const variant = (match?.[2] || '').toLowerCase().replace(/\s+/g, '-')
  const model = /\biphone\s+air\b/i.test(name) || match?.[1] === '17' && variant === 'air' ? 'air'
    : match ? match[1] + (variant === 'e' ? 'e' : variant ? '-' + variant : '') : ''
  const colour = /оранж|orange/i.test(name) ? 'orange'
    : /ч[её]рн|black|midnight/i.test(name) ? 'black'
    : /графит|graphite/i.test(name) ? 'graphite'
    : /бел|white|silver|starlight|серебр/i.test(name) ? 'white'
    : /розов|pink/i.test(name) ? 'pink'
    : /зел[её]н|green|teal|sage/i.test(name) ? 'green'
    : /ультрамарин|ultramarine/i.test(name) ? 'ultramarine'
    : /син|голуб|blue/i.test(name) ? 'blue' : ''
  if (!iphonePhotoColors[model]?.includes(colour)) return fallback
  const key = `${model}-${colour}`
  return `/products/apple/iphone-${key}.${pilotWebpPhotos.has(key) ? 'webp' : 'png'}`
}
