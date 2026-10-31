import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const compiled = ts.transpileModule(readFileSync(new URL('../src/catalog-groups.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { catalogPath, catalogBranches, inCatalogSection } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))
test('imports in a broad category are separated by product type; accessories stay separate', () => {
  assert.deepEqual(catalogPath({ name: 'Фотография товара Ноутбук Apple MacBook 8/512', categoryName: 'Товары 05.ru' }), ['computers', 'Ноутбуки'])
  assert.deepEqual(catalogPath({ name: 'Чехол для iPhone 17', categoryName: 'Смартфоны' }), ['accessories', 'Чехлы, зарядки и кабели'])
  assert.deepEqual(catalogPath({ name: 'Apple AirPods Pro', categoryName: 'Телефоны' }), ['audio', 'Наушники'])
})
test('every product belongs to exactly one leaf, including unknown categories', () => {
  const items = [{ name: 'Ноутбук Asus' }, { name: 'iPhone 17' }, { name: 'Паяльная станция', categoryName: 'Оборудование' }, { name: 'Безымянный товар' }]
  const sections = catalogBranches(items)
  assert.equal(sections.reduce((n, group) => n + group.count, 0), items.length)
  for (const item of items) {
    const leaves = sections.flatMap(group => group.children)
    assert.equal(leaves.filter(leaf => inCatalogSection(item, leaf.id)).length, 1)
  }
  assert.equal(inCatalogSection(items[0], 'phones/Смартфоны'), false)
  assert.equal(catalogBranches([]).length, 0)
})

const navCompiled = ts.transpileModule(readFileSync(new URL('../src/catalog-navigation.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { featuredProducts, storefrontPath } = await import('data:text/javascript;base64,' + Buffer.from(navCompiled).toString('base64'))
const treeCompiled = ts.transpileModule(readFileSync(new URL('../src/onec-category-tree.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { categoryTree, childrenAtPath } = await import('data:text/javascript;base64,' + Buffer.from(treeCompiled).toString('base64'))
test('clean catalog has no invented popular products or folders', () => {
  assert.deepEqual(featuredProducts([]), [])
  assert.deepEqual(categoryTree([]), [])
})
test('popular selection includes only in-stock real products and varies brands', () => {
  const items = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: 'Apple iPhone 17 Pro 256 GB ' + i, brand: 'Apple', category: 'Связь / Смартфоны', stockQty: 2 })),
    { id: 10, name: 'Смартфон Xiaomi 15T Pro 512 GB', brand: 'Xiaomi', category: 'Связь / Смартфоны', stockQty: 4 },
    { id: 11, name: 'Samsung Galaxy S25', brand: 'Samsung', category: 'Связь / Смартфоны', stockQty: 0 },
    { id: 12, name: 'Чехол для iPhone 17 Pro', brand: 'Apple', category: 'Аксессуары', stockQty: 5 },
  ]
  const featured = featuredProducts(items, 4)
  assert.equal(featured.length, 4)
  assert(featured.some(item => item.brand === 'Xiaomi'))
  assert(!featured.some(item => item.stockQty === 0 || /чехол/i.test(item.name)))
})
test('1C group paths stay intact while nested tile navigation follows hierarchy', () => {
  const paths = ['МОБИЛЬНАЯ СВЯЗЬ / Смартфоны / Apple', 'МОБИЛЬНАЯ СВЯЗЬ / Смартфоны / Xiaomi', 'ТЕЛЕВИЗОРЫ / OLED']
  const roots = categoryTree(paths)
  assert.deepEqual(roots.map(n => n.title), ['МОБИЛЬНАЯ СВЯЗЬ', 'ТЕЛЕВИЗОРЫ'])
  assert.deepEqual(childrenAtPath(roots, 'МОБИЛЬНАЯ СВЯЗЬ / Смартфоны').map(n => n.title), ['Apple', 'Xiaomi'])
  assert.equal(storefrontPath(paths[0], 'Apple iPhone 17 Pro'), paths[0] + ' / iPhone 17 Pro')
})
