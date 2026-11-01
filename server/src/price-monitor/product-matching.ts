import { createHash } from 'node:crypto'

export type Identity = {
  brand?: string; compatibleBrand?: string; model?: string; productCode?: string
  storage?: string; ram?: string; color?: string; sim?: string
  cpu?: string; gpu?: string; screenSize?: string; wattage?: string
  gtin?: string; mpn?: string; condition?: string; kind?: string
}
type Item = {
  name: string; brand?: string | null; gtin?: string | null; mpn?: string | null
  shortSpec?: string | null; attributes?: unknown; specs?: unknown; category?: string | { name?: string } | null
}

export function normalize(value: string) {
  return value.toLowerCase().replace(/ё/g, 'е')
    .replace(/\b(?:iphone|ip)\s*(\d{1,2})\s*(pro\s*max|pro|plus|mini)?/g, (_, number, variant) => 'iphone ' + number + (variant ? ' ' + variant.replace(/pro\s*max/, 'pro max') + ' ' : ' '))
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
}

const colors: Array<[RegExp, string]> = [
  [/cosmic orange|orange|оранж\w*/i, 'orange'], [/deep blue|blue|син\w*|голуб\w*/i, 'blue'],
  [/black|черн\w*/i, 'black'], [/white|бел\w*/i, 'white'], [/silver|сереб\w*/i, 'silver'],
  [/gold|золот\w*/i, 'gold'], [/green|зелен\w*/i, 'green'], [/purple|фиолет\w*/i, 'purple'],
  [/pink|розов\w*/i, 'pink'], [/transparent|прозрачн\w*/i, 'transparent'], [/gray|grey|серый|серая/i, 'gray'],
]

function categoryLabel(item: Item) {
  return typeof item.category === 'string' ? item.category : item.category?.name || ''
}

function productKind(item: Item): string | undefined {
  const name = normalize(item.name)
  const category = normalize(categoryLabel(item))
  const text = category + ' ' + name

  // A watch listing often contains words such as "Black Case" and "TPU Strap".
  // The explicit device name/category must win over those included components.
  if (/(?:ремешок|watch band|strap for|strap для)/.test(name)) return 'watch-strap'
  if (/(?:смарт часы|умные часы|smartwatch|smart watch)/.test(name)
    || /\b(?:xiaomi|redmi|samsung|huawei|honor|amazfit|mibro|tecno|garmin)?\s*watch\s+\d/i.test(name)
    || /(?:смарт часы|умные часы|smartwatch|smart watch)/.test(category)) return 'smartwatch'

  if (/(?:чехол|чехлы|накладка|бампер|case|cover|bumper)/.test(text)) return 'case'
  if (/(?:защитн\w* стекл\w*|стекл\w*|пленк\w*|screen protector|tempered glass|protector)/.test(text)) return 'screen-protector'
  if (/(?:ремеш\w*|strap|watch band)/.test(text)) return 'watch-strap'
  if (/(?:зарядн\w*|(?:^|\s)сзу(?:\s|$)|charger|адаптер питания|power adapter)/.test(text)) return 'charger'
  if (/(?:кабель|cable|провод usb)/.test(text)) return 'cable'
  if (/(?:наушник|headphone|earbud|гарнитур)/.test(text)) return 'headphones'
  if (/(?:смарт часы|умные часы|smartwatch|smart watch|watch|часы)/.test(text)) return 'smartwatch'
  if (/(?:смартфон|smartphone|iphone|galaxy|(?:xiaomi|redmi|poco|samsung|honor|huawei|realme|oneplus|tecno|infinix|oppo|vivo|pixel|motorola|nothing)\s+(?:\d|[a-z]\d|note|spark|camon|pova))/i.test(text)) return 'smartphone'
  if (/(?:планшет|tablet|ipad)/.test(text)) return 'tablet'
  if (/(?:ноутбук|laptop|macbook|aspire|vivobook|ideapad|thinkpad|matebook|pavilion|inspiron|latitude|zenbook|elitebook|probook|predator|nitro|swift)/.test(text)) return 'laptop'
  return undefined
}

