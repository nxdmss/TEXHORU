const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { writeFileSync, unlinkSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { PrismaClient } = require('@prisma/client')
const { compareItems, identity, fingerprint, validGtin, recommendation } = require('../dist/price-monitor/product-matching')
const { extractFiveRu, fiveRuUrl, priceNumber, FiveRuParser } = require('../dist/price-monitor/five-ru.parser')
const { PriceMonitorService, oneCSearchQueries, isExpectedReviewOutcome } = require('../dist/price-monitor/price-monitor.service')
const { ProductsService } = require('../dist/products/products.service')
const { MonitorExchangeService } = require('../dist/price-monitor/monitor-exchange.service')
const { IntegrationsService } = require('../dist/integrations/integrations.service')
const { OneCPriceSyncService } = require('../dist/integrations/price-sync.service')
const { rankSearchLinks } = require('../dist/price-monitor/search-discovery')
const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/05ru-iphone17pro.json'), 'utf8'))
const name = fixture.snapshot.h1
const product = { name: 'Apple iPhone 17 Pro 12GB/256GB Cosmic Orange eSIM', brand: 'Apple' }
const url = fixture.sourceUrl
let prisma
let database
before(async () => {
  database = resolve(__dirname, `../prisma/monitor-test-${randomUUID()}.db`)
  writeFileSync(database, '')
  const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], { cwd: resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: `file:${database.replace(/\\/g, '/')}` }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  prisma = new PrismaClient({ datasources: { db: { url: `file:${database.replace(/\\/g, '/')}` } } })
  await prisma.$connect()
})
after(async () => {
  await prisma?.$disconnect()
  for (const suffix of ['', '-wal', '-shm', '-journal']) { try { unlinkSync(database + suffix) } catch {} }
})

test('Identifies Apple variants across Russian/English; flags memory, colour, SIM and condition conflicts', () => {
  const same = compareItems(product, { name })
  assert.equal(same.conflicts.length, 0)
  assert.equal(same.ours.storage, '256')
  assert.equal(same.theirs.ram, '12')
  assert.equal(same.theirs.sim, 'esim')
  assert(same.score >= 20)
  assert(same.reasons.includes("модель") && same.reasons.includes("память") && same.reasons.includes("цвет") && same.reasons.includes("SIM"))
  for (const wrong of [name.replace('256', '512'), name.replace('оранжевый', 'синий'), name.replace('E-Sim', 'nano SIM'), name + ' восстановленный']) assert.equal(compareItems(product, { name: wrong }).score, 0)
  assert.notEqual(identity({ name: 'Samsung Galaxy S25+' }).model, identity({ name: 'Samsung Galaxy S25' }).model)
  assert.equal(identity({ name: 'Айфон 17 ПМ 256 оранж eSIM' }).model, 'iphone 17 pro max')
})

test('Xiaomi 1C 15T Pro safely matches identical 05.ru title, not 15T/15 Ultra or a different color', () => {
  const ours = { name: 'Смартфон Xiaomi 15T Pro  (EAC) 12/512 ГБ черный', brand: 'Xiaomi' }
  const fiveRu = { name: 'Смартфон Xiaomi 15T Pro 12 Гб/512 Гб черный', brand: 'Xiaomi',
    specs: [
      { label: 'Количество цветов экрана', value: '68 млрд цветов, голубой оттенок' },
      { label: 'Цветовая температура', value: 'Blue' },
      { label: 'Цвет', value: 'черный' },
    ] }
  assert.equal(identity(ours).model, 'xiaomi 15t pro')
  assert.equal(identity(fiveRu).model, 'xiaomi 15t pro')
  assert.equal(identity(ours).storage, '512')
  assert.equal(identity(ours).ram, '12')
  assert.equal(identity(fiveRu).color, 'black')
  const matched = compareItems(ours, fiveRu)
  assert.deepEqual(matched.conflicts, [])
  assert(matched.score >= 55, JSON.stringify(matched))
  for (const other of ['Xiaomi 15T 12 Гб/512 Гб черный',
    'Xiaomi 15 Ultra 12 Гб/512 Гб черный',
    'Xiaomi 15 12 Гб/512 Гб черный',
    'Xiaomi 15T Pro 12 Гб/512 Гб серый',
    'Xiaomi 15T Pro 12 Гб/256 Гб черный']) {
    const checked = compareItems(ours, { name: other, brand: 'Xiaomi' })
    assert(checked.conflicts.length, other + ': ' + JSON.stringify(checked))
    assert.equal(checked.score, 0)
  }
  // An actual contradiction in a dedicated "Цвет" specification is still blocked.
  assert(compareItems(ours, { ...fiveRu, specs: [{ label: 'Цвет', value: 'серый' }] }).conflicts.length > 0)
  assert.equal(identity({ name: 'Xiaomi 15T Pro (EAC) 12/512' }).storage, '512')
  assert.deepEqual(oneCSearchQueries(ours), ['xiaomi 15t pro 512', 'xiaomi 15t pro'])
  assert.deepEqual(oneCSearchQueries({ name: 'Смартфон Apple iPhone 17 Pro 256 Гб' }), ['iphone 17 pro 256', 'iphone 17 pro'])
  assert.equal(identity({ name: 'Смартфон Samsung Galaxy S25 Ultra 12/256 черный' }).storage, '256')
  assert.deepEqual(oneCSearchQueries({ name: 'Смартфон Samsung Galaxy S25 Ultra 12/256 черный' }), ['samsung galaxy s25 ultra 256', 'samsung galaxy s25 ultra'])
})


test('Counts only technical failures as errors; ordinary no-match outcomes require review', () => {
  assert.equal(isExpectedReviewOutcome('05.ru: нет подтверждённого совпадения для Смарт-часы Mibro XPAW002'), true)
  assert.equal(isExpectedReviewOutcome('05.ru: несколько близких совпадений для товара'), true)
  assert.equal(isExpectedReviewOutcome('Карточка 05.ru уже связана с другим товаром'), true)
  assert.equal(isExpectedReviewOutcome('Автопоиск 05.ru: Прямой поиск открылся, но не отдал ссылки'), false)
  assert.equal(isExpectedReviewOutcome('Поиск 05.ru нашёл 12 ссылок, но карточки не прочитаны'), false)
})

test('Recognizes smartwatch model codes and keeps accessory searches separate from phones', () => {
  const mibro = { name: 'Смарт-часы Mibro XPAW002', brand: 'Mibro', category: 'Смарт-часы' }
  const tecno = { name: 'Смарт-часы TECNO Watch 3 Active', brand: 'TECNO', category: 'Смарт-часы' }
  const amazfit = { name: 'Умные часы Amazfit Active 2R', brand: 'Amazfit', category: 'Умные часы' }
  const generic = { name: 'Умные часы C60 Gold Frame White Silicone Strap', category: 'Смарт-часы' }
  assert.equal(identity(mibro).model, 'xpaw002')
  assert.equal(identity(mibro).brand, 'mibro')
  assert.equal(identity(mibro).kind, 'smartwatch')
  assert.equal(identity(tecno).model, 'watch 3 active')
  assert.equal(identity(amazfit).model, 'active 2r')
  assert.equal(identity(generic).model, 'c60')
  assert.deepEqual(oneCSearchQueries(mibro), ['mibro xpaw002', 'Смарт-часы Mibro XPAW002'])

  const caseItem = { name: 'Накладка силиконовая Green Lion Case for iPhone 15 Pro Max', brand: 'Green Lion', category: 'Аксессуары / Чехлы' }
  const phoneItem = { name: 'Смартфон Apple iPhone 15 Pro Max 256 Гб', brand: 'Apple', category: 'Смартфоны' }
  assert.equal(identity(caseItem).kind, 'case')
  assert.equal(identity(caseItem).brand, 'green lion')
  assert(compareItems(caseItem, phoneItem).conflicts.includes('тип товара'))
  assert.deepEqual(oneCSearchQueries(caseItem), [
    'green lion чехол iphone 15 pro max',
    'Накладка силиконовая Green Lion Case for iPhone 15 Pro Max',
  ])
  const caseUrl = 'https://05.ru/cat/x/p/chehol-green-lion-iphone-15-pro-max-123/'
  const phoneUrl = 'https://05.ru/cat/x/p/smartfon-apple-iphone-15-pro-max-256-456/'
  assert.deepEqual(rankSearchLinks([
    { url: phoneUrl, title: 'Смартфон Apple iPhone 15 Pro Max 256 Гб' },
    { url: caseUrl, title: 'Чехол Green Lion для iPhone 15 Pro Max' },
  ], 'green lion чехол iphone 15 pro max', 10), [caseUrl])
  assert.equal(fingerprint({ name: 'Xiaomi 15T Pro' }), fingerprint({ name: 'Xiaomi 15T Pro', category: 'Смартфоны' }))
  const partialTitleUrl = 'https://05.ru/cat/x/p/smart-watch-mibro-123/'
  assert.deepEqual(rankSearchLinks([
    { url: partialTitleUrl, title: 'Смарт-часы Mibro' },
  ], 'mibro xpaw002', 12), [partialTitleUrl])
  assert.deepEqual(oneCSearchQueries({ name: 'Смартфон Xiaomi 15T Pro 12/512' }), [
    'xiaomi 15t pro 512', 'xiaomi 15t pro',
  ])
})

