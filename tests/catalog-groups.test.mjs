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
const { categoryTree, childrenAtPath, categoryMenuRoot } = tree
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

test('pilot photos cover the first ten live storefront products with exact model and colour', () => {
  const pilot = [
    ['Смартфон Apple iPhone 15 128 Гб черный', '/products/apple/iphone-15-black.png'],
    ['Смартфон Apple iPhone 15 128 Гб синий', '/products/apple/iphone-15-blue.png'],
    ['Смартфон Apple iPhone 15 256 Гб черный', '/products/apple/iphone-15-black.png'],
    ['Apple iPhone 11 64Gb Black АКБ 75%', '/products/apple/iphone-11-black.webp'],
    ['Apple iPhone 11 Pro Max 256 Графит АКБ 80%', '/products/apple/iphone-11-pro-max-graphite.webp'],
    ['Смартфон Apple iPhone 16 128 Гб черный', '/products/apple/iphone-16-black.png'],
    ['Смартфон Apple iPhone 16 128 Гб белый', '/products/apple/iphone-16-white.png'],
    ['Смартфон Apple iPhone 16 128 Гб ультрамарин', '/products/apple/iphone-16-ultramarine.webp'],
    ['Смартфон Honor 600 5G 8/256Gb черный', '/products/honor/honor-600-black.webp'],
    ['Смартфон HONOR X9d 8/256Gb RU, Графитовый', '/products/honor/honor-x9d-graphite.webp'],
  ]
  for (const [name, photo] of pilot) {
    assert.equal(featuredPhoneImage(name, '/products/phone.svg'), photo)
    const bytes = readFileSync(new URL('../public' + photo, import.meta.url))
    assert(bytes.length > 10_000)
    if (photo.endsWith('.webp')) assert.equal(bytes.subarray(0, 4).toString(), 'RIFF')
  }
})

test('all live laptops use an exact model photo instead of the phone placeholder', () => {
  const laptops = [
    ['Ноутбук 15.6" FHD Acer Aspire AL15-31P-C1CS silver (Cel N4500/8Gb/256Gb SSD/VGA int/noOS)', '/products/laptops/acer-al15-31p-c1cs.png'],
    ['Ноутбук Apple MacBook Neo 13" 8/256GB (MHFF4X) Indigo', '/products/laptops/macbook-neo-mhff4x-indigo.png'],
    ['Ноутбук Apple MacBook Neo 13" 8/512GB (MHFC4ll) Silver', '/products/laptops/macbook-neo-mhfc4-silver.png'],
    ['Ноутбук Asus Vivobook 15 X1504MA-BQ224 Core 5 320 8Gb SSD512Gb Intel Graphics 15.6" 90NB17I2-M01370', '/products/laptops/asus-x1504ma-bq224.png'],
    ['Ноутбук ASUS Vivobook Go L1504FA-BQ1969 AMD Ryzen 5 7520U/16/512Gb/ 90NBZR2-M035Y0', '/products/laptops/asus-l1504fa-bq1969.png'],
    ['Ноутбук Huawei MateBook D 16 MCLG-X Core i5 13420H 16Gb SSD1Tb Intel UHD Graphics 16" 53014QKW', '/products/laptops/huawei-matebook-d16-53014qkw.png'],
    ['Ноутбук Infinix Xbook 15 [71005000609] YL512 15.6" FHD IPS Core i5-1334U 16/512GB Win11Home Silver', '/products/laptops/infinix-xbook-15-71005000609.png'],
  ]
  const sources = JSON.parse(readFileSync(new URL('../docs/laptop-photo-sources.json', import.meta.url), 'utf8'))
  for (const [name, photo] of laptops) {
    assert.equal(featuredPhoneImage(name, '/products/phone.svg'), photo, name)
    const bytes = readFileSync(new URL('../public' + photo, import.meta.url))
    assert(bytes.length > 10_000)
    const provenance = sources.files.find(row => photo.endsWith(row.file))
    assert(provenance?.sourcePage.startsWith('https://'))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.sha256)
  }
})

