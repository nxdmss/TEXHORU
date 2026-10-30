import { createHash } from 'node:crypto'

export type Identity = {
  brand?: string; model?: string; storage?: string; ram?: string; color?: string; sim?: string
  gtin?: string; mpn?: string; condition?: string; kind?: string
}
type Item = {
  name: string; brand?: string | null; gtin?: string | null; mpn?: string | null
  attributes?: unknown; specs?: unknown; category?: string | { name?: string } | null
}

export function normalize(value: string) {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
}

const colors: Array<[RegExp, string]> = [
  [/cosmic orange|orange|оранж\w*/i, 'orange'], [/deep blue|blue|син\w*|голуб\w*/i, 'blue'],
  [/black|черн\w*/i, 'black'], [/white|бел\w*/i, 'white'], [/silver|сереб\w*/i, 'silver'],
  [/gold|золот\w*/i, 'gold'], [/green|зелен\w*/i, 'green'], [/purple|фиолет\w*/i, 'purple'],
  [/pink|розов\w*/i, 'pink'], [/gray|grey|серый|серая/i, 'gray'],
]

function categoryLabel(item: Item) {
  return typeof item.category === 'string' ? item.category : item.category?.name || ''
}

function productKind(item: Item): string | undefined {
  const text = normalize(categoryLabel(item) + ' ' + item.name)
  if (/(?:чехол|чехлы|накладка|бампер|case|cover|bumper)/.test(text)) return 'case'
  if (/(?:защитн\w* стекл\w*|стекл\w*|пленк\w*|screen protector|tempered glass|protector)/.test(text)) return 'screen-protector'
  if (/(?:ремеш\w*|strap|watch band)/.test(text)) return 'watch-strap'
  if (/(?:зарядн\w*|charger|адаптер питания|power adapter)/.test(text)) return 'charger'
  if (/(?:кабель|cable|провод usb)/.test(text)) return 'cable'
  if (/(?:наушник|headphone|earbud|гарнитур)/.test(text)) return 'headphones'
  if (/(?:смарт часы|умные часы|smartwatch|smart watch|watch|часы)/.test(text)) return 'smartwatch'
  if (/(?:смартфон|smartphone|iphone|galaxy|(?:xiaomi|redmi|poco|samsung|honor|huawei|realme|oneplus|tecno|infinix|oppo|vivo|pixel|motorola|nothing)\s+(?:\d|[a-z]\d|note|spark|camon|pova))/i.test(text)) return 'smartphone'
  if (/(?:планшет|tablet|ipad)/.test(text)) return 'tablet'
  if (/(?:ноутбук|laptop|macbook)/.test(text)) return 'laptop'
  return undefined
}

function canonicalBrand(value: string): string {
  const brand = normalize(value)
  if (/\b(?:apple|iphone)\b/.test(brand)) return 'apple'
  if (/\b(?:samsung|galaxy)\b/.test(brand)) return 'samsung'
  if (/\b(?:xiaomi|redmi)\b/.test(brand)) return 'xiaomi'
  return brand
}