test('Search ranking promotes Xiaomi 15T Pro beyond the first 12 unrelated links', () => {
  const target = 'https://05.ru/cat/396f7486/p/smartfon-xiaomi-15t-pro-12-gb-512-gb-cherniy-25708/'
  const noise = Array.from({ length: 15 }, (_, i) => ({
    url: 'https://05.ru/cat/396f7486/p/smartfon-xiaomi-15t-12-gb-512-gb-seriy-' + i + '/',
    title: 'Смартфон Xiaomi 15T 12 Гб/512 Гб серый',
  }))
  const candidates = [...noise, { url: target, title: 'Смартфон Xiaomi 15T Pro 12 Гб/512 Гб черный' }]
  assert.equal(rankSearchLinks(candidates, 'xiaomi 15t pro 512', 8)[0], target)
  assert.equal(rankSearchLinks([...candidates, candidates.at(-1)], 'xiaomi 15t pro', 20).length, 1)
  assert.deepEqual(rankSearchLinks([
    { url: 'https://05.ru/cat/x/p/chehol-dlya-iphone-17-pro-256-123/', title: 'Чехол iPhone 17 Pro 256' },
    { url: 'https://05.ru/cat/x/p/smartfon-iphone-17-pro-256-456/', title: 'Смартфон Apple iPhone 17 Pro 256 Гб оранжевый' },
  ], 'iphone 17 pro 256', 10), ['https://05.ru/cat/x/p/smartfon-iphone-17-pro-256-456/'])
  assert.deepEqual(rankSearchLinks([
    { url: 'https://05.ru/cat/x/p/smartfon-apple-iphone-17-pro-1-tb-oranzheviy-1/', title: 'iPhone 17 Pro 1 ТБ' },
    { url: 'https://05.ru/cat/x/p/smartfon-apple-iphone-17-pro-256-gb-oranzheviy-2/', title: 'iPhone 17 Pro 256 GB' },
    { url: 'https://05.ru/cat/x/p/smartfon-apple-iphone-17-pro-512-gb-oranzheviy-3/', title: 'iPhone 17 Pro 512 GB' },
  ], 'iphone 17 pro 256', 12), ['https://05.ru/cat/x/p/smartfon-apple-iphone-17-pro-256-gb-oranzheviy-2/'])
})

test('Validates GTIN and never accepts a conflicting variant just because its identifier is equal', () => {
  assert(validGtin('4006381333931'))
  assert.equal(validGtin('4006381333932'), undefined)
  assert.equal(compareItems({ ...product, attributes: { storage: '512' } }, { name }).score, 0)
  assert.equal(compareItems({ ...product, gtin: '4006381333931' }, { name: name.replace('256', '512'), gtin: '4006381333931' }).score, 0)
})

test('Parses recorded live product data; ignores instalment and unrelated Product offers', () => {
  const result = extractFiveRu(fixture.snapshot, url)
  assert.equal(result.price, 96990)
  assert.equal(result.inStock, true)
  assert.equal(result.attributes.storage, '256')
  assert.equal(result.seller, '05.ru')
  assert.equal(result.region, 'Махачкала')
  const used = extractFiveRu({ ...fixture.snapshot, scripts: fixture.snapshot.scripts.map(s => s.replace('NewCondition', 'UsedCondition')) }, url)
  assert.equal(used.attributes.condition, 'used')
  assert.equal(compareItems(product, { name: used.name, attributes: used.attributes }).score, 0)
  assert.equal(priceNumber('25 141 ₽ × 3'), null)
  const unrelated = JSON.stringify({ '@type': 'Product', name: 'Чужой товар', offers: { price: 5000 } })
  assert.throws(() => extractFiveRu({ ...fixture.snapshot, scripts: [unrelated], metaPrice: null, domPrice: null }, url))
  assert.throws(() => extractFiveRu({ ...fixture.snapshot, scripts: [], metaPrice: '900', metaCurrency: 'USD', domPrice: null }, url))
  const unknown = extractFiveRu({ ...fixture.snapshot, scripts: [], availability: null }, url)
  assert.equal(unknown.inStock, null)
  assert.throws(() => fiveRuUrl('https://05.ru:8080/cat/a/p/b/', 'product'))
  assert.throws(() => fiveRuUrl('https://05.ru.attacker.test/cat/a/p/b/', 'product'))
  assert.equal(fiveRuUrl(url + '?utm_source=x#foo', 'product'), url)
})

test('Recommendations require confirmed stock, fresh data, cost floor and a <=10% change', () => {
  const input = { latestPrice: 96990, inStock: true, lastSuccessAt: new Date() }
  assert.equal(recommendation(input, { price: 99990, costPrice: 80000 }).recommendedPrice, 96490)
  for (const bad of [{ ...input, inStock: null }, { ...input, lastError: '403' }, { ...input, lastSuccessAt: new Date(0) }]) assert.equal(recommendation(bad, { price: 99990, costPrice: 80000 }).recommendedPrice, null)
  for (const ours of [{ price: 99990 }, { price: 150000, costPrice: 80000 }, { price: 99990, costPrice: 98000 }]) assert.equal(recommendation(input, ours).recommendedPrice, null)
})