test('every remaining live smartphone has a dedicated model and colour image', () => {
  const phones = [
    ['Смартфон HONOR X9d 8/256Gb RU, Бежевый', '/products/honor/honor-x9d-beige.png'],
    ['Смартфон HONOR X9d 8/256Gb RU, Мятный', '/products/honor/honor-x9d-mint.webp'],
    ['Смартфон Honor 600 Pro 12+512 ГБ золотой', '/products/honor/honor-600-pro-gold.webp'],
    ['Смартфон Honor X7e 6+256 ГБ голубой', '/products/honor/honor-x7e-blue.webp'],
    ['Смартфон HONOR X5eS 4/64 ГБ черный', '/products/honor/honor-x5es-black.webp'],
    ['Смартфон Honor 600 5G 8/256Gb оранжевый', '/products/honor/honor-600-orange.webp'],
    ['Смартфон Huawei Nova 15 Max 256Gb 8Gb розовый', '/products/huawei/huawei-nova-15-max-pink.webp'],
    ['Смартфон Samsung Galaxy S25 Ultra 12/256 Гб Titanium Black', '/products/samsung/samsung-s25-ultra-titanium-black.webp'],
    ['Смартфон Samsung Galaxy S25 12/256 Гб Темно-синий', '/products/samsung/samsung-s25-dark-blue.webp'],
    ['Смартфон Samsung Galaxy S25 12/256 Гб Серый', '/products/samsung/samsung-s25-gray.webp'],
    ['Смартфон Samsung Galaxy A17 6/128 Гб черный', '/products/samsung/samsung-a17-black.webp'],
    ['Смартфон Samsung Galaxy S26 Ultra 12 Гб/256 Гб черный', '/products/samsung/samsung-s26-ultra-black.webp'],
    ['Смартфон Samsung Galaxy S26 12/512 Гб черный', '/products/samsung/samsung-s26-black.webp'],
    ['Смартфон Samsung Galaxy S26 12/256 Гб черный', '/products/samsung/samsung-s26-black.webp'],
    ['Смартфон Samsung Galaxy S26 Ultra 12 Гб/512 Гб черный', '/products/samsung/samsung-s26-ultra-black.webp'],
    ['Смартфон POCO F8 Pro 12/512 Гб черный', '/products/poco/poco-f8-pro-black.webp'],
    ['Смартфон POCO M8 5G 8/256 ГБ, зеленый', '/products/poco/poco-m8-5g-green.webp'],
    ['Смартфон POCO X8 Pro Max 12/256 ГБ, черный', '/products/poco/poco-x8-pro-max-black.webp'],
    ['Смартфон Xiaomi 15T Pro 12/256 ГБ черный', '/products/xiaomi/xiaomi-15t-pro-black.webp'],
    ['Смартфон Xiaomi 17T 12/512Gb черный', '/products/xiaomi/xiaomi-17t-black.webp'],
    ['Смартфон POCO X8 Pro 12/512 ГБ, белый', '/products/poco/poco-x8-pro-white.webp'],
    ['Смартфон POCO F8 Ultra 12/256 Гб черный', '/products/poco/poco-f8-ultra-black.webp'],
    ['Смартфон Xiaomi 17T Pro 12/256Gb черный', '/products/xiaomi/xiaomi-17t-pro-black.webp'],
    ['Смартфон Realme 16 Pro 12 Гб/512 Гб графитовый', '/products/realme/realme-16-pro-graphite.webp'],
    ['Смартфон Realme C100x 4/256GB Синий', '/products/realme/realme-c100x-blue.webp'],
    ['Смартфон Realme C100x 4/128GB Синий', '/products/realme/realme-c100x-blue.webp'],
    ['Смартфон Realme C100x 4/128GB Белый', '/products/realme/realme-c100x-white.webp'],
    ['Смартфон Tecno CAMON 50 Ultra 256 ГБ черный', '/products/tecno/tecno-camon-50-ultra-black.webp'],
    ['Смартфон Google Pixel 11 Pro 12/256Gb CA, Obsidian (черный)', '/products/google/google-pixel-11-pro-obsidian.webp'],
  ]
  for (const [name, photo] of phones) {
    assert.equal(featuredPhoneImage(name, '/products/phone.svg'), photo, name)
    const bytes = readFileSync(new URL('../public' + photo, import.meta.url))
    if (photo.endsWith('.webp')) assert.equal(bytes.subarray(0, 4).toString(), 'RIFF')
    else {
      assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
      assert.equal(bytes[25], 6, 'PNG product image must retain transparency')
    }
    assert(bytes.length > 10_000)
  }
})

test('category menu skips common 1C wrapper folders while preserving native paths and counts', () => {
  const roots = categoryTree(['МОБИЛЬНАЯ СВЯЗЬ / Смартфоны / Apple', 'МОБИЛЬНАЯ СВЯЗЬ / Смартфоны / Xiaomi', 'МОБИЛЬНАЯ СВЯЗЬ / Аксессуары / Кабели'])
  const menu = categoryMenuRoot(roots)
  assert.equal(menu.path, 'МОБИЛЬНАЯ СВЯЗЬ')
  assert.equal(menu.nodes.length, 2)
  assert.equal(menu.nodes.reduce((n, node) => n + node.count, 0), 3)
  assert(menu.nodes.every(node => node.path.startsWith('МОБИЛЬНАЯ СВЯЗЬ / ')))
  const severalRoots = categoryMenuRoot(categoryTree(['Смартфоны / Apple', 'Ноутбуки / Asus']))
  assert.equal(severalRoots.path, '')
  assert.equal(severalRoots.nodes.length, 2)
  assert.deepEqual(categoryMenuRoot([]), { path: '', nodes: [] })
})
