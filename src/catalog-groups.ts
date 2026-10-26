import { ALL_CATALOG, matchesCategoryPath, selectedCategoryPath } from './onec-category-tree'
export type CatalogEntry = { name: string; categoryName?: string }
export type CatalogBranch = { id: string; title: string; image: string; count: number; children: { id: string; title: string; count: number }[] }
const sections = [
  ['phones', 'Телефоны и гаджеты', '/products/phone.svg'],
  ['computers', 'Компьютеры и ноутбуки', '/products/laptop.svg'],
  ['tv', 'Телевизоры', '/products/tv.svg'],
  ['audio', 'Наушники и звук', '/products/headphones.svg'],
  ['home', 'Техника для дома', '/products/vacuum.svg'],
  ['accessories', 'Аксессуары', '/products/phone.svg'],
  ['other', 'Другие товары', '/products/laptop.svg'],
] as const
export function catalogPath(item: CatalogEntry): [string, string] {
  const name = item.name.toLowerCase().replace(/^фотография товара\s*/, '')
  const category = (item.categoryName || '').toLowerCase()
  // Accessories come first so a case for an iPhone is not classified as a phone.
  const rules: [RegExp, string, string][] = [
    [/чехол|защитн.*стекл|кабел|переходник|зарядн|адаптер|power.?bank|пауэрбанк/, 'accessories', 'Чехлы, зарядки и кабели'],
    [/наушник|airpods|headphone|earbuds/, 'audio', 'Наушники'],
    [/колонк|акустик|саундбар|soundbar/, 'audio', 'Колонки и акустика'],
    [/ноутбук|macbook|laptop/, 'computers', 'Ноутбуки'],
    [/монитор/, 'computers', 'Мониторы'],
    [/клавиатур|мышь|мышка|keyboard/, 'computers', 'Клавиатуры и мыши'],
    [/видеокарт|процессор|материнск|оперативн|ssd|жестк.*диск/, 'computers', 'Комплектующие'],
    [/компьютер|моноблок|системный блок|imac|mac mini/, 'computers', 'Компьютеры'],
    [/планшет|ipad|tablet/, 'phones', 'Планшеты'],
    [/смарт.*час|apple watch|smart.?watch|фитнес.*браслет/, 'phones', 'Умные часы'],
    [/смартфон|телефон|iphone|galaxy s\d|pixel \d/, 'phones', 'Смартфоны'],
    [/телевизор|smart.?tv/, 'tv', 'Телевизоры'],
    [/пылесос|dyson|уборк/, 'home', 'Уборка'],
    [/холодильник|морозильник/, 'home', 'Холодильники'],
    [/стиральн|сушильн/, 'home', 'Стирка и сушка'],
    [/чайник|кофе|блендер|микроволн|тостер|плит|духов|мультивар/, 'home', 'Техника для кухни'],
    [/кондиционер|обогрев|увлажн|вентилятор/, 'home', 'Климатическая техника'],
  ]
  for (const [pattern, section, sub] of rules) if (pattern.test(name)) return [section, sub]
  for (const [pattern, section, sub] of rules) if (pattern.test(category)) return [section, sub]
  if (/аудио|звук/.test(category)) return ['audio', 'Другое аудио']
  if (/для дома|бытов/.test(category)) return ['home', 'Другая техника для дома']
  if (/аксессуар/.test(category)) return ['accessories', 'Другие аксессуары']
  return ['other', item.categoryName?.trim() || 'Без категории']
}
export const leafKey = (section: string, sub: string) => `${section}/${sub}`
export function inCatalogSection(item: CatalogEntry, selection: string): boolean {
  if (!selection || selection === ALL_CATALOG) return true
  const path = selectedCategoryPath(selection)
  if (path !== null) return matchesCategoryPath(item.categoryName || '', path)
  const [section, sub] = catalogPath(item)
  return selection === section || selection === leafKey(section, sub)
}
export function catalogBranches(items: CatalogEntry[]): CatalogBranch[] {
  return sections.map(([id, title, image]) => {
    const counts = new Map<string, number>()
    for (const item of items) { const [section, sub] = catalogPath(item); if (section === id) counts.set(sub, (counts.get(sub) || 0) + 1) }
    return { id, title, image, count: [...counts.values()].reduce((a, b) => a + b, 0), children: [...counts].sort(([a], [b]) => a.localeCompare(b, 'ru')).map(([sub, count]) => ({ id: leafKey(id, sub), title: sub, count })) }
  }).filter(section => section.count > 0)
}