test('Full persistence: 1C import, candidate confirmation, durable delivery, failed ack/retry, changed variant and import rollback', async () => {
  const exchange = new MonitorExchangeService(prisma)
  let parsed = extractFiveRu(fixture.snapshot, url)
  let failure = null
  const parser = { parse: async () => { if (failure) throw new Error(failure); return parsed }, discover: async () => ({ urls: [url], next: null, truncated: false, discovered: 1 }) }
  const monitor = new PriceMonitorService(prisma, parser, exchange)
  const integration = new IntegrationsService(prisma, {}, {})
  const oneCId = randomUUID()
  const catalog = { categories: [{ oneCId: 'cat-test', name: 'Смартфоны', slug: 'phones-test' }], products: [{ oneCId, sku: 'TEST-IP17', slug: 'test-ip17', name: product.name, brand: 'Apple', categoryOneCId: 'cat-test', price: 99990, stockQty: 5, costPrice: 80000 }] }
  await integration.importCatalog(catalog)
  const firstCategory = await prisma.category.findUnique({ where: { oneCId: 'cat-test' } })
  await integration.importCatalog({ categories: [{ oneCId: 'cat-test', name: 'Электроника / Смартфоны', slug: 'phones-test' }], products: [] })
  const nestedCategory = await prisma.category.findUnique({ where: { oneCId: 'cat-test' } })
  assert.equal(nestedCategory.id, firstCategory.id)
  assert.equal(nestedCategory.name, 'Электроника / Смартфоны')
  const ours = await prisma.product.findUnique({ where: { oneCId } })
  let link = await monitor.check({ url })
  assert.equal(link.matchStatus, 'CONFIRMED')
  assert.equal((await exchange.pending()).items.length, 1)
  assert.equal((await monitor.candidates(link.id))[0].product.id, ours.id)
  await monitor.confirm(link.id, ours.id)
  await monitor.confirm(link.id, ours.id)
  await exchange.queueConfirmed()
  const pending = (await exchange.pending()).items
  assert.equal(pending.length, 1)
  assert.equal(pending[0].oneCId, oneCId)
  assert.equal(pending[0].price, 96990)
  assert.equal(pending[0].recommendedPrice, 96490)
  assert.equal((await exchange.pending()).items[0].id, pending[0].id)
  await exchange.ack(pending[0].id, 'Тест: сеть недоступна')
  assert.equal((await exchange.pending()).items.length, 1)
  await exchange.ack(pending[0].id)
  await exchange.ack(pending[0].id)
  assert.equal((await exchange.pending()).items.length, 0)
  assert.equal(await prisma.syncLog.count({ where: { entity: 'PRICE_MONITOR', status: 'SUCCESS' } }), 1)
  assert.equal((await prisma.product.findUnique({ where: { id: ours.id } })).price, 99990)
  const applyDto = { expectedCurrentPrice: 99990, expectedCompetitorPrice: 96990,
    targetPrice: 96490, acceptUnknownCost: false, acceptLargeChange: false }
  await assert.rejects(() => monitor.applyRecommended(link.id, { ...applyDto, expectedCurrentPrice: 90000 }))
  const applied = await monitor.applyRecommended(link.id, applyDto)
  assert.equal(applied.newPrice, 96490)
  assert.equal(applied.siteOnly, true)
  assert.equal((await prisma.product.findUnique({ where: { id: ours.id } })).price, 96490)
  assert.equal(await prisma.auditLog.count({ where: { action: 'APPLY_MONITOR_SITE_PRICE', entityId: String(ours.id) } }), 1)
  await prisma.product.update({ where: { id: ours.id }, data: { price: 99990 } }) // reset fixture

  failure = 'HTTP 403'
  await assert.rejects(() => monitor.check({ url }))
  link = (await monitor.list())[0]
  assert.equal(link.latestPrice, 96990)
  assert.equal(link.recommendedPrice, null)
  failure = null
  parsed = { ...parsed, name: name.replace('256', '512'), attributes: { ...parsed.attributes, storage: '512' } }
  link = await monitor.check({ url })
  assert.equal(link.matchStatus, 'REVIEW_REQUIRED')
  assert.equal((await exchange.pending()).items.length, 0)
  await assert.rejects(() => monitor.confirm(link.id, ours.id))
  parsed = extractFiveRu(fixture.snapshot, url)
  await monitor.check({ url }); await monitor.confirm(link.id, ours.id)
  assert.equal((await exchange.pending()).items.length, 1)
  await integration.importCatalog({ ...catalog, products: [{ ...catalog.products[0], name: product.name.replace('256', '512') }] })
  assert.equal((await monitor.list())[0].matchStatus, 'REVIEW_REQUIRED')
  assert.equal((await exchange.pending()).items.length, 0)
  const beforeCount = await prisma.product.count()
  await assert.rejects(() => integration.importCatalog({ categories: catalog.categories, products: [
    { ...catalog.products[0], oneCId: randomUUID(), sku: 'ROLLBACK-FIRST', slug: 'rollback-first' },
    { ...catalog.products[0], oneCId: randomUUID(), sku: 'ROLLBACK-SECOND', slug: 'rollback-second', categoryOneCId: 'missing' },
  ] }))
  assert.equal(await prisma.product.count(), beforeCount)
})

test('Persistent job keeps cursor on 403 and resumes through the observed next page', async () => {
  const exchange = new MonitorExchangeService(prisma)
  const url2 = url.replace('24007/', '24008/')
  let blocked = true
  const parser = {
    discover: async raw => ({ urls: raw.includes('page=2') ? [url2] : [url], next: raw.includes('page=2') ? null : 'https://05.ru/cat/c/02e38f8a/telefony_i_gadzety/?page=2', discovered: 1, truncated: false }),
    parse: async raw => { if (blocked) throw new Error('HTTP 403'); return { ...extractFiveRu(fixture.snapshot, raw), url: raw } },
  }
  const monitor = new PriceMonitorService(prisma, parser, exchange)
  const task = await monitor.scan({ url: 'https://05.ru/cat/c/02e38f8a/telefony_i_gadzety/', maxPages: 2 })
  await monitor.tick() // page one discoveries saved
  await monitor.tick() // 403 retains the card cursor
  let saved = await prisma.monitorJob.findUnique({ where: { id: task.id } })
  assert.equal(saved.status, 'FAILED')
  assert.equal(saved.pendingUrls[0], url)
  blocked = false
  await monitor.retryJob(task.id)
  for (let i = 0; i < 4; i++) await monitor.tick()
  saved = await prisma.monitorJob.findUnique({ where: { id: task.id } })
  assert.equal(saved.status, 'COMPLETED')
  assert.equal(saved.page, 2)
  assert.equal(saved.processed, 2)
  assert.equal((await prisma.product.findFirst({ where: { sku: 'TEST-IP17' } })).price, 99990)
})

test('HTTP routes reject missing credentials and invalid input; admin and 1C routes accept their own authentication', async () => {
  const { spawn } = require('node:child_process')
  const { once } = require('node:events')
  const net = require('node:net')
  const bcrypt = require('bcryptjs')
  await prisma.user.create({ data: { email: 'monitor-http@test.local', name: 'HTTP test', role: 'ADMIN', passwordHash: await bcrypt.hash('LocalTestPassword123!', 8) } })
  const socket = net.createServer()
  await new Promise((r,j) => { socket.once('error',j); socket.listen(0,'127.0.0.1',r) })
  const port = socket.address().port
  await new Promise(r => socket.close(r))
  const key = randomUUID()
  const child = spawn(process.execPath, ['dist/main.js'], { cwd: resolve(__dirname, '..'), env: { ...process.env,
    DATABASE_URL: `file:${database.replace(/\\/g, '/')}`, JWT_SECRET: randomUUID(), ONE_C_API_KEY: key,
    PORT: String(port), NODE_ENV: 'test', TEXHORU_ENV_FILE: 'tests/nonexistent.env', MONITOR_WORKER_DISABLED: 'true', SERVE_STOREFRONT: 'false',
  }, stdio: ['ignore','pipe','pipe'] })
  let log = ''
  child.stdout.on('data', d => { log += d }); child.stderr.on('data', d => { log += d })
  const base = `http://127.0.0.1:${port}/api`
  try {
    let ready = false
    for (let n = 0; n < 50; n++) { try { if ((await fetch(base+'/health')).ok) { ready = true; break } } catch {} await new Promise(r => setTimeout(r,100)) }
    assert(ready, log.slice(-1500))
    assert.equal((await fetch(base+'/admin/price-monitor')).status,401)
    assert.equal((await fetch(base+'/integrations/1c/price-monitor/pending')).status,401)
    const login = await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'monitor-http@test.local',password:'LocalTestPassword123!'})})
    assert.equal(login.status,201)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    for (const path of ['/admin/price-monitor','/admin/price-monitor/jobs','/admin/price-monitor/deliveries','/admin/price-monitor/settings','/admin/price-monitor/export-1c']) assert.equal((await fetch(base+path,{headers:{cookie}})).status,200,path)
    assert.equal((await fetch(base+'/integrations/1c/price-monitor/pending',{headers:{'x-1c-key':key}})).status,200)
    assert.equal((await fetch(base+'/admin/price-monitor/scan',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({url:'https://05.ru/cat/c/02e38f8a/telefony_i_gadzety/',maxPages:101})})).status,400)
    assert.equal((await fetch(base+'/admin/price-monitor/scan',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({url:'https://05.ru.attacker.test/cat/c/a/',maxPages:1})})).status,400)
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child,'exit') }
  }
})

