type SearchableProduct = {
  id: number
  name: string
  brand: string
  sku: string
  shortSpec: string
  browsePath?: string | null
  stockQty: number
  reservedQty: number
}

const accessoryWords = /(?:^|\s)(чехол|сумка|стекло|пл[её]нка|кабель|зарядк\S*|адаптер|переходник|держатель|кронштейн|ремешок|клавиатура|мышь)(?:\s|$)/i

export function normalizeCatalogSearch(value: string) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim().replace(/\s+/g, ' ')
}

/**
 * Stable storefront relevance. A product whose name starts with the requested
 * object must outrank an accessory that only mentions that object later.
 */
export function catalogSearchScore(product: SearchableProduct, rawQuery: string) {
  const query = normalizeCatalogSearch(rawQuery)
  if (!query) return 0
  const name = normalizeCatalogSearch(product.name)
  const brand = normalizeCatalogSearch(product.brand)
  const sku = normalizeCatalogSearch(product.sku)
  const spec = normalizeCatalogSearch(product.shortSpec)
  const path = normalizeCatalogSearch(product.browsePath || '')
  const leaf = path.split(' ').at(-1) || path
  let score = 0
  if (name === query) score += 1200
  else if (name.startsWith(query + ' ') || name.startsWith(query)) score += 900
  else if (` ${name} `.includes(` ${query} `)) score += 650
  else if (name.includes(query)) score += 480
  if (sku === query) score += 850
  else if (sku.startsWith(query)) score += 340
  if (brand === query) score += 560
  else if (brand.startsWith(query)) score += 220
  if (path === query || leaf === query) score += 500
  else if (path.includes(query)) score += 210
  if (spec.includes(query)) score += 80

  // If a customer asks for the device itself, accessories stay visible but go
  // below the actual devices. An accessory query ("чехол для ноутбука") is not penalised.
  const asksForAccessory = accessoryWords.test(query)
  if (!asksForAccessory && accessoryWords.test(name + ' ' + path)) score -= 700
  if (product.stockQty > product.reservedQty) score += 25
  return score
}

export function rankCatalogProducts<T extends SearchableProduct>(products: T[], query: string) {
  return [...products].sort((left, right) =>
    catalogSearchScore(right, query) - catalogSearchScore(left, query)
    || Number(right.stockQty > right.reservedQty) - Number(left.stockQty > left.reservedQty)
    || left.name.localeCompare(right.name, 'ru')
    || left.id - right.id)
}