export function identity(item: Item): Identity {
  const text = normalize(item.name.replace(/\b([sa]\d{1,3})\+/gi, '$1 plus')).replace(/айфон/g, 'iphone').replace(/(?:^|\s)пм(?=\s|$)/g, ' pro max').replace(/(?:^|\s)про макс(?=\s|$)/g, ' pro max').replace(/(?:^|\s)про(?=\s|$)/g, ' pro')
  const attrs = item.attributes && typeof item.attributes === 'object' ? item.attributes as Identity : {}
  const specs = Array.isArray(item.specs) ? item.specs as Array<{ label: string; value: string }> : []
  const spec = (pattern: RegExp) => specs.find(s => pattern.test(s.label.trim()))?.value
  const units = (value: string) => {
    const m = value.match(/(\d+(?:[.,]\d+)?)\s*(tb|тб|gb|гб)/i)
    return m ? String(Math.round(Number(m[1].replace(',', '.')) * (/tb|тб/i.test(m[2]) ? 1024 : 1))) : undefined
  }
  const storageText = attrs.storage || spec(/встроенн|объем накоп|storage/i)
  const capacities = [...text.matchAll(/(\d+)\s*(gb|гб|tb|тб)/g)].map(m => units(m[0])!)
  // 1C frequently uses 12/512 without a unit after the storage value.
  const compactMemory = text.match(/\b(?:4|6|8|12|16|18|24|32)\s+(128|256|512|1024)\b/)
  const bareStorage = /iphone/.test(text) ? text.match(/\b(128|256|512|1024)\b/)?.[1]
    : /xiaomi|redmi|poco|galaxy|samsung|honor|huawei|pixel|realme|oneplus|tecno|infinix|nothing/.test(text) ? compactMemory?.[1] : undefined
  const storage = storageText ? units(storageText) || (/^\d+$/.test(storageText) ? storageText : undefined) : capacities.length ? capacities.at(-1) : bareStorage
  const ramText = attrs.ram || spec(/оперативн|ram/i)
  const ram = ramText ? units(ramText) || (/^\d+$/.test(ramText) ? ramText : undefined)
    : capacities.length > 1 ? capacities[0]
    : compactMemory ? text.match(/\b(4|6|8|12|16|18|24|32)\s+(?:128|256|512|1024)\b/)?.[1] : undefined
  const model = attrs.model || text.match(/\biphone\s*\d{1,2}(?:\s*(?:pro max|pro|plus|mini|air|e))?\b/)?.[0]
    || text.match(/\b(?:galaxy\s*)?(?:s|a|z)\d{1,3}(?:\s*(?:ultra|plus|fe|fold|flip))?\b/)?.[0]
    // Without these, Xiaomi 15, 15T, 15T Pro and 15 Ultra are all treated
    // as model-less and can be incorrectly considered interchangeable.
    || text.match(/\bxiaomi\s+\d{1,2}t?(?:\s+(?:pro(?:\s+max)?|ultra|lite|plus))?\b/)?.[0]
    || text.match(/\b(?:xiaomi\s+)?redmi\s+(?:note\s+)?\d{1,2}(?:\s+(?:pro(?:\s+plus)?|plus|5g|4g))?\b/)?.[0]
    || text.match(/\bpoco\s+[a-z]\d{1,2}(?:\s+(?:pro|ultra|plus))?\b/)?.[0]
    // Smartwatch families and vendor model codes (e.g. XPAW002, C60).
    || text.match(/\bactive\s+2r\b/)?.[0]
    || text.match(/\b(?:watch|часы)\s+[a-z]?\d{1,3}[a-z]?(?:\s+(?:active|pro|max|ultra|classic|plus|lite|fe|se))?\b/)?.[0]
    || text.match(/\b[a-z]{1,5}\d{2,5}[a-z]?\b/)?.[0]
    || undefined
  // A broad /цвет|color/ pattern also matches unrelated attributes like
  // "Количество цветов экрана" or "Цветовая температура", leading to
  // false variant mismatches. Only explicit body/phone colour is authoritative.
  const colorText = attrs.color || spec(/^(?:цвет|цвет корпуса|основной цвет|цвет устройства|цвет телефона|color|body color)$/i) || text
  const color = colors.find(([re]) => re.test(colorText))?.[1] || (attrs.color ? normalize(attrs.color) : undefined)
  const simText = normalize(attrs.sim || spec(/тип sim|сим|sim карт/i) || text)
  const hasEsim = /e\s*sim|esim/.test(simText)
  const physical = /nano\s*sim|physical|физическ|\bsim\s*(?:\+|и)?\s*e\s*sim/.test(simText)
  const sim = hasEsim && physical ? 'physical+esim' : hasEsim ? 'esim' : /nano\s*sim|dual sim|2 sim/.test(simText) ? 'physical' : undefined
  const brandText = normalize(attrs.brand || item.brand || '')
  const knownBrand = ['apple', 'samsung', 'xiaomi', 'honor', 'huawei', 'oneplus', 'google', 'realme', 'poco', 'tecno', 'infinix', 'nothing', 'mibro', 'amazfit', 'garmin', 'fitbit', 'oppo', 'vivo', 'motorola', 'nokia', 'itel', 'blackview', 'doogee', 'cubot', 'haylou', 'zeblaze', 'cmf'].find(b => text.includes(b))
  const inferredBrand = /iphone/.test(text) ? 'apple' : /galaxy/.test(text) ? 'samsung' : knownBrand
  // Explicit 1C brand belongs to the product. Do not replace accessory makers
  // with Apple just because the title also contains an iPhone model.
  const brand = brandText && brandText !== 'без бренда' ? canonicalBrand(brandText) : inferredBrand
  const kind = productKind(item)
  const condition = /восстановлен|refurb|б\/у|уценен|витринн|used/i.test(item.name) ? 'used' : attrs.condition
  const gtinRaw = item.gtin || attrs.gtin || spec(/ean|gtin|штрихкод/i)
  const gtin = gtinRaw ? validGtin(gtinRaw) : undefined
  const mpn = item.mpn || attrs.mpn || spec(/заводск.*артикул|mpn/i)
  return { brand, model: model ? normalize(model) : undefined, storage, ram, color, sim, gtin, mpn: mpn ? normalize(mpn) : undefined, condition, kind }
}