test('Bidirectional pilot: 10 iPhone 13s, 1C to site, approved monitor price back to 1C with stale-import protection', async () => {
  const sync = new OneCPriceSyncService(prisma)
  const integration = new IntegrationsService(prisma, {})
  const exchange = new MonitorExchangeService(prisma)
  const ids = Array.from({ length: 10 }, () => randomUUID())
  const categoryId = randomUUID()
  const category = { oneCId: categoryId, name: 'Тестовые iPhone 13', slug: 'pilot-iphone13-'+categoryId }
  const products = ids.map((id,i) => ({
    oneCId: id, sku: 'PILOT-'+id, slug: 'pilot-'+id,
    name: 'Apple iPhone 13 128GB Test-'+i, brand: 'Apple',
    categoryOneCId: categoryId, price: 60000+i*100, stockQty: 2, costPrice: 45000,
  }))
  const imported = await integration.importCatalog({ categories: [category], products })
  assert.equal(imported.products, 10)
  await assert.rejects(() => sync.configureScope({ oneCIds: [...ids, randomUUID()] }))
  assert.equal((await sync.configureScope({ oneCIds: ids })).count, 10)
  assert.equal((await sync.scope()).length, 10)

  const changedPrice = 72000
  await integration.importCatalog({ categories: [category], products: [{ ...products[0], price: changedPrice }] })
  let ours = await prisma.product.findUniqueOrThrow({ where: { oneCId: ids[0] } })
  assert.equal(ours.price, changedPrice) // 1C -> site

  const source = await prisma.competitorSource.upsert({
    where: { key: '05ru' }, update: {}, create: { key: '05ru', name: '05.ru', baseUrl: 'https://05.ru' },
  })
  const monitorUrl = 'https://05.ru/cat/synthetic/p/iphone-13-128-test/'
  const { fingerprint } = require('../dist/price-monitor/product-matching')
  const competitorName = 'Apple iPhone 13 128GB Test-0'
  const link = await prisma.competitorProduct.upsert({
    where: { externalUrl: monitorUrl },
    update: {}, create: {
      sourceId: source.id, externalUrl: monitorUrl, productId: ours.id, matchStatus: 'CONFIRMED',
      externalName: competitorName, attributes: {},
      confirmedFingerprint: fingerprint({ name: competitorName, attributes: {} }),
      confirmedProductFingerprint: fingerprint(ours),
      lastSuccessAt: new Date(), lastCheckedAt: new Date(), latestPrice: 70900,
      inStock: true, seller: '05.ru', region: 'Махачкала',
    },
  })
  const monitor = new PriceMonitorService(prisma, { parse: async () => {} }, exchange)
  const priceChange = await monitor.applyRecommended(link.id, {
    expectedCurrentPrice: changedPrice, expectedCompetitorPrice: 70900,
    targetPrice: 70400, acceptUnknownCost: false, acceptLargeChange: false,
  })
  assert.equal(priceChange.newPrice, 70400)
  assert.equal(priceChange.oneCQueued, true)
  const pending = await sync.pending()
  assert.equal(pending.items.length, 1)
  assert.equal(pending.items[0].oneCId, ids[0])
  assert.equal(pending.items[0].expectedPrice, changedPrice)
  assert.equal(pending.items[0].targetPrice, 70400)
  const failureReceipt = await sync.receipts({ items: [{ id: pending.items[0].id, error: '1C TEST temporarily unavailable' }] })
  assert.equal(failureReceipt.results[0].status, 'PENDING')
  assert.equal((await sync.pending()).items.length, 1) // safe retry, no lost update
  await assert.rejects(() => sync.configureScope({ oneCIds: ids.slice(0,2) }))

  // Site change must NOT get overwritten by 1C's stale snapshot while delivery is pending.
  await integration.importCatalog({ categories: [category], products: [{ ...products[0], price: changedPrice }] })
  ours = await prisma.product.findUniqueOrThrow({ where: { oneCId: ids[0] } })
  assert.equal(ours.price, 70400)
  await assert.rejects(() => monitor.applyRecommended(link.id, {
    expectedCurrentPrice: changedPrice, expectedCompetitorPrice: 70900,
    targetPrice: 70400, acceptUnknownCost: false, acceptLargeChange: false,
  }))
  // A verified 1C write is acknowledged by stable delivery ID.
  const acknowledgement = await sync.receipts({ items: [{ id: pending.items[0].id, appliedPrice: 70400 }] })
  assert.equal(acknowledgement.results[0].status, 'DELIVERED')
  assert.equal((await sync.pending()).items.length, 0)
  await integration.importCatalog({ categories: [category], products: [{ ...products[0], price: 70400 }] })
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: ids[0] } })).price, 70400)
  // Another independent change in 1C is reflected on the site, no echo.
  await integration.importCatalog({ categories: [category], products: [{ ...products[0], price: 72500 }] })
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: ids[0] } })).price, 72500)
  assert.equal((await sync.pending()).items.length, 0)
})

test('Universal selection: parent group includes nested 1C category; 05.ru auto-match never changes site prices', async () => {
  const id = randomUUID()
  const catId = randomUUID()
  const uniqueName = 'Apple iPhone 18 Pro 12GB/256GB Cosmic Orange eSIM'
  const uniqueSnapshot = { ...fixture.snapshot,
    h1: fixture.snapshot.h1.replace('iPhone 17 Pro', 'iPhone 18 Pro'),
    scripts: fixture.snapshot.scripts.map(text => text.replaceAll('iPhone 17 Pro', 'iPhone 18 Pro')),
  }
  const ours = { oneCId: id, sku: 'UNIVERSAL-'+id, slug: 'universal-'+id,
    name: uniqueName, brand: 'Apple', categoryOneCId: catId,
    price: 99990, stockQty: 2, costPrice: 80000 }
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: catId, name: 'Мобильная связь / Смартфоны / Apple', slug: 'universal-group-'+catId }],
    products: [ours],
  })
  const sourceUrl = fixture.sourceUrl.replace('24007/', 'universal-'+id+'/')
  let searches = 0
  const parser = { searchProducts: async query => {
    searches++
    if (searches === 1) throw new Error("Search timeout")
    assert(/iphone/i.test(query))
    return [{ ...extractFiveRu(uniqueSnapshot, fixture.sourceUrl), url: sourceUrl }]
  } }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  await assert.rejects(() => monitor.autoFindOneCSection({ categoryPath: 'Несуществующая группа', maxItems: 10 }))
  const job = await monitor.autoFindOneCSection({ categoryPath: 'Мобильная связь / Смартфоны', maxItems: 10 })
  assert.equal(job.eligible, 1)
  assert.equal(job.queued, 1)
  await monitor.tick()
  const finished = await prisma.monitorJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(finished.status, 'COMPLETED')
  assert.equal(finished.processed, 1)
  assert.equal(searches, 2)
  const matched = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: sourceUrl } })
  const original = await prisma.product.findUniqueOrThrow({ where: { oneCId: id } })
  assert.equal(matched.productId, original.id)
  assert.equal(original.price, 99990)
  assert.equal(matched.matchStatus, 'CONFIRMED')
})