function canonicalBrand(value: string): string {
  const brand = normalize(value)
  if (/\b(?:apple|iphone)\b/.test(brand)) return 'apple'
  if (/\b(?:samsung|galaxy)\b/.test(brand)) return 'samsung'
  if (/\b(?:xiaomi|redmi)\b/.test(brand)) return 'xiaomi'
  return brand
}

function laptopPartNumber(name: string, brand?: string) {
  const patterns = [
    /\b[A-Z]{1,4}\d{2,4}[A-Z]{0,3}(?:-[A-Z0-9]{2,8})+\b/i,
    /\b\d{2}[A-Z]{2}\d{2}[A-Z0-9]{2,4}\b/i,
    /\b\d{5}[A-Z]{3}\b/i,
  ]
  for (const pattern of patterns) {
    const found = name.match(pattern)?.[0]
    if (found) return normalize(found)
  }
  if (brand === 'apple') return name.match(/\bA\d{4}\b/i)?.[0]?.toLowerCase()
  return undefined
}

function processorIdentity(value: string, brand?: string) {
  const text = normalize(value)
  const patterns: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
    [/\b(?:cel|celeron)\s*n\s*\d{4}\b/, m => 'celeron ' + m[0].match(/n\s*\d{4}/)![0].replace(/\s+/g, '')],
    [/\b(?:pentium(?:\s+silver)?|pentium)\s+n?\s*\d{4}\b/, m => m[0].replace(/\s+/g, ' ')],
    [/\b(?:intel\s+)?core\s*i?([3579])\s*-?\s*(\d{4,5}[a-z]{0,2})\b/, m => 'core i' + m[1] + ' ' + m[2]],
    [/\bi([3579])\s*-?\s*(\d{4,5}[a-z]{0,2})\b/, m => 'core i' + m[1] + ' ' + m[2]],
    [/\b(?:intel\s+)?core\s+([3579])\s+(\d{3,5}[a-z]{0,2})\b/, m => 'core ' + m[1] + ' ' + m[2]],
    [/\bryzen\s*([3579])\s*-?\s*(\d{4}[a-z]{0,2})\b/, m => 'ryzen ' + m[1] + ' ' + m[2]],
    [/\bapple\s+(m[1-5])\b/, m => m[1]],
  ]
  for (const [pattern, format] of patterns) {
    const match = text.match(pattern)
    if (match) return format(match)
  }
  if (brand === 'apple') {
    const appleChip = text.match(/\b(m[1-5])\b/)
    if (appleChip) return appleChip[1]
  }
  return undefined
}

function graphicsIdentity(value: string) {
  const text = normalize(value)
  return text.match(/\b(?:geforce\s+)?(?:rtx|gtx)\s*\d{3,4}(?:\s*ti)?\b/)?.[0]
    || text.match(/\bradeon\s+(?:rx\s*)?\d{3,4}[a-z]?\b/)?.[0]
    || text.match(/\b(?:intel\s+)?(?:uhd|iris\s+xe|arc)\s+graphics?\b/)?.[0]
    || undefined
}

