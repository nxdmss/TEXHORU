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
  if (/\b(?:acer|asus|lenovo|msi|dell|hp|huawei|honor)\b/.test(text)
    && /\b(?:[a-z]{1,4}\d{2,4}[a-z]{0,3}(?:-[a-z0-9]{2,8})+|\d{2}[a-z]{2}\d{2}[a-z0-9]{2,4}|\d{5}[a-z]{3})\b/i.test(item.name)) return 'laptop'
  if (/\bapple\b/.test(text) && /\bA\d{4}\b/i.test(item.name)) return 'laptop'
  return undefined
}

function canonicalBrand(value: string): string {
  const brand = normalize(value)
  if (/\b(?:apple|iphone)\b/.test(brand)) return 'apple'
  if (/\b(?:samsung|galaxy)\b/.test(brand)) return 'samsung'
  // POCO and Redmi are Xiaomi device families. 1C often exports the
  // manufacturer as Xiaomi while 05.ru puts POCO/Redmi in the product name.
  if (/\b(?:xiaomi|redmi|poco)\b/.test(brand)) return 'xiaomi'
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
    if (found) return found.toLowerCase()
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
  const brandText = normalize(attrs.brand || item.brand || '')
  const kind = attrs.kind || productKind(item)
  const units = (value: string) => {
    const m = value.match(/(\d+(?:[.,]\d+)?)\s*(tb|тб|gb|гб)/i)
    return m ? String(Math.round(Number(m[1].replace(',', '.')) * (/tb|тб/i.test(m[2]) ? 1024 : 1))) : undefined
  }
  const memoryPair = specs.find(item => /память.*(?:озу|пзу)|(?:озу.*пзу)|ram.*rom|оперативн.*встроенн/i.test(item.label))
  const pairValues = memoryPair?.value.match(/\d+(?:[.,]\d+)?\s*(?:gb|гб|tb|тб)?/gi) || []
  const storageSpec = attrs.storage || spec(/встроенн|объем накоп|storage|пзу|rom/i)
  const storageParts = storageSpec?.match(/\d+(?:[.,]\d+)?\s*(?:gb|гб|tb|тб)?/gi) || []
  const storageText = storageParts.length > 1 ? storageParts.at(-1)
    : storageSpec || (pairValues.length > 1 ? pairValues[1] : undefined)
  const capacities = [...text.matchAll(/(\d+)\s*(gb|гб|tb|тб)/g)].map(m => units(m[0])!)
  // 1C frequently uses 12/512 without a unit after the storage value.
  // Do not apply this shortcut to iPhones: "iPhone 16 256" is model 16 +
  // 256 GB storage, not 16 GB RAM + 256 GB storage.
  const compactMemory = /iphone/.test(text) ? null
    : text.match(/\b(?:4|6|8|12|16|18|24|32)\s+(128|256|512|1024)(?:\s*(?:gb|гб|tb|тб))?\b/)
  const bareStorage = /iphone/.test(text) ? text.match(/\b(128|256|512|1024)\b/)?.[1]
    : /xiaomi|redmi|poco|galaxy|samsung|honor|huawei|pixel|realme|oneplus|tecno|infinix|nothing/.test(text) ? compactMemory?.[1] : undefined
  const storage = storageText ? units(storageText) || (/^\d+$/.test(storageText) ? storageText : undefined) : capacities.length ? capacities.at(-1) : bareStorage
  const ramSpec = attrs.ram || spec(/оперативн|ram|озу/i)
  const ramParts = ramSpec?.match(/\d+(?:[.,]\d+)?\s*(?:gb|гб|tb|тб)?/gi) || []
  const ramText = ramParts.length > 1 ? ramParts[0] : ramSpec || (pairValues.length > 1 ? pairValues[0] : undefined)
  const ram = ramText ? units(ramText) || (/^\d+$/.test(ramText) ? ramText : undefined)
    : capacities.length > 1 ? capacities[0]
    : compactMemory ? compactMemory[0].match(/^(4|6|8|12|16|18|24|32)\b/)?.[1] : undefined
  const partNumberSource = [rawName, attrs.productCode, item.mpn,
    spec(/part number|p\/n|код производителя|артикул производителя|модель производителя/i)]
    .filter(Boolean).join(' ')
  const partNumber = kind === 'laptop'
    ? laptopPartNumber(partNumberSource, brandText || (/\bapple\b/i.test(rawName) ? 'apple' : undefined))
    : undefined
  const laptopFamily = kind === 'laptop'
    ? text.match(/\b(?:macbook\s+(?:air|pro)|aspire(?:\s+\d)?|vivobook(?:\s+\d)?|ideapad(?:\s+\d)?|thinkpad(?:\s+[a-z0-9]+)?|matebook(?:\s+[a-z]?\s*\d{1,2})?|magicbook(?:\s+x?\s*\d{1,2})?|pavilion(?:\s+[a-z0-9]+)?|inspiron(?:\s+[a-z0-9]+)?|latitude(?:\s+[a-z0-9]+)?|zenbook(?:\s+[a-z0-9]+)?|elitebook(?:\s+[a-z0-9]+)?|probook(?:\s+[a-z0-9]+)?|predator(?:\s+[a-z0-9]+)?|nitro(?:\s+[a-z0-9]+)?|swift(?:\s+\d)?|thin(?:\s+\d{1,2})?)\b/)?.[0]
    : undefined
  const genericCode = text.match(/\b[a-z]{1,5}\d{2,5}[a-z]?\b/)?.[0]
  const safeGenericCode = genericCode && !/^(?:n\d{4}|i[3579]\d{4,5}[a-z]{0,2})$/i.test(genericCode) ? genericCode : undefined
  const model = attrs.model || laptopFamily || text.match(/\biphone\s*\d{1,2}(?:\s*(?:pro max|pro|plus|mini|air|e))?\b/)?.[0]
    || text.match(/\b(?:galaxy\s*)?(?:s|a|z)\d{1,3}(?:\s*(?:ultra|plus|fe|fold|flip))?\b/)?.[0]
    // Without these, Xiaomi 15, 15T, 15T Pro and 15 Ultra are all treated
    // as model-less and can be incorrectly considered interchangeable.
    || text.match(/\bxiaomi\s+\d{1,2}t?(?:\s+(?:pro(?:\s+max)?|ultra|lite|plus))?\b/)?.[0]
    || text.match(/\bredmi\s+(?:note\s+)?\d{1,2}[a-z]?(?:\s+(?:pro(?:\s+plus)?|plus|5g|4g))?\b/)?.[0]
    || text.match(/\bpoco\s+[a-z]\d{1,2}(?:\s+(?:pro|ultra|plus))?\b/)?.[0]
    // Smartwatch families and vendor model codes (e.g. XPAW002, C60).
    || text.match(/\bactive\s+2r\b/)?.[0]
    || text.match(/\b(?:watch|часы)\s+[a-z]?\d{1,3}[a-z]?(?:\s+(?:active|pro|max|ultra|classic|plus|lite|fe|se))?\b/)?.[0]
    // Generic alphanumeric codes on cases/protectors are usually accessory SKUs,
    // not the phone model the accessory is compatible with.
    || (!['case', 'screen-protector', 'laptop'].includes(kind || '') ? safeGenericCode : undefined)
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
  const knownBrand = ['apple', 'samsung', 'xiaomi', 'honor', 'huawei', 'oneplus', 'google', 'realme', 'poco', 'tecno', 'infinix', 'nothing', 'mibro', 'amazfit', 'garmin', 'fitbit', 'oppo', 'vivo', 'motorola', 'nokia', 'itel', 'blackview', 'doogee', 'cubot', 'haylou', 'zeblaze', 'cmf', 'acer', 'asus', 'lenovo', 'msi', 'dell', 'hp'].find(b => text.split(' ').includes(b))
  const accessory = ['case', 'screen-protector', 'watch-strap', 'charger', 'cable'].includes(kind || '')
  const accessoryMaker = accessory && /\bgreen lion\b/.test(text) ? 'green lion' : undefined
  const inferredBrand = accessory ? accessoryMaker : /iphone/.test(text) ? 'apple' : /galaxy/.test(text) ? 'samsung' : knownBrand
  const usableBrand = brandText && !['без бренда', 'другие', 'other'].includes(brandText)
  const brand = accessoryMaker || (usableBrand ? canonicalBrand(brandText) : inferredBrand ? canonicalBrand(inferredBrand) : undefined)
  const normalizedBrand = usableBrand ? canonicalBrand(brandText) : undefined
  const deviceBrand = /iphone/.test(text) ? 'apple'
    : /\b(?:samsung|galaxy)\b/.test(text) ? 'samsung'
    : /\b(?:xiaomi|redmi|poco)\b/.test(text) ? 'xiaomi'
    : knownBrand ? canonicalBrand(knownBrand) : undefined
  const compatibleBrand = accessory
    ? attrs.compatibleBrand || deviceBrand || (normalizedBrand && ['apple', 'samsung', 'xiaomi', 'honor', 'huawei', 'oneplus', 'google', 'realme', 'poco', 'tecno', 'infinix', 'oppo', 'vivo', 'motorola', 'nokia'].includes(normalizedBrand) ? normalizedBrand : undefined)
    : undefined
  const cpuRaw = String(attrs.cpu || spec(/процессор|cpu|processor|чипсет/i) || (rawName + ' ' + (item.shortSpec || '')))
  const gpuRaw = String(attrs.gpu || spec(/видеокарт|график|gpu|graphics|video card/i) || (rawName + ' ' + (item.shortSpec || '')))
  const cpu = processorIdentity(cpuRaw, brand)
  const gpu = graphicsIdentity(gpuRaw)
  const screenRaw = String(attrs.screenSize || spec(/диагонал|screen size|display size/i) || (rawName + ' ' + (item.shortSpec || '')))
  const screenSize = screenRaw.match(/\b(\d{1,2}(?:[.,]\d)?)\s*(?:["″]|дюйм\w*|inch\w*)/i)?.[1]?.replace(',', '.')
    || (kind === 'laptop' ? text.match(/\bmacbook\s+(?:air|pro)\s+(\d{2}(?:[.,]\d)?)\b/)?.[1]?.replace(',', '.') : undefined)
    || (/^\d{1,2}(?:[.,]\d)?$/.test(screenRaw.trim()) ? screenRaw.trim().replace(',', '.') : undefined)
  const powerRaw = String(attrs.wattage || spec(/мощност|power output|выходная мощность/i) || (rawName + ' ' + (item.shortSpec || '')))
  const wattage = kind === 'charger' ? powerRaw.match(/\b(\d{1,3})\s*w(?:att)?\b/i)?.[1] : undefined
  const conditionSource = [
    rawName, String(attrs.condition || ''),
    spec(/состояние товара|состояние|condition|причина уценки|заявленный дефект/i) || '',
  ].join(' ')
  const condition = /замена платы|потертост|заявленн\w* дефект|дефект|ремонт|не видит сим|не работает|поврежд/i.test(conditionSource)
    ? 'defective'
    : /восстановлен|refurb|б\s*\/\s*у|уценен|витринн|used|по\s*сц|сервисн\w*/i.test(conditionSource)
      ? 'used'
      : attrs.condition ? normalize(String(attrs.condition)) : undefined
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
  if (!value) return undefined
  const normalized = normalize(value).replace(/^galaxy\s+/, '')
  const macbookFamily = normalized.match(/\bmacbook\s+(air|pro)\b/)
  if (macbookFamily) return 'macbook ' + macbookFamily[1]
  return normalized
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
      const same = key === 'model'
        ? canonicalModel(a.model) === canonicalModel(b.model) || Boolean(a.productCode && a.productCode === b.productCode)
        : a[key] === b[key]
      ;(same ? reasons : conflicts).push(labels[key])
    }
  }
  const usedA = a.condition === 'used' || a.condition === 'defective'
  const usedB = b.condition === 'used' || b.condition === 'defective'
  if (usedA !== usedB) conflicts.push('новый / восстановленный')
  else if (a.condition && b.condition && a.condition !== b.condition) conflicts.push('состояние')
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
  const phoneVariantComplete = Boolean(
    phone && b.kind === 'smartphone'
    && a.brand && b.brand && a.brand === b.brand
    && a.model && b.model && canonicalModel(a.model) === canonicalModel(b.model)
    && a.storage && b.storage && a.storage === b.storage
    && a.color && b.color && a.color === b.color
    // An omitted SIM type is not a contradiction. Explicit physical/eSIM
    // differences are already captured in conflicts above.
    && (!a.sim || !b.sim || a.sim === b.sim)
  )
  const laptopVariantComplete = Boolean(
    laptop && a.kind === 'laptop' && b.kind === 'laptop'
    && a.brand && b.brand && a.brand === b.brand
    && a.model && b.model && canonicalModel(a.model) === canonicalModel(b.model)
    && a.cpu && b.cpu && a.cpu === b.cpu
    && a.ram && b.ram && a.ram === b.ram
    && a.storage && b.storage && a.storage === b.storage
    && a.screenSize && b.screenSize && a.screenSize === b.screenSize
    && (!a.color || (b.color && a.color === b.color))
    && (!a.gpu || (b.gpu && a.gpu === b.gpu))
  )
  return {
    score, reasons, conflicts, missing, exactId,
    canAutoConfirm: Boolean(!conflicts.length && (exactId || phoneVariantComplete || laptopVariantComplete)),
    ours: a, theirs: b,
  }
}

/**
 * A manual-review suggestion is deliberately broader than an automatic match.
 * Variant differences are surfaced with reasons; only a different product
 * family/model or incompatible device type is excluded.
 */
export function manualConfirmationBlockers(ours: Item, theirs: Item): string[] {
  const a = identity(ours), b = identity(theirs)
  const nameA = identity({ name: ours.name }), nameB = identity({ name: theirs.name })
  const blockers = new Set<string>()
  const kind = a.kind || b.kind
  if (a.kind && b.kind && a.kind !== b.kind) blockers.add('тип товара')
  if (a.model && b.model && canonicalModel(a.model) !== canonicalModel(b.model)) blockers.add('модель')
  if (nameA.model && a.model && canonicalModel(nameA.model) !== canonicalModel(a.model)) {
    blockers.add('модель в названии 1С противоречит характеристикам')
  }
  if (nameB.model && b.model && canonicalModel(nameB.model) !== canonicalModel(b.model)) {
    blockers.add('модель на 05.ru противоречит характеристикам')
  }
  if (['smartphone', 'laptop'].includes(kind || '') && a.brand && b.brand && a.brand !== b.brand) {
    blockers.add('бренд')
  }
  if (a.compatibleBrand && b.compatibleBrand && a.compatibleBrand !== b.compatibleBrand) {
    blockers.add('совместимость')
  }
  if (['smartphone', 'laptop'].includes(kind || '')) {
    if (nameA.brand && a.brand && nameA.brand !== a.brand) blockers.add('бренд в названии 1С противоречит характеристикам')
    if (nameB.brand && b.brand && nameB.brand !== b.brand) blockers.add('бренд на 05.ru противоречит характеристикам')
  }
  return [...blockers]
}

/**
 * Wider recall for manual review. This result is never an automatic mapping
 * and cannot enter price monitoring until a person explicitly confirms it.
 */
export function reviewCandidate(ours: Item, theirs: Item): { score: number; reasons: string[] } | null {
  const a = identity(ours), b = identity(theirs)
  const kind = a.kind || b.kind
  if (a.kind && b.kind && a.kind !== b.kind) return null
  if (a.model && b.model && canonicalModel(a.model) !== canonicalModel(b.model)) return null
  if (['smartphone', 'laptop'].includes(kind || '') && a.brand && b.brand && a.brand !== b.brand) return null
  if (a.compatibleBrand && b.compatibleBrand && a.compatibleBrand !== b.compatibleBrand) return null

  const sameModel = Boolean(a.model && b.model && canonicalModel(a.model) === canonicalModel(b.model))
  const sameCode = Boolean(a.productCode && b.productCode && a.productCode === b.productCode)
  const codeFamily = (value?: string) => value?.split(/[-_]/)[0]
  const sameCodeFamily = Boolean(kind === 'laptop' && a.productCode && b.productCode
    && codeFamily(a.productCode) === codeFamily(b.productCode))
  const sameCpu = Boolean(a.cpu && b.cpu && a.cpu === b.cpu)
  const sameGpu = Boolean(a.gpu && b.gpu && a.gpu === b.gpu)
  const sameBrand = Boolean(a.brand && b.brand && a.brand === b.brand)
  const compatible = Boolean(a.compatibleBrand && b.compatibleBrand && a.compatibleBrand === b.compatibleBrand)
  const sameKind = Boolean(a.kind && a.kind === b.kind)

  const stop = new Set([
    'для', 'без', 'при', 'чехол', 'чехлы', 'накладка', 'защитное', 'стекло',
    'силиконовая', 'силиконовый', 'телефон', 'смартфон', 'карманом',
    'черный', 'белый', 'прозрачный', 'цвет', 'case', 'cover', 'with',
    'black', 'white', 'transparent', 'шт', 'gb', 'гб', 'usb',
    'iphone', 'samsung', 'galaxy', 'xiaomi', 'apple',
  ])
  const tokens = (name: string) => new Set(normalize(name).split(' ')
    .filter(word => word.length > 1 && !stop.has(word)))
  const left = tokens(ours.name), right = tokens(theirs.name)
  const common = [...left].filter(word => right.has(word))
  const specificOverlap = common.filter(word => !/^\d+$/.test(word))

  // A positively identified different phone model is excluded. If the 05.ru
  // card does not expose its model, retain it only when the same brand and the
  // model number are still visible in the title; this is review-only.
  const phoneModelNumber = a.model?.match(/\d+/)?.[0]
  const missingPhoneModelWithAnchor = kind === 'smartphone' && !b.model && sameBrand
    && Boolean(phoneModelNumber && normalize(theirs.name).split(' ').includes(phoneModelNumber))
  if (kind === 'smartphone' && !sameModel && !missingPhoneModelWithAnchor) return null
  // For laptops, a different SKU within the same family is a review candidate.
  if (kind === 'laptop' && !sameModel && !sameCode && !sameCodeFamily && !(sameCpu && sameBrand)) return null
  if (kind !== 'smartphone' && kind !== 'laptop'
    && !sameModel && !sameCode && !(sameKind && (sameCpu || sameGpu || specificOverlap.length >= 2))
    && !(sameBrand && specificOverlap.length >= 3)) return null

  const reasons: string[] = []
  const fields: Array<[keyof Identity, string]> = [
    ['productCode', 'код производителя'], ['storage', 'память'], ['ram', 'ОЗУ'],
    ['color', 'цвет'], ['sim', 'SIM'], ['cpu', 'процессор'], ['gpu', 'видеокарта'],
    ['screenSize', 'диагональ'], ['wattage', 'мощность'], ['gtin', 'GTIN'], ['mpn', 'MPN'],
  ]
  for (const [key, label] of fields) {
    if (a[key] && b[key] && a[key] !== b[key]) reasons.push(label + ' отличается')
    else if (a[key] && !b[key]) reasons.push(label + ' не указан на 05.ru')
  }
  const usedA = a.condition === 'used' || a.condition === 'defective'
  const usedB = b.condition === 'used' || b.condition === 'defective'
  if (usedA !== usedB || (a.condition && b.condition && a.condition !== b.condition)) {
    reasons.push('состояние отличается')
  }
  if (a.brand && b.brand && a.brand !== b.brand) reasons.push('производитель отличается')
  if (a.brand && !b.brand) reasons.push('производитель не указан на 05.ru')
  if (a.model && !b.model) reasons.push('модель не указана на 05.ru')
  if (a.kind && !b.kind) reasons.push('тип товара не распознан на 05.ru')
  if (a.compatibleBrand && !b.compatibleBrand) reasons.push('совместимость не указана на 05.ru')

  // Exact/near-exact matches are handled by the strict path. This function
  // exists for candidates that need a human decision.
  if (!reasons.length) return null

  let score = (sameModel ? 50 : 0) + (sameCode ? 50 : 0) + (sameCodeFamily ? 30 : 0)
    + (sameCpu ? 18 : 0) + (sameGpu ? 10 : 0) + (sameKind ? 12 : 0)
    + (sameBrand ? 12 : 0) + (compatible ? 10 : 0)
    + Math.min(18, specificOverlap.length * 3)
  if (a.productCode && b.productCode && a.productCode !== b.productCode) score -= 10
  if (a.storage && b.storage && a.storage !== b.storage) score -= 12
  if (a.ram && b.ram && a.ram !== b.ram) score -= 6
  if (a.color && b.color && a.color !== b.color) score -= 6
  if (a.sim && b.sim && a.sim !== b.sim) score -= 6
  if (a.cpu && b.cpu && a.cpu !== b.cpu) score -= 14
  if (a.gpu && b.gpu && a.gpu !== b.gpu) score -= 8
  if (a.screenSize && b.screenSize && a.screenSize !== b.screenSize) score -= 8
  if (a.wattage && b.wattage && a.wattage !== b.wattage) score -= 10
  if ((a.condition === 'used') !== (b.condition === 'used')) score -= 8
  if (a.brand && b.brand && a.brand !== b.brand) score -= 10
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