test('Auto-matching refreshes an existing 05.ru link even when storefront search returns zero links', async () => {
  const id = randomUUID(), categoryId = randomUUID()
  const integration = new IntegrationsService(prisma, {})
  const categoryPath = 'Изолированная группа для обновления сохранённой карточки ' + id
  await integration.importCatalog({
    categories: [{ oneCId: categoryId, name: categoryPath, slug: 'known-link-' + id }],
    products: [{ oneCId: id, sku: 'KNOWN-'+id, slug: 'known-'+id, categoryOneCId: categoryId,
      name: 'Смартфон Apple iPhone 17 Pro 256 Гб eSIM оранжевый', brand: 'Apple',
      price: 91900, stockQty: 3, costPrice: 80000 }],
  })
  const own = await prisma.product.findUniqueOrThrow({ where: { oneCId: id } })
  const existingUrl = fixture.sourceUrl.replace('24007/', 'saved-' + id + '/')
  const parsed = { ...extractFiveRu(fixture.snapshot, fixture.sourceUrl), url: existingUrl }
  const { fingerprint } = require('../dist/price-monitor/product-matching')
  const source = await prisma.competitorSource.upsert({
    where: { key: '05ru' }, update: {}, create: { key: '05ru', name: '05.ru', baseUrl: 'https://05.ru' },
  })
  await prisma.competitorProduct.create({ data: {
    sourceId: source.id, externalUrl: existingUrl, externalName: parsed.name,
    attributes: parsed.attributes, productId: own.id, matchStatus: 'CONFIRMED',
    confirmedFingerprint: fingerprint({ name: parsed.name, attributes: parsed.attributes }),
    confirmedProductFingerprint: fingerprint(own),
    lastSuccessAt: new Date(Date.now() - 2 * 24 * 3600_000), latestPrice: 95000, inStock: true,
  } })
  let searchCalls = 0, parseCalls = 0
  const parser = {
    searchProducts: async () => { searchCalls++; return [] },
    parse: async url => { parseCalls++; assert.equal(url, existingUrl); return { ...parsed, price: 94990 } },
  }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  await monitor.autoFindOneCSection({ categoryPath, maxItems: 10 })
  await monitor.tick()
  const task = (await monitor.jobs()).find(job => job.kind === 'MATCH_1C' && job.url === categoryPath)
  const row = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: existingUrl } })
  assert.equal(task.status, 'COMPLETED')
  assert.equal(task.errors, 0)
  assert.equal(task.processed, 1)
  assert.equal(parseCalls, 1)
  assert.equal(searchCalls, 0)
  assert.equal(row.productId, own.id)
  assert.equal(row.matchStatus, 'CONFIRMED')
  assert.equal(row.latestPrice, 94990)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: own.id } })).price, 91900)

  // One slow 05.ru product must not cancel the rest of the batch.
  const secondId = randomUUID()
  const secondName = 'Смартфон Apple iPhone 18 Pro 512 Гб eSIM зеленый'
  await integration.importCatalog({ categories: [], products: [{
    oneCId: secondId, sku: 'NEXT-'+secondId, slug: 'next-'+secondId,
    categoryOneCId: categoryId, name: secondName, brand: 'Apple',
    price: 90000, stockQty: 2, costPrice: 65000,
  }] })
  const secondUrl = 'https://05.ru/cat/396f7486/p/test-iphone-18-pro-green-' + secondId + '/'
  const nextSnapshot = { ...fixture.snapshot, h1: 'Смартфон Apple iPhone 18 Pro 12 Гб/512 Гб зеленый (E-Sim)', specs: [{ label: 'Цвет', value: 'зеленый' }] }
  let searchCallsAfterTimeout = 0
  const failing = new PriceMonitorService(prisma, {
    searchProducts: async query => {
      searchCallsAfterTimeout++
      assert(/iphone 18 pro/.test(query))
      return [{ ...extractFiveRu(nextSnapshot, secondUrl), url: secondUrl }]
    },
    parse: async () => { throw new Error('Не удалось проверить 05.ru: page.goto: Timeout 30000ms exceeded') },
  }, new MonitorExchangeService(prisma))
  await failing.autoFindOneCSection({ categoryPath, maxItems: 10 })
  await failing.tick()
  await failing.tick()
  const newest = (await failing.jobs()).find(job => job.kind === 'MATCH_1C' && job.url === categoryPath)
  const last = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: existingUrl } })
  const next = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: secondUrl } })
  assert.equal(newest.status, 'COMPLETED')
  assert.equal(newest.processed, 2)
  assert.equal(newest.errors, 1)
  assert.equal(searchCallsAfterTimeout, 1)
  assert.match(newest.lastError, /повторная проверка не удалась/)
  assert.match(last.lastError, /Timeout 30000ms exceeded/)
  assert.equal(last.latestPrice, 94990)
  assert.equal(next.externalName, nextSnapshot.h1)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: secondId } })).price, 90000)
})

test('Direct 05.ru search URL returns unique ranked product links, checks live cards and caches repeat queries', async () => {
  const parser = new FiveRuParser()
  const orange256 = fixture.sourceUrl
  const orange1tb = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-1-tb-oranzheviy-e-sim-bez-rustore-34464/'
  const blue256 = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-256-gb-siniy-e-sim-bez-rustore-24126/'
  const orange512 = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-512-gb-oranzheviy-12345/'
  const white256 = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-256-gb-beliy-12346/'
  const productLinks = [
    { url: orange1tb, title: 'Смартфон Apple iPhone 17 Pro 1 ТБ оранжевый' },
    { url: orange256, title: fixture.snapshot.h1 },
    { url: blue256, title: 'Смартфон Apple iPhone 17 Pro 256 ГБ синий' },
    { url: white256, title: 'Смартфон Apple iPhone 17 Pro 256 ГБ белый' },
    { url: orange512, title: 'Смартфон Apple iPhone 17 Pro 512 ГБ оранжевый' },
    { url: 'https://05.ru/cat/x/p/chehol-iphone-17-pro-256-123/', title: 'Чехол iPhone 17 Pro 256' },
    { url: 'https://05.ru/cat/x/p/iphone-17-pro-max-256-456/', title: 'Смартфон Apple iPhone 17 Pro Max 256' },
    { url: 'https://other.example/cat/x/p/iphone-17-pro-256-789/', title: 'Другой сайт' },
  ]
  // Real search page has 32 anchors, with several anchors per actual product.
  let links = Array.from({ length: 32 }, (_, i) => productLinks[i % productLinks.length])
  let responseStatus = 200
  let launches = 0, closings = 0, contexts = 0, pageCloses = 0, cardOpens = 0, active = 0, maxActive = 0
  const navigations = [], opened = []
  parser.browser = async () => {
    launches++
    return { isConnected: () => true, close: async () => { closings++ } }
  }
  parser.context = async () => {
    contexts++
    let currentUrl = ''
    return {
      newPage: async () => ({
        goto: async (url, options) => {
          currentUrl = url; navigations.push(url)
          assert.equal(options.waitUntil, 'commit')
          assert.equal(options.timeout, 20_000)
          const parsed = new URL(url)
          assert.equal(parsed.origin, 'https://05.ru')
          assert.equal(parsed.pathname, '/search/')
          assert.equal(parsed.searchParams.get('page'), '1')
          assert(parsed.searchParams.has('q'))
          return { status: () => responseStatus }
        },
        url: () => currentUrl,
        locator: () => ({
          first: () => ({ waitFor: async () => {} }),
          evaluateAll: async () => links,
        }),
        close: async () => { pageCloses++ },
      }),
      close: async () => {},
    }
  }
  parser.open = async (_, url) => {
    cardOpens++; opened.push(url)
    return { close: async () => {} }
  }
  parser.snapshot = async () => {
    active++; maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 10))
    active--
    return fixture.snapshot
  }
  try {
    const trace = {}
    const found = await parser.searchProducts('iPhone 17 Pro 256', 3, trace)
    assert.equal(found.length, 3)
    assert.equal(trace.linksFound, 7) // valid 05.ru links, deduplicated
    assert.equal(trace.searchMode, 'direct-search')
    assert.equal(trace.cardsParsed, 3)
    assert.equal(opened[0], orange256) // not the first 1TB card in the feed
    assert.equal(cardOpens, 3)
    assert.equal(maxActive, 3)
    assert.equal(launches, 1)
    assert.equal(pageCloses, 1)
    assert.equal(new URL(navigations[0]).searchParams.get('q'), 'iPhone 17 Pro 256')
    const again = await parser.searchProducts('  iPhone 17 Pro 256  ', 3, {})
    assert.equal(again.length, 3)
    assert.equal(cardOpens, 3) // cache avoids extra site requests
    assert.equal(contexts, 1)

    const originalOpen = parser.open
    parser.open = async (context, url) => {
      if (url === orange256) throw new Error('Timeout 20000ms exceeded')
      return originalOpen(context, url)
    }
    const partialTrace = {}
    const partial = await parser.searchProducts('iPhone 17 Pro 256 GB', 3, partialTrace)
    assert.equal(partial.length, 2)
    assert.equal(partialTrace.rejectedCards.length, 1)
    parser.open = originalOpen
    const recovered = await parser.searchProducts('iPhone 17 Pro 256 GB', 3, {})
    assert.equal(recovered.length, 3) // Partial results must not poison the query cache.
    links = []
    const emptyTrace = {}
    await assert.rejects(() => parser.searchProducts('Nonexistent model', 3, emptyTrace), /Прямой поиск 05.ru.*не отдал/)
    assert.equal(emptyTrace.linksFound, 0)
    assert.equal(emptyTrace.searchMode, 'direct-search')
    assert.equal(contexts, 4)
    responseStatus = 403
    await assert.rejects(() => parser.searchProducts('Another nonexistent model', 3), /HTTP 403/)
    assert.equal(contexts, 5)
  } finally { await parser.onModuleDestroy() }
  assert.equal(closings, 1)
})

