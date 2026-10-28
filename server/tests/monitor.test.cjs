const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { writeFileSync, unlinkSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { PrismaClient } = require('@prisma/client')
const { compareItems, identity, validGtin, recommendation } = require('../dist/price-monitor/product-matching')
const { extractFiveRu, fiveRuUrl, priceNumber, FiveRuParser } = require('../dist/price-monitor/five-ru.parser')
const { PriceMonitorService, oneCSearchQueries } = require('../dist/price-monitor/price-monitor.service')
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


test('Search ranking promotes Xiaomi 15T Pro beyond the first 12 unrelated links', () => {
  const target = 'https://05.ru/cat/396f7486/p/smartfon-xiaomi-15t-pro-12-gb-512-gb-cherniy-25708/'
  const noise = Array.from({ length: 15 }, (_, i) => ({
    url: 'https://05.ru/cat/396f7486/p/smartfon-xiaomi-15t-12-gb-512-gb-seriy-' + i + '/',
    title: 'Смартфон Xiaomi 15T 12 Гб/512 Гб серый',
  }))
  const candidates = [...noise, { url: target, title: 'Смартфон Xiaomi 15T Pro 12 Гб/512 Гб черный' }]
  assert.equal(rankSearchLinks(candidates, 'xiaomi 15t pro 512', 8)[0], target)
  assert.equal(rankSearchLinks([...candidates, candidates.at(-1)], 'xiaomi 15t pro', 20).length, 16)
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
  assert.equal(link.matchStatus, 'SUGGESTED')
  assert.equal((await exchange.pending()).items.length, 0)
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
  assert.equal(searches, 1)
  const matched = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: sourceUrl } })
  const original = await prisma.product.findUniqueOrThrow({ where: { oneCId: id } })
  assert.equal(matched.productId, original.id)
  assert.equal(original.price, 99990)
  assert(['SUGGESTED', 'CONFIRMED'].includes(matched.matchStatus))
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

  // A later failed direct check must not leave a seemingly fresh price recommendation.
  const failing = new PriceMonitorService(prisma, {
    searchProducts: async () => { throw new Error('Search should not be called') },
    parse: async () => { throw new Error('HTTP 500: product page unavailable') },
  }, new MonitorExchangeService(prisma))
  await failing.autoFindOneCSection({ categoryPath, maxItems: 10 })
  await failing.tick()
  const newest = (await failing.jobs()).find(job => job.kind === 'MATCH_1C' && job.url === categoryPath)
  const last = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: existingUrl } })
  assert.equal(newest.status, 'COMPLETED')
  assert.equal(newest.errors, 1)
  assert.match(newest.lastError, /повторная проверка не удалась/)
  assert.match(last.lastError, /HTTP 500/)
  assert.equal(last.latestPrice, 94990)
})

test('05.ru auto-search reuses one browser, caches identical names and never fetches more than three cards at once', async () => {
  const parser = new FiveRuParser()
  let launches = 0, closings = 0, contexts = 0, active = 0, maxActive = 0, cardOpens = 0
  const links = Array.from({ length: 7 }, (_, i) => 'https://05.ru/cat/mc/p/iphone-variant-' + (i+1) + '/')
  const fakeSearchPage = {
    goto: async () => ({ status: () => 200 }),
    locator: selector => selector.startsWith('input')
      ? { first: () => ({ waitFor: async () => {}, fill: async () => {}, press: async () => {} }) }
      : { first: () => ({ waitFor: async () => {} }),
          evaluateAll: async () => links },
    waitForTimeout: async () => {},
    url: () => 'https://05.ru/search/',
    close: async () => {},
  }
  parser.browser = async () => {
    launches++
    return { isConnected: () => true, close: async () => { closings++ } }
  }
  parser.context = async () => {
    contexts++
    return { newPage: async () => fakeSearchPage, close: async () => {} }
  }
  parser.open = async (_, url) => {
    cardOpens++
    return { url, close: async () => {} }
  }
  parser.snapshot = async () => {
    active++; maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 12))
    active--
    return fixture.snapshot
  }
  try {
    const trace = {}
    const result = await parser.searchProducts('Xiaomi Redmi', 7, trace)
    assert.equal(result.length, 7)
    assert.equal(trace.linksFound, 7)
    assert.equal(trace.cardsParsed, 7)
    assert.deepEqual(trace.rejectedCards, [])
    assert.equal(launches, 1)
    assert.equal(cardOpens, 7)
    assert.equal(maxActive, 3)
    const cachedTrace = {}
    const repeated = await parser.searchProducts('  Xiaomi Redmi ', 7, cachedTrace)
    assert.equal(repeated.length, 7)
    assert.equal(cachedTrace.cached, true)
    assert.equal(cachedTrace.cardsParsed, 7)
    assert.equal(cardOpens, 7) // identical query comes from short-lived result cache
    const other = await parser.searchProducts('Xiaomi Redmi Note', 7)
    assert.equal(other.length, 7)
    assert.equal(launches, 1) // other products use the same browser
    assert.equal(contexts, 2) // but a separate isolated context
    parser.snapshot = async () => ({ ...fixture.snapshot, h1: '', scripts: [], metaPrice: null, domPrice: null })
    const failedTrace = {}
    await assert.rejects(() => parser.searchProducts('Broken product', 7, failedTrace), /карточки не прочитаны/)
    assert.equal(failedTrace.cardsParsed, 0)
    assert(failedTrace.rejectedCards.length > 0)
    // A non-working storefront search widget is not a "product not found" result.
    links.length = 0
    fakeSearchPage.url = () => 'https://05.ru/'
    await assert.rejects(() => parser.searchProducts('iphone 17 pro 512', 7),
      /не открыл выдачу/)
  } finally { await parser.onModuleDestroy() }
  assert.equal(closings, 1)
})
