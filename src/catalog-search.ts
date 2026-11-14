import type { Product } from './types'

const accessoryWords = /(?:^|\s)(чехол|сумка|стекло|пл[её]нка|кабель|зарядк\S*|адаптер|переходник|держатель|кронштейн|ремешок|клавиатура|мышь)(?:\s|$)/i
const normalize = (value: string) => value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim().replace(/\s+/g, ' ')

export function catalogSearchScore(product: Product, rawQuery: string) {
  const query = normalize(rawQuery)
  if (!query) return 0
  const name = normalize(product.name)
  const brand = normalize(product.brand)
  const sku = normalize(product.sku || '')
  const category = normalize(product.category)
  const spec = normalize(product.shortSpec)
  let score = name === query ? 1200 : name.startsWith(query) ? 900
    : ` ${name} `.includes(` ${query} `) ? 650 : name.includes(query) ? 480 : 0
  if (sku === query) score += 850
  else if (sku.startsWith(query)) score += 340
  if (brand === query) score += 560
  else if (brand.startsWith(query)) score += 220
  if (category === query) score += 500
  else if (category.includes(query)) score += 210
  if (spec.includes(query)) score += 80
  if (!accessoryWords.test(query) && accessoryWords.test(name + ' ' + category)) score -= 700
  if ((product.stockQty ?? 0) > 0) score += 25
  return score
}

export function rankCatalogProducts(products: Product[], query: string) {
  return [...products].sort((left, right) => catalogSearchScore(right, query) - catalogSearchScore(left, query)
    || Number((right.stockQty ?? 0) > 0) - Number((left.stockQty ?? 0) > 0)
    || left.name.localeCompare(right.name, 'ru') || left.id - right.id)
}