test('Business price-list import links 1C products safely, never claims 05.ru verification and rolls back invalid rows', async () => {
  const categoryId = randomUUID(), id = randomUUID(), secondId = randomUUID()
  const categoryPath = 'Бизнес импорт тест ' + categoryId
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: categoryId, slug: 'business-import-' + categoryId, name: categoryPath }],
    products: [
      { oneCId: id, sku: 'BUS-'+id, slug: 'business-'+id, name: product.name, brand: 'Apple',
        categoryOneCId: categoryId, price: 91000, stockQty: 3, costPrice: 78000 },
      { oneCId: secondId, sku: 'BUS-'+secondId, slug: 'business-'+secondId, name: 'Apple iPhone 17 Pro Max 512GB Blue eSIM', brand: 'Apple',
        categoryOneCId: categoryId, price: 120000, stockQty: 2, costPrice: 94000 },
    ],
  })
  const link = 'https://05.ru/cat/test/p/iphone-17-pro-256-orange-' + id + '/'
  const observedAt = new Date().toISOString()
  const row = { oneCId: id, url: link, name: fixture.snapshot.h1,
    price: 94990, observedAt, inStock: true }
  const monitor = new PriceMonitorService(prisma, { parse: async () => { throw new Error('Live site must not be opened') } }, new MonitorExchangeService(prisma))
  const result = await monitor.importManualPrices({ rows: [row] })
  assert.deepEqual([result.imported, result.created, result.associated, result.verifiedOn05Ru], [1, 1, 1, false])
  let saved = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: link } })
  const ours = await prisma.product.findUniqueOrThrow({ where: { oneCId: id } })
  assert.equal(saved.productId, ours.id)
  assert.equal(saved.matchStatus, 'SUGGESTED')
  assert.equal(saved.priceSource, 'USER_FILE')
  assert.equal(saved.lastSuccessAt, null)
  assert.match(saved.lastError, /не проверена на 05.ru/)
  assert.equal(saved.latestPrice, 94990)
  assert.equal((await monitor.list()).find(p => p.id === saved.id).recommendedPrice, null)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: id } })).price, 91000)
  assert.equal((await prisma.monitorDelivery.count({ where: { linkId: saved.id } })), 0)
  await monitor.importManualPrices({ rows: [row] })
  assert.equal(await prisma.competitorPriceHistory.count({ where: { competitorProductId: saved.id } }), 1)

  const other = 'https://05.ru/cat/test/p/iphone-17-pro-max-512-blue-' + secondId + '/'
  await assert.rejects(() => monitor.importManualPrices({ rows: [
    { ...row, price: 94000 },
    { oneCId: secondId, url: other, name: 'Apple iPhone 17 Pro 256GB Orange eSIM',
      price: 101000, observedAt },
  ] }), /не совпадают/)
  saved = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: link } })
  assert.equal(saved.latestPrice, 94990) // valid first row rolled back
  assert.equal(await prisma.competitorProduct.findUnique({ where: { externalUrl: other } }), null)
  await assert.rejects(() => monitor.importManualPrices({ rows: [
    { ...row, observedAt: new Date(Date.now() - 32 * 86400000).toISOString() },
  ] }), /последние 30 дней/)
  await assert.rejects(() => monitor.importManualPrices({ rows: [
    { ...row, url: 'https://05.ru/cat/test/p/iphone-17-pro-max-512-orange-999999/' },
  ] }), /ссылка 05.ru указывает на другую модель/)
  await assert.rejects(() => monitor.importManualPrices({ rows: [
    { ...row, url: 'https://05.ru.evil.example/cat/test/p/fake/' },
  ] }), /05.ru/)
})

test('Direct product checks use response commit and reuse Chromium across checks', async () => {
  const parser = new FiveRuParser()
  let launches = 0, pageCloses = 0, contexts = 0, browserCloses = 0
  parser.browser = async () => {
    launches++
    return { isConnected: () => true, close: async () => { browserCloses++ } }
  }
  parser.context = async () => {
    contexts++
    return {
      newPage: async () => ({
        goto: async (_, options) => {
          assert.equal(options.waitUntil, 'commit')
          assert(options.timeout <= 30_000)
          return { status: () => 200 }
        },
        url: () => fixture.sourceUrl,
        locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
        waitForTimeout: async () => {},
        close: async () => { pageCloses++ },
      }),
      close: async () => {},
    }
  }
  parser.snapshot = async () => fixture.snapshot
  try {
    const first = await parser.parse(fixture.sourceUrl)
    const second = await parser.parse(fixture.sourceUrl)
    assert.equal(first.price, 96990)
    assert.equal(second.price, 96990)
    assert.equal(launches, 1)
    assert.equal(contexts, 2)
    assert.equal(pageCloses, 2)
  } finally { await parser.onModuleDestroy() }
  assert.equal(browserCloses, 1)
})


test('05.ru seller index reads distinct product pages using observed ?page=N pagination', async () => {
  const parser = new FiveRuParser()
  let launches = 0
  const navigations = []
  parser.browser = async () => {
    launches++
    return { isConnected: () => true, close: async () => {} }
  }
  parser.context = async () => ({
    newPage: async () => {
      let requestedUrl = ''
      return {
        goto: async (url, options) => {
          requestedUrl = url; navigations.push(url)
          assert.equal(options.waitUntil, 'commit')
          return { status: () => 200 }
        },
        url: () => requestedUrl,
        locator: () => ({ first: () => ({ waitFor: async () => {} }), evaluateAll: async () => {
          const n = new URL(requestedUrl).searchParams.get('page') || '1'
          return [{ url: 'https://05.ru/cat/396f7486/p/test-iphone-' + n + '/',
            title: 'Смартфон Apple iPhone 18 Pro 256 Гб оранжевый' }]
        } }),
        evaluate: async () => {},
        waitForTimeout: async () => {},
        close: async () => {},
      }
    },
    close: async () => {},
  })
  try {
    const first = await parser.indexCatalogPage(1)
    const second = await parser.indexCatalogPage(2)
    assert.equal(first.length, 1)
    assert.equal(second.length, 1)
    assert.notEqual(first[0].url, second[0].url)
    assert.deepEqual(navigations, [
      'https://05.ru/cat/seller/05-ru-133/',
      'https://05.ru/cat/seller/05-ru-133/?page=2',
    ])
    assert.equal(launches, 1)
  } finally { await parser.onModuleDestroy() }
})

test('Bulk 1C matching automatically builds persistent 05.ru index and links a verified product without manual URLs', async () => {
  await prisma.competitorCatalogEntry.deleteMany()
  const catId = randomUUID(), base = randomUUID(), size = 125
  const categoryPath = 'BUSINESS 2000 ' + base
  const iphoneName = 'Смартфон Apple iPhone 18 Pro 12 Гб/256 Гб оранжевый (E-Sim)'
  const products = Array.from({ length: size }, (_, i) => ({
    oneCId: base + '-' + i, sku: 'BULK-SKU-' + base + '-' + i,
    slug: 'bulk-' + base + '-' + i,
    name: i === 0 ? iphoneName : 'Тестовая модель Xiaomi ' + i,
    brand: i === 0 ? 'Apple' : 'Xiaomi',
    categoryOneCId: catId, price: 92000, stockQty: 2, costPrice: 75000,
  }))
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: catId, name: categoryPath, slug: 'bulk-' + catId }],
    products,
  })
  const url = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-18-pro-12-gb-256-gb-oranzheviy-e-sim-999999/'
  const currentSnapshot = { ...fixture.snapshot,
    h1: fixture.snapshot.h1.replaceAll('iPhone 17 Pro', 'iPhone 18 Pro'),
    scripts: fixture.snapshot.scripts.map(script => script.replaceAll('iPhone 17 Pro', 'iPhone 18 Pro')),
  }
  let searchCalls = 0, parseCalls = 0, indexCalls = 0
  const parser = {
    indexCatalogPage: async page => {
      indexCalls++
      return page === 1 ? [{ url, title: 'Смартфон Apple iPhone 18 Pro 256 Гб' }] : []
    },
    searchProducts: async () => { searchCalls++; return [] },
    parse: async link => {
      parseCalls++
      assert.equal(link, url)
      return { ...extractFiveRu(currentSnapshot, fixture.sourceUrl), url }
    },
  }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const enqueued = await monitor.autoFindOneCSection({ categoryPath, maxItems: 2000, indexCatalog: true })
  assert.equal(enqueued.eligible, size)
  assert.equal(enqueued.queued, size)
  let indexJob = await prisma.monitorJob.findFirstOrThrow({
    where: { kind: 'INDEX_05RU', status: 'QUEUED' }, orderBy: { createdAt: 'desc' },
  })
  assert.equal(indexJob.page, 0)
  // Use a new instance at every tick to verify persisted progress.
  for (let i = 0; i < 3; i++) {
    const worker = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
    await worker.tick()
  }
  indexJob = await prisma.monitorJob.findUniqueOrThrow({ where: { id: indexJob.id } })
  assert.equal(indexJob.status, 'COMPLETED')
  assert.equal(indexJob.page, 2)
  assert.equal(indexJob.processed, 1)
  assert.equal(indexCalls, 2)
  assert.equal(searchCalls, 0)
  assert.equal(parseCalls, 1)
  const linked = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: url } })
  const ours = await prisma.product.findUniqueOrThrow({ where: { oneCId: base + '-0' } })
  assert.equal(linked.productId, ours.id)
  assert.equal(ours.price, 92000)
  assert.equal((await prisma.competitorCatalogEntry.count()), 1)
  const matchJob = await prisma.monitorJob.findUniqueOrThrow({ where: { id: enqueued.id } })
  assert.equal(matchJob.processed, 1)
  assert.equal(matchJob.status, 'QUEUED')
  await monitor.tick()
  assert(searchCalls > 0, 'Missing index entry must fall back to live search')
  assert.equal((await prisma.monitorJob.findUniqueOrThrow({where:{id:matchJob.id}})).processed, 2)
  await monitor.cancelJob(matchJob.id)
  const indexedCount = await prisma.monitorJob.count({ where: { kind: 'INDEX_05RU' } })
  const direct = await monitor.autoFindOneCSection({ categoryPath, maxItems: 2000 })
  assert.equal(direct.queued, size)
  assert.deepEqual(direct.visitedUrls, [])
  assert.equal(await prisma.monitorJob.count({ where: { kind: 'INDEX_05RU' } }), indexedCount)
})