export function validGtin(raw: string) {
  const s = raw.replace(/\s/g, '')
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(s)) return undefined
  let sum = 0
  for (let i = s.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += Number(s[i]) * weight
  return (10 - sum % 10) % 10 === Number(s.at(-1)) ? s.padStart(14, '0') : undefined
}

export function fingerprint(item: Item) {
  return createHash('sha256').update(JSON.stringify([normalize(item.name), identity(item)])).digest('hex')
}

export function compareItems(ours: Item, theirs: Item) {
  const a = identity(ours), b = identity(theirs)
  const reasons: string[] = [], conflicts: string[] = [], missing: string[] = []
  const labels: Record<string, string> = { brand: 'бренд', model: 'модель', storage: 'память', ram: 'ОЗУ', color: 'цвет', sim: 'SIM', gtin: 'штрихкод', mpn: 'MPN', condition: 'состояние', kind: 'тип товара' }
  const nameA = identity({ name: ours.name }), nameB = identity({ name: theirs.name })
  for (const key of ['model', 'storage', 'color', 'sim'] as Array<keyof Identity>) {
    if ((nameA[key] && a[key] && nameA[key] !== a[key]) || (nameB[key] && b[key] && nameB[key] !== b[key])) conflicts.push(`${labels[key]}: название противоречит характеристикам`)
  }
  for (const key of Object.keys(labels) as Array<keyof Identity>) {
    if (a[key] && b[key]) (a[key] === b[key] ? reasons : conflicts).push(labels[key])
  }
  if ((a.condition === 'used') !== (b.condition === 'used')) conflicts.push('новый / восстановленный')
  const exactId = Boolean((a.gtin && a.gtin === b.gtin) || (a.mpn && a.mpn === b.mpn))
  const phone = Boolean(a.kind === 'smartphone' || a.model?.includes('iphone') || a.brand === 'samsung' || /смартфон|телефон/i.test(ours.name))
  for (const key of (phone ? ['model', 'storage', 'color', 'sim'] : ['model']) as Array<keyof Identity>) {
    if (!a[key] || !b[key]) missing.push(labels[key])
  }
  const wordsA = new Set(normalize(ours.name).split(' ')), wordsB = new Set(normalize(theirs.name).split(' '))
  const common = [...wordsA].filter(w => wordsB.has(w)).length
  const similarity = common / Math.max(wordsA.size, wordsB.size, 1)
  const score = conflicts.length ? 0 : exactId ? 100 : Math.min(94, Math.round(similarity * 50 + reasons.length * 8))
  return { score, reasons, conflicts, missing, exactId, canAutoConfirm: Boolean(!conflicts.length && ((a.gtin && a.gtin === b.gtin) || (a.mpn && a.mpn === b.mpn && !missing.length))), ours: a, theirs: b }
}

export function recommendation(input: { latestPrice?: number | null; inStock?: boolean | null; lastError?: string | null; lastSuccessAt?: Date | null }, product?: { price: number; costPrice?: number | null } | null) {
  const reasons: string[] = []
  if (!input.latestPrice || input.latestPrice <= 0) reasons.push('нет цены')
  if (input.inStock !== true) reasons.push('наличие не подтверждено')
  if (input.lastError) reasons.push('последняя проверка с ошибкой')
  if (!input.lastSuccessAt || Date.now() - input.lastSuccessAt.getTime() > 24 * 3600_000) reasons.push('данные старше 24 часов')
  if (!product) reasons.push('товар не сопоставлен')
  if (!product?.costPrice) reasons.push('не задана себестоимость в 1С')
  const proposed = input.latestPrice ? Math.max(1, input.latestPrice - 500) : null
  if (product && proposed && Math.abs(proposed - product.price) > product.price * 0.1) reasons.push('изменение больше 10%')
  if (product?.costPrice && proposed && proposed < product.costPrice) reasons.push('ниже себестоимости')
  return { recommendedPrice: reasons.length ? null : proposed, recommendationReasons: reasons }
}
