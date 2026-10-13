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