test('1C smartphones appear on the storefront only with available stock, and batch pricing is confirmed, atomic and fresh', async () => {
  // Previous test scenarios leave queued jobs; isolate these admin operations.
  await prisma.monitorJob.updateMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() } })
  const catId = randomUUID(), batch = randomUUID()
  const categoryPath = 'МОБИЛЬНАЯ СВЯЗЬ / Смартфоны / Смартфоны Apple ' + batch
  const oneCId = 'BULK-ONEC-' + batch, zeroId = 'EMPTY-ONEC-' + batch, unmatchedId = 'UNMATCHED-ONEC-' + batch
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: catId, name: categoryPath, slug: 'stock-test-' + batch }],
    products: [
      { oneCId, name: product.name, brand: 'Apple', sku: 'STOCK-' + batch,
        slug: 'stock-' + batch, categoryOneCId: catId, stockQty: 3, price: 91000, costPrice: 70000 },
      { oneCId: zeroId, name: 'Apple iPhone 17 Pro Max 256 Гб синий',
        brand: 'Apple', sku: 'EMPTY-' + batch, slug: 'empty-' + batch,
        categoryOneCId: catId, stockQty: 0, price: 95000, costPrice: 70000 },
      { oneCId: unmatchedId, name: 'Apple iPhone 17 Pro 512 Гб белый',
        brand: 'Apple', sku: 'UNMATCHED-' + batch, slug: 'unmatched-' + batch,
        categoryOneCId: catId, stockQty: 2, price: 96000, costPrice: 70000 },
    ],
  })
  const site = new ProductsService(prisma, { log: async () => {} })
  let storefront = await site.list()
  assert(storefront.some(row => row.oneCId === oneCId))
  assert(!storefront.some(row => row.oneCId === zeroId))
  const before = await prisma.product.findUniqueOrThrow({ where: { oneCId } })
  const link = 'https://05.ru/cat/396f7486/p/smartfon-iphone-17-pro-256-orange-' + batch.replace(/-/g, '') + '/'
  const parser = { parse: async (url) => ({ ...extractFiveRu(fixture.snapshot, fixture.sourceUrl), url }) }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const observation = await monitor.check({ url: link, productId: before.id })
  assert.equal(observation.latestPrice, 96990)
  await monitor.confirm(observation.id, before.id)
  const scope = { categoryPath }
  const preview = await monitor.previewBulkPrices(scope)
  assert.equal(preview.count, 1)
  assert.equal(preview.totalScope, 2)
  assert.equal(preview.skipped, 1)
  assert.equal(preview.items[0].newPrice, 96490)
  assert.equal(preview.items[0].oldPrice, 91000)
  await assert.rejects(
    () => monitor.applyBulkPrices({ ...scope, token: 'incorrect', acceptUnknownCost: false, acceptLargeChange: false }),
    /Обнови предварительный просмотр/
  )
  const applied = await monitor.applyBulkPrices({
    ...scope, token: preview.token, acceptUnknownCost: false, acceptLargeChange: false,
  })
  assert.equal(applied.applied, 1)
  assert.equal(applied.siteOnly, 1)
  assert.equal(applied.oneCQueued, 0)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId } })).price, 96490)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: zeroId } })).price, 95000)
  await assert.rejects(() => monitor.applyBulkPrices({
    ...scope, token: preview.token, acceptUnknownCost: false, acceptLargeChange: false,
  }), /Обнови предварительный просмотр/)
  const completedPreview = await monitor.previewBulkPrices(scope)
  assert.equal(completedPreview.count, 0)

  await prisma.product.update({ where: { id: before.id }, data: { price: 91000 } })
  await prisma.competitorProduct.update({ where: { id: observation.id },
    data: { lastSuccessAt: new Date(Date.now() - 48 * 3600_000) } })
  assert.equal((await monitor.previewBulkPrices(scope)).count, 0)
  // 1C stock import updates a product by immutable GUID; stock arriving later
  // activates its existing URL again, without creating duplicates.
  await integration.importCatalog({
    categories: [],
    products: [{ oneCId: zeroId, name: 'Apple iPhone 17 Pro Max 256 Гб синий',
      brand: 'Apple', sku: 'EMPTY-' + batch, slug: 'empty-' + batch,
      categoryOneCId: catId, stockQty: 4, price: 95000, costPrice: 70000 }],
  })
  storefront = await site.list()
  assert(storefront.some(row => row.oneCId === zeroId))
  assert.equal(await prisma.product.count({ where: { oneCId: zeroId } }), 1)
})

test('In-stock smartphone-only auto matching excludes other 1C categories and zero-stock phone SKUs', async () => {
  // Previous test scenarios leave queued jobs; isolate these admin operations.
  await prisma.monitorJob.updateMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() } })
  const base = randomUUID(), catId = randomUUID(), otherId = randomUUID()
  const categoryName = 'МОБИЛЬНАЯ СВЯЗЬ / Смартфоны / iPhone ' + base
  const integration = new IntegrationsService(prisma, {})
  const all = [
    { oneCId: 'ACTIVE-' + base, sku: 'A-' + base, slug: 'a-' + base,
      name: 'iPhone 17 Pro 256 Гб оранжевый', brand: 'Apple', categoryOneCId: catId,
      price: 92000, stockQty: 1 },
    { oneCId: 'ZERO-' + base, sku: 'Z-' + base, slug: 'z-' + base,
      name: 'iPhone 17 Pro 512 Гб синий', brand: 'Apple', categoryOneCId: catId,
      price: 93000, stockQty: 0 },
    { oneCId: 'CASE-' + base, sku: 'C-' + base, slug: 'c-' + base,
      name: 'Чехол iPhone 17 Pro', brand: 'Apple', categoryOneCId: otherId,
      price: 2000, stockQty: 10 },
  ]
  await integration.importCatalog({
    categories: [
      { oneCId: catId, name: categoryName, slug: 'iph-' + base },
      { oneCId: otherId, name: 'Аксессуары ' + base, slug: 'accessories-' + base },
    ], products: all,
  })
  const monitor = new PriceMonitorService(prisma, {
    searchProducts: async () => [], parse: async () => { throw new Error('Not needed') },
  }, new MonitorExchangeService(prisma))
  const job = await monitor.autoFindOneCSection({
    categoryPath: '', maxItems: 5000, onlyInStockSmartphones: true,
  })
  // Older tests may have imported other 1C smartphones. Scope to this one category
  // in a separate invocation after cancelling the all-scope job.
  assert(job.queued >= 1)
  assert(job.visitedUrls.includes('STOCKED_SMARTPHONES'))
  await monitor.cancelJob(job.id)
  const local = await monitor.autoFindOneCSection({
    categoryPath: categoryName, maxItems: 5000, onlyInStockSmartphones: true,
  })
  assert.equal(local.queued, 1)
  const active = await prisma.product.findUniqueOrThrow({ where: { oneCId: 'ACTIVE-' + base } })
  assert.deepEqual(local.pendingUrls, ['product:' + active.id])
  await monitor.cancelJob(local.id)
})


