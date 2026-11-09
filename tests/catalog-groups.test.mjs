import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

function loadTs(path, dependencies = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const loaded = { exports: {} }
  const require = name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    throw new Error('Unexpected test dependency: ' + name)
  }
  new Function('module', 'exports', 'require', compiled)(loaded, loaded.exports, require)
  return loaded.exports
}
const tree = loadTs('../src/onec-category-tree.ts')
const { catalogPath, catalogBranches, inCatalogSection } = loadTs('../src/catalog-groups.ts', { './onec-category-tree': tree })
const { featuredProducts, storefrontPath, featuredPhoneImage } = loadTs('../src/catalog-navigation.ts')
const { categoryTree, childrenAtPath } = tree
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

test('reset without explicit confirmation changes nothing', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const result = spawnSync(process.execPath, ['scripts/reset-local.mjs'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /подтверждения|confirm|RESET-TEXHORU/i)
})
test('fresh database seed does not create fake 1C groups or promotional data', () => {
  const seed = readFileSync(new URL('../server/prisma/seed.ts', import.meta.url), 'utf8')
  assert(!seed.includes('defaultPromos'))
  assert(!seed.includes('categorySlugs'))
})

test('local iPhone photographs match model and colour and preserve uploaded photos', () => {
  const samples = [
    ['12', 'синий', '12-blue'],
    ['13', 'черный', '13-black'], ['13', 'белый', '13-white'], ['13', 'синий', '13-blue'],
    ['14', 'черный', '14-black'], ['14', 'белый', '14-white'],
    ['15', 'черный', '15-black'], ['15', 'розовый', '15-pink'], ['15', 'синий', '15-blue'],
    ['16', 'черный', '16-black'], ['16', 'белый', '16-white'], ['16', 'зеленый', '16-green'], ['16', 'розовый', '16-pink'],
    ['16e', 'черный', '16e-black'],
    ['17', 'черный', '17-black'], ['17', 'белый', '17-white'], ['17', 'синий', '17-blue'], ['17', 'зелёный', '17-green'],
    ['17 Air', 'черный', 'air-black'],
    ['17 Pro', 'белый', '17-pro-white'], ['17 Pro', 'синий', '17-pro-blue'], ['17 Pro', 'оранжевый', '17-pro-orange'],
    ['17 Pro Max', 'белый', '17-pro-max-white'], ['17 Pro Max', 'синий', '17-pro-max-blue'], ['17 Pro Max', 'оранжевый', '17-pro-max-orange'],
  ]
  const sources = JSON.parse(readFileSync(new URL('../docs/iphone-photo-sources.json', import.meta.url), 'utf8'))
  for (const [model, colour, file] of samples) {
    const photo = '/products/apple/iphone-' + file + '.png'
    assert.equal(featuredPhoneImage(`Смартфон Apple iPhone ${model} 256 Гб E-Sim ${colour}`, ''), photo)
    const original = '/api/uploads/products/my-photo.png'
    assert.equal(featuredPhoneImage(`iPhone ${model} ${colour}`, original), original)
    const bytes = readFileSync(new URL('../public' + photo, import.meta.url))
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
    assert.equal(bytes[25], 6, 'RGBA product image must retain transparency')
    assert(bytes.readUInt32BE(16) >= 640 && bytes.readUInt32BE(20) >= 640)
    const provenance = sources.files.find(row => row.file === 'iphone-' + file + '.png')
    assert(provenance.source.startsWith('https://store.storeimages.cdn-apple.com/'))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.sha256)
  }
  for (const name of ['Чехол iPhone 17 Pro Max белый', 'Стекло iPhone 16 черный', 'iPhone 16 оранжевый', 'iPhone 18 черный', 'iPhone 17 Pro фиолетовый']) {
    assert.equal(featuredPhoneImage(name, ''), '/products/phone.svg', 'unknown models/colours and accessories never borrow another phone photo')
  }
  assert.equal(featuredPhoneImage('Apple iPhone Air Space Black', ''), '/products/apple/iphone-air-black.png')
})