export function identity(item: Item): Identity {
  const rawName = item.name || ''
  const text = normalize((rawName + ' ' + (item.shortSpec || '')).replace(/\b([sa]\d{1,3})\+/gi, '$1 plus')).replace(/айфон/g, 'iphone').replace(/(?:^|\s)пм(?=\s|$)/g, ' pro max').replace(/(?:^|\s)про макс(?=\s|$)/g, ' pro max').replace(/(?:^|\s)про(?=\s|$)/g, ' pro')
  const attrs = item.attributes && typeof item.attributes === 'object' ? item.attributes as Identity : {}
  const specs = Array.isArray(item.specs) ? item.specs as Array<{ label: string; value: string }> : []
  const spec = (pattern: RegExp) => specs.find(s => pattern.test(s.label.trim()))?.value
  const kind = attrs.kind || productKind(item)
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
  const partNumber = kind === 'laptop' ? laptopPartNumber(rawName, brandText || item.brand?.toLowerCase()) : undefined
  const laptopFamily = kind === 'laptop'
    ? text.match(/\b(?:macbook\s+(?:air|pro)|aspire|vivobook|ideapad|thinkpad|matebook|pavilion|inspiron|latitude|zenbook|elitebook|probook|predator|nitro|swift)\s*[a-z0-9-]*/)?.[0]
    : undefined
  const model = attrs.model || partNumber || laptopFamily || text.match(/\biphone\s*\d{1,2}(?:\s*(?:pro max|pro|plus|mini|air|e))?\b/)?.[0]
    || text.match(/\b(?:galaxy\s*)?(?:s|a|z)\d{1,3}(?:\s*(?:ultra|plus|fe|fold|flip))?\b/)?.[0]
    // Without these, Xiaomi 15, 15T, 15T Pro and 15 Ultra are all treated
    // as model-less and can be incorrectly considered interchangeable.
    || text.match(/\bxiaomi\s+\d{1,2}t?(?:\s+(?:pro(?:\s+max)?|ultra|lite|plus))?\b/)?.[0]
    || text.match(/\b(?:xiaomi\s+)?redmi\s+(?:note\s+)?\d{1,2}(?:\s+(?:pro(?:\s+plus)?|plus|5g|4g))?\b/)?.[0]
    || text.match(/\bpoco\s+[a-z]\d{1,2}(?:\s+(?:pro|ultra|plus))?\b/)?.[0]
    // Smartwatch families and vendor model codes (e.g. XPAW002, C60).
    || text.match(/\bactive\s+2r\b/)?.[0]
    || text.match(/\b(?:watch|часы)\s+[a-z]?\d{1,3}[a-z]?(?:\s+(?:active|pro|max|ultra|classic|plus|lite|fe|se))?\b/)?.[0]
    // Generic alphanumeric codes on cases/protectors are usually accessory SKUs,
    // not the phone model the accessory is compatible with.
    || (!['case', 'screen-protector'].includes(kind || '') ? text.match(/\b[a-z]{1,5}\d{2,5}[a-z]?\b/)?.[0] : undefined)
    || undefined
  // A broad /цвет|color/ pattern also matches unrelated attributes like
  // "Количество цветов экрана" or "Цветовая температура", leading to
  // false variant mismatches. Only explicit body/phone colour is authoritative.
  const colorName = text.replace(/\bgreen lion\b/g, '').replace(/\bgreen(?=\s+(?:9h|3d)\b)/g, '')
  const colorText = attrs.color || spec(/^(?:цвет|цвет корпуса|основной цвет|цвет устройства|цвет телефона|color|body color)$/i) || colorName
  const color = colors.find(([re]) => re.test(colorText))?.[1] || (attrs.color ? normalize(attrs.color) : undefined)
  const simText = normalize(attrs.sim || spec(/тип sim|сим|sim карт/i) || text)
  const hasEsim = /e\s*sim|esim/.test(simText)
  const physical = /nano\s*sim|physical|физическ|\bsim\s*(?:\+|и)?\s*e\s*sim/.test(simText)
  const sim = hasEsim && physical ? 'physical+esim' : hasEsim ? 'esim' : /nano\s*sim|dual sim|2 sim/.test(simText) ? 'physical' : undefined
  const brandText = normalize(attrs.brand || item.brand || '')
  const knownBrand = ['apple', 'samsung', 'xiaomi', 'honor', 'huawei', 'oneplus', 'google', 'realme', 'poco', 'tecno', 'infinix', 'nothing', 'mibro', 'amazfit', 'garmin', 'fitbit', 'oppo', 'vivo', 'motorola', 'nokia', 'itel', 'blackview', 'doogee', 'cubot', 'haylou', 'zeblaze', 'cmf', 'acer', 'asus', 'lenovo', 'msi', 'dell', 'hp'].find(b => text.includes(b))
  const accessory = ['case', 'screen-protector', 'watch-strap', 'charger', 'cable'].includes(kind || '')
  const accessoryMaker = accessory && /\bgreen lion\b/.test(text) ? 'green lion' : undefined
  const inferredBrand = accessory ? accessoryMaker : /iphone/.test(text) ? 'apple' : /galaxy/.test(text) ? 'samsung' : knownBrand
  const usableBrand = brandText && !['без бренда', 'другие', 'other'].includes(brandText)
  const brand = accessoryMaker || (usableBrand ? canonicalBrand(brandText) : inferredBrand)
  const normalizedBrand = usableBrand ? canonicalBrand(brandText) : undefined
  const deviceBrand = /iphone/.test(text) ? 'apple'
    : /\b(?:samsung|galaxy)\b/.test(text) ? 'samsung'
    : /\b(?:xiaomi|redmi|poco)\b/.test(text) ? 'xiaomi'
    : knownBrand ? canonicalBrand(knownBrand) : undefined
  const compatibleBrand = accessory
    ? attrs.compatibleBrand || deviceBrand || (normalizedBrand && ['apple', 'samsung', 'xiaomi', 'honor', 'huawei', 'oneplus', 'google', 'realme', 'poco', 'tecno', 'infinix', 'oppo', 'vivo', 'motorola', 'nokia'].includes(normalizedBrand) ? normalizedBrand : undefined)
    : undefined
  const cpuRaw = String(attrs.cpu || spec(/процессор|cpu|processor|чипсет/i) || rawName)
  const gpuRaw = String(attrs.gpu || spec(/видеокарт|график|gpu|graphics|video card/i) || rawName)
  const cpu = processorIdentity(cpuRaw, brand)
  const gpu = graphicsIdentity(gpuRaw)
  const screenRaw = String(attrs.screenSize || spec(/диагонал|screen size|display size/i) || rawName)
  const screenSize = screenRaw.match(/\b(\d{1,2}(?:[.,]\d)?)\s*(?:["″]|дюйм\w*|inch\w*)/i)?.[1]?.replace(',', '.')
    || (/^\d{1,2}(?:[.,]\d)?$/.test(screenRaw.trim()) ? screenRaw.trim().replace(',', '.') : undefined)
  const powerRaw = String(attrs.wattage || spec(/мощност|power output|выходная мощность/i) || rawName)
  const wattage = kind === 'charger' ? powerRaw.match(/\b(\d{1,3})\s*w(?:att)?\b/i)?.[1] : undefined
  const condition = /восстановлен|refurb|б\/у|уценен|витринн|used/i.test(item.name) ? 'used' : attrs.condition
  const gtinRaw = item.gtin || attrs.gtin || spec(/ean|gtin|штрихкод/i)
  const gtin = gtinRaw ? validGtin(gtinRaw) : undefined
  const mpn = item.mpn || attrs.mpn || spec(/заводск.*артикул|mpn/i)
  return {
    brand, compatibleBrand, model: model ? normalize(model) : undefined,
    productCode: partNumber, storage, ram, color, sim, cpu, gpu, screenSize, wattage,
    gtin, mpn: mpn ? normalize(mpn) : undefined, condition, kind,
  }
}

export function validGtin(raw: string) {
  const s = raw.replace(/\s/g, '')
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(s)) return undefined
  let sum = 0
  for (let i = s.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += Number(s[i]) * weight
  return (10 - sum % 10) % 10 === Number(s.at(-1)) ? s.padStart(14, '0') : undefined
}

export function fingerprint(item: Item) {
  // A category relation is not always loaded by every Prisma query. Keep
  // confirmation fingerprints stable whether or not that relation is present.
  const parsed = identity({ ...item, category: undefined })
  // Keep existing confirmation fingerprints stable; compatibleBrand is an
  // additional matching signal, not a change to the stored product identity.
  delete parsed.compatibleBrand
  return createHash('sha256').update(JSON.stringify([normalize(item.name), parsed])).digest('hex')
}

export function canonicalModel(value?: string) {
  return value?.replace(/^galaxy\s+/, '')
}

export function compareItems(ours: Item, theirs: Item) {
  const a = identity(ours), b = identity(theirs)
  const reasons: string[] = [], conflicts: string[] = [], missing: string[] = []
  const labels: Record<string, string> = {
    brand: 'бренд', compatibleBrand: 'совместимость', model: 'модель', productCode: 'код производителя',
    storage: 'память', ram: 'ОЗУ', color: 'цвет', sim: 'SIM',
    cpu: 'процессор', gpu: 'видеокарта', screenSize: 'диагональ', wattage: 'мощность',
    gtin: 'штрихкод', mpn: 'MPN', condition: 'состояние', kind: 'тип товара',
  }
  const nameA = identity({ name: ours.name }), nameB = identity({ name: theirs.name })
  for (const key of ['model', 'storage', 'color', 'sim'] as Array<keyof Identity>) {
    const differs = (left?: string, right?: string) => key === 'model'
      ? canonicalModel(left) !== canonicalModel(right)
      : left !== right
    if ((nameA[key] && a[key] && differs(nameA[key], a[key])) || (nameB[key] && b[key] && differs(nameB[key], b[key]))) {
      conflicts.push(`${labels[key]}: название противоречит характеристикам`)
    }
  }
  for (const key of Object.keys(labels) as Array<keyof Identity>) {
    if (key === 'brand' && (
      ['case', 'screen-protector', 'watch-strap'].includes(a.kind || '')
      || ['case', 'screen-protector', 'watch-strap'].includes(b.kind || '')
    ) && (
      (a.brand && a.compatibleBrand && a.brand === a.compatibleBrand)
      || (b.brand && b.compatibleBrand && b.brand === b.compatibleBrand)
    )) continue
    if (a[key] && b[key]) {
      const same = key === 'model' ? canonicalModel(a.model) === canonicalModel(b.model) : a[key] === b[key]
      ;(same ? reasons : conflicts).push(labels[key])
    }
  }
  if ((a.condition === 'used') !== (b.condition === 'used')) conflicts.push('новый / восстановленный')
  const exactId = Boolean((a.gtin && a.gtin === b.gtin) || (a.mpn && a.mpn === b.mpn)
    || (a.productCode && a.productCode === b.productCode))
  const phone = a.kind === 'smartphone'
  const laptop = a.kind === 'laptop' || b.kind === 'laptop'
  for (const key of (phone ? ['model', 'storage', 'color', 'sim']
    : laptop ? ['model', 'productCode', 'cpu', 'gpu', 'ram', 'storage', 'screenSize']
    : ['model']) as Array<keyof Identity>) {
    if (!a[key] || !b[key]) missing.push(labels[key])
  }
  const wordsA = new Set(normalize(ours.name).split(' ')), wordsB = new Set(normalize(theirs.name).split(' '))
  const common = [...wordsA].filter(w => wordsB.has(w)).length
  const similarity = common / Math.max(wordsA.size, wordsB.size, 1)
  const score = conflicts.length ? 0 : exactId ? 100 : Math.min(94, Math.round(similarity * 50 + reasons.length * 8))
  return { score, reasons, conflicts, missing, exactId, canAutoConfirm: Boolean(!conflicts.length && ((a.gtin && a.gtin === b.gtin) || (a.mpn && a.mpn === b.mpn && !missing.length) || (phone && b.kind === 'smartphone' && !missing.length && a.brand && a.brand === b.brand && (!a.ram && !b.ram || a.ram === b.ram)))), ours: a, theirs: b }
}

/**
 * Wider recall for non-phone products. A review candidate is NOT a verified
 * mapping and must never be used to change or monitor the 1C selling price.
 * Explicitly different model, product type, GTIN/MPN or condition are rejected.
 * Missing data or differing weak attributes (maker/colour) may be reviewed.
 */
export function reviewCandidate(ours: Item, theirs: Item): { score: number; reasons: string[] } | null {
  const a = identity(ours), b = identity(theirs)
  if (a.kind === 'smartphone' || b.kind === 'smartphone') return null
  if (a.kind && b.kind && a.kind !== b.kind) return null
  if (a.model && b.model && canonicalModel(a.model) !== canonicalModel(b.model)) return null
  if (a.productCode && b.productCode && a.productCode !== b.productCode) return null
  if (a.cpu && b.cpu && a.cpu !== b.cpu) return null
  if (a.gpu && b.gpu && a.gpu !== b.gpu) return null
  if (a.screenSize && b.screenSize && a.screenSize !== b.screenSize) return null
  if (a.ram && b.ram && a.ram !== b.ram) return null
  if (a.gtin && b.gtin && a.gtin !== b.gtin) return null
  if (a.mpn && b.mpn && a.mpn !== b.mpn) return null
  if (a.kind === 'laptop' && a.brand && b.brand && a.brand !== b.brand) return null
  if (a.condition !== b.condition && (a.condition === 'used' || b.condition === 'used')) return null
  // Even manual review should not propose an explicitly wrong storage variant.
  if (a.storage && b.storage && a.storage !== b.storage) return null

  const stop = new Set([
    'для', 'без', 'при', 'чехол', 'чехлы', 'накладка', 'защитное', 'стекло',
    'силиконовая', 'силиконовый', 'телефон', 'смартфон', 'карманом',
    'черный', 'белый', 'прозрачный', 'цвет', 'case', 'cover', 'with',
    'black', 'white', 'transparent', 'шт', 'gb', 'гб', 'usb',
  ])
  const tokens = (name: string) => new Set(normalize(name).split(' ')
    .filter(word => word.length > 1 && !stop.has(word)))
  const left = tokens(ours.name), right = tokens(theirs.name)
  const common = [...left].filter(word => right.has(word))
  const sameModel = Boolean(a.model && b.model && canonicalModel(a.model) === canonicalModel(b.model))
  const sameCode = Boolean(a.productCode && b.productCode && a.productCode === b.productCode)
  const sameCpu = Boolean(a.cpu && b.cpu && a.cpu === b.cpu)
  const sameGpu = Boolean(a.gpu && b.gpu && a.gpu === b.gpu)
  const sameBrand = Boolean(a.brand && b.brand && a.brand === b.brand)
  const compatible = Boolean(a.compatibleBrand && b.compatibleBrand && a.compatibleBrand === b.compatibleBrand)
  const sameKind = Boolean(a.kind && a.kind === b.kind)
  const specificOverlap = common.filter(word => !['iphone', 'samsung', 'galaxy', 'xiaomi', 'apple'].includes(word))
  // Two random similarly named accessories are not a plausible match.
  if (!sameModel && !sameCode && !sameCpu
    && (!sameKind || specificOverlap.length < 2 || (!sameBrand && !compatible && specificOverlap.length < 3))) return null

  const reasons: string[] = []
  if (!b.model && a.model) reasons.push('модель не указана на 05.ru')
  if (a.color && b.color && a.color !== b.color) reasons.push('цвет требует проверки')
  if (a.brand && b.brand && a.brand !== b.brand) reasons.push('производитель требует проверки')
  if (a.sim && b.sim && a.sim !== b.sim) reasons.push('SIM требует проверки')
  if (a.cpu && !b.cpu) reasons.push('процессор не указан на 05.ru')
  if (a.gpu && !b.gpu) reasons.push('видеокарта не указана на 05.ru')
  if (a.screenSize && !b.screenSize) reasons.push('диагональ не указана на 05.ru')
  if (!b.kind) reasons.push('тип товара не указан')
  const score = Math.min(94,
    (sameModel ? 52 : 0) + (sameCode ? 16 : 0) + (sameCpu ? 18 : 0) + (sameGpu ? 8 : 0)
    + (sameKind ? 16 : 0) + (sameBrand ? 12 : 0) + (compatible ? 12 : 0)
    + Math.min(24, specificOverlap.length * 6)
    - (a.color && b.color && a.color !== b.color ? 12 : 0)
    - (a.brand && b.brand && a.brand !== b.brand ? 12 : 0))
  return score >= 20 ? { score, reasons } : null
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