test('1C import skips duplicate iPhone variants with different GUIDs; updates same GUID and keeps real colour/storage/SIM variants', async () => {
  const batch = randomUUID()
  const categoryId = randomUUID()
  const categoryName = 'МОБИЛЬНАЯ СВЯЗЬ / Смартфоны / Смартфоны Apple ' + batch
  const importer = new IntegrationsService(prisma, {})
  const common = { brand: 'Apple', categoryOneCId: categoryId, price: 91900, stockQty: 2 }
  const base = { ...common, name: 'Смартфон Apple iPhone 17 Pro 256 Гб eSIM синий' }
  const rows = [
    { ...base, oneCId: 'ROOT-'+batch, sku:'ROOT-'+batch, slug:'root-'+batch },
    { ...base, oneCId: 'CLONE-'+batch, sku:'CLONE-'+batch, slug:'clone-'+batch },
    { ...base, name:'Смартфон Apple iPhone 17 Pro 512 Гб eSIM синий', oneCId:'MEM-'+batch, sku:'MEM-'+batch, slug:'mem-'+batch },
    { ...base, name:'Смартфон Apple iPhone 17 Pro 256 Гб eSIM белый', oneCId:'WHITE-'+batch, sku:'WHITE-'+batch, slug:'white-'+batch },
    { ...base, name:'Смартфон Apple iPhone 17 Pro 256 Гб nano SIM синий', oneCId:'SIM-'+batch, sku:'SIM-'+batch, slug:'sim-'+batch },
  ]
  const first = await importer.importCatalog({
    categories: [{ oneCId: categoryId, name: categoryName, slug: 'tree-'+batch }],
    products: rows,
  })
  assert.equal(first.products, 4)
  assert.equal(first.skippedDuplicates, 1)
  assert(first.duplicateExamples.includes(base.name))
  assert.equal(await prisma.product.count({ where: { oneCId: 'CLONE-'+batch } }), 0)
  assert.equal(await prisma.product.count({ where: { oneCId: { in: rows.map(p => p.oneCId) } } }), 4)
  const primary = await prisma.product.findUniqueOrThrow({ where: { oneCId: 'ROOT-'+batch } })
  const next = await importer.importCatalog({
    categories: [],
    products: [{ ...rows[0], price: 88900, stockQty: 5 }],
  })
  assert.equal(next.skippedDuplicates, 0)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: 'ROOT-'+batch } })).id, primary.id)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: 'ROOT-'+batch } })).stockQty, 5)

  // A changed SKU may belong to another physical variant: it must NEVER
  // silently take ownership of an existing 1C GUID.
  await assert.rejects(
    () => importer.importCatalog({
      categories: [],
      products: [{ ...rows[0], name: 'Смартфон Apple iPhone 17 Pro 1 Тб eSIM оранжевый',
        oneCId: 'CONFLICT-'+batch, price: 100000 }],
    }), /Конфликт идентификаторов 1С/
  )
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: primary.id } })).oneCId, 'ROOT-'+batch)
})

test('Legacy duplicate 1C records show as one public phone, remain accessible to admin and are never deleted', async () => {
  const batch = randomUUID()
  const categoryId = randomUUID()
  const importer = new IntegrationsService(prisma, {})
  const name = 'Смартфон Apple iPhone 17 Pro Max 512 Гб eSIM белый'
  const path = 'МОБИЛЬНАЯ СВЯЗЬ / Смартфоны / Смартфоны Apple ' + batch
  await importer.importCatalog({
    categories: [{ oneCId: categoryId, name: path, slug:'old-dupes-'+batch }],
    products: [{ oneCId:'KEEP-'+batch, sku:'KEEP-'+batch, slug:'keep-'+batch,
      name, brand:'Apple', categoryOneCId:categoryId, price: 120000, stockQty: 3 }],
  })
  const c = await prisma.category.findFirstOrThrow({ where: { oneCId: categoryId } })
  const legacy = await prisma.product.create({ data: {
    oneCId:'LEGACY-'+batch, sku:'LEGACY-'+batch, slug:'legacy-'+batch,
    name, brand:'Apple', categoryId:c.id, price: 121000, stockQty: 2, status:'ACTIVE',
  } })
  const service = new ProductsService(prisma, { log: async () => {} })
  const site = await service.list()
  assert.equal(site.filter(p => p.category.id === c.id).length, 1)
  const admin = await service.adminList()
  const oldRows = admin.filter(p => p.category.id === c.id)
  assert.equal(oldRows.length, 2)
  assert.equal(oldRows.filter(p => p.duplicateOf !== null).length, 1)
  assert.equal(await prisma.product.count({ where: { id: legacy.id } }), 1)
  const reimport = await importer.importCatalog({ categories: [], products: [{
    oneCId:'LEGACY-'+batch, sku:'LEGACY-'+batch, slug:'legacy-'+batch,
    name, brand:'Apple', categoryOneCId:categoryId, price: 121000, stockQty: 2,
  }] })
  assert.equal(reimport.skippedDuplicates, 1)
  assert.equal(await prisma.product.count({ where: { categoryId: c.id } }), 2)
})


test('Compact iPhone accessory names keep compatibility separate from manufacturer and colour', () => {
  const names = [
    ['Накладка Green Lion Leather Case for iPhone 15Pro Max - Blue', 'iphone 15 pro max', 'blue'],
    ['Накладка Green Lion Leather Case for iPhone 15Pro - Black', 'iphone 15 pro', 'black'],
    ['Накладка Green Lion Case for iP15 ProGray/Blue', 'iphone 15 pro', 'blue'],
  ]
  for (const [name, model, color] of names) {
    const parsed = identity({ name, brand: 'Другие' })
    assert.equal(parsed.model, model)
    assert.equal(parsed.brand, 'green lion')
    assert.equal(parsed.color, color)
    assert(oneCSearchQueries({ name })[0].startsWith('green lion чехол iphone'))
  }
  const glass = identity({ name: 'Защитное стекло Green Lion Screen Protector for iPhone 15Pro - Clear' })
  assert.equal(glass.color, undefined) // Green is part of the manufacturer, not the finish.
  assert.equal(glass.brand, 'green lion')
  const links = rankSearchLinks([{url:'https://05.ru/cat/cases/p/iphone-15-pro-max-123/', title:'Чехол Green Lion для iPhone 15 Pro Max'}], 'green lion чехол iphone 15Pro Max')
  assert.equal(links.length, 1)
  const monitor = new PriceMonitorService({}, {}, {})
  const check = compareItems({name:names[0][0]}, {name:'Чехол Green Lion Other Series iPhone 15 Pro Max Blue'})
  assert.equal(monitor.strongVariant(check), false)
  assert(compareItems({name:names[0][0]}, {name:'Чехол G-Case iPhone 15 Pro Max Blue', brand:'G-Case'}).conflicts.includes('бренд'))
})


test('Complete smartphone variants auto-confirm; incomplete or conflicting variants do not', () => {
  const complete = { name: 'Apple iPhone 17 Pro 12GB/256GB Cosmic Orange eSIM', brand: 'Apple' }
  assert.equal(compareItems(complete, complete).canAutoConfirm, true)
  for (const name of ['Apple iPhone 17 Pro 12GB/256GB Cosmic Orange',
    'Apple iPhone 17 Pro 12GB/512GB Cosmic Orange eSIM',
    'Apple iPhone 17 Pro 12GB/256GB Blue eSIM']) {
    assert.equal(compareItems(complete, {name, brand:'Apple'}).canAutoConfirm, false)
  }
})

test('Competitor catalog import never creates draft store inventory', async () => {
  const url = fixture.sourceUrl.replace('24007/', randomUUID() + '/')
  const before = await prisma.product.count()
  const parser = { discover:async () => ({urls:[url], title:'Аксессуары', discovered:1}),
    parse:async () => ({...extractFiveRu(fixture.snapshot, fixture.sourceUrl), url}) }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const result = await monitor.importFiveRuCatalog({url:'https://05.ru/cat/test/',limit:1})
  assert.equal(result.imported,1)
  assert.equal(await prisma.product.count(), before)
  assert(await prisma.competitorProduct.findUnique({where:{externalUrl:url}}))
})
