const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const { rmSync, writeFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { PrismaClient } = require('@prisma/client')
const { PriceUpdateWorkflow } = require('../dist/price-monitor/price-update.workflow')
const { PriceMonitorService } = require('../dist/price-monitor/price-monitor.service')
const { MonitorExchangeService } = require('../dist/price-monitor/monitor-exchange.service')
const { OneCPriceSyncService } = require('../dist/integrations/price-sync.service')
const { fingerprint } = require('../dist/price-monitor/product-matching')
let prisma, database, previousKind, previousEnabled

before(async () => {
  previousKind = process.env.ONE_C_BASE_KIND
  previousEnabled = process.env.ONE_C_TEST_PRICE_SYNC_ENABLED
  process.env.ONE_C_BASE_KIND = 'TEST'
  process.env.ONE_C_TEST_PRICE_SYNC_ENABLED = 'true'
  database = resolve(__dirname, '../prisma/monitor-test-update-' + randomUUID() + '.db')
  writeFileSync(database, '')
  const push = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], {
    cwd: resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: 'file:' + database.replace(/\\/g, '/') }, encoding: 'utf8',
  })
  assert.equal(push.status, 0, push.stdout + push.stderr)
  prisma = new PrismaClient({ datasources: { db: { url: 'file:' + database.replace(/\\/g, '/') } } })
})
after(async () => {
  await prisma?.$disconnect()
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(database + suffix, { force: true })
  for (const [key, previous] of [['ONE_C_BASE_KIND', previousKind], ['ONE_C_TEST_PRICE_SYNC_ENABLED', previousEnabled]]) {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous
  }
})

async function fixture() {
  // Each test owns a new set of products and resets the singleton coordinator.
  await prisma.monitorJob.deleteMany()
  await prisma.oneCPriceChange.deleteMany()
  await prisma.competitorCatalogEntry.deleteMany()
  await prisma.product.updateMany({ data: { priceSyncEnabled: false, status: 'ARCHIVED' } })
  const key = randomUUID()
  const category = await prisma.category.create({ data: { name: 'Смартфоны / ' + key, slug: key } })
  const source = await prisma.competitorSource.upsert({ where: { key: '05ru' }, create: { key: '05ru', name: '05.ru', baseUrl: 'https://05.ru' }, update: {} })
  const monitor = new PriceMonitorService(prisma, {}, new MonitorExchangeService(prisma), {}, {})
  const workflow = new PriceUpdateWorkflow(prisma, db => monitor.bulkPriceSnapshot(db), async () => true)
  async function product(overrides = {}, external = {}) {
    const key = randomUUID()
    const product = await prisma.product.create({ data: {
      oneCId: randomUUID(), sku: key, slug: key, name: 'Смартфон Apple iPhone 15 128 Гб черный',
      brand: 'Apple', price: 50000, stockQty: 1, categoryId: category.id, ...overrides,
    } })
    const externalName = external.externalName || product.name
    const link = await prisma.competitorProduct.create({ data: {
      sourceId: source.id, productId: product.id, externalUrl: 'https://05.ru/cat/test/p/' + key + '/',
      externalName, matchStatus: 'CONFIRMED', latestPrice: 49100, inStock: true,
      priceSource: 'PRODUCT_PAGE', lastSuccessAt: new Date(), lastCheckedAt: new Date(),
      confirmedFingerprint: fingerprint({ name: externalName, attributes: {} }),
      confirmedProductFingerprint: fingerprint(product), attributes: {}, ...external,
    } })
    await prisma.competitorPriceHistory.create({ data: { competitorProductId: link.id, price: link.latestPrice, inStock: true } })
    return { ...product, link }
  }
  async function checked() {
    const job = await prisma.monitorJob.findUniqueOrThrow({ where: { id: 'test-price-update-current' } })
    if (job.visitedUrls.childId) await prisma.monitorJob.update({ where: { id: job.visitedUrls.childId }, data: { status: 'COMPLETED', pendingUrls: [] } })
  }
  return { product, workflow, monitor, checked, sync: new OneCPriceSyncService(prisma) }
}

test('one click replaces idle accessory scope, stages 35 verified prices as 30+5, resumes after restart and only receipts publish', async () => {
  const { product, workflow, monitor, checked, sync } = await fixture()
  const idle = []
  for (let i = 0; i < 30; i++) idle.push(await product({ priceSyncEnabled: true, name: 'Чехол ' + i }))
  // A pre-existing pending item locks the whole scope until that agent session drains.
  const old = await prisma.oneCPriceChange.create({ data: { productId: idle[0].id, oneCId: idle[0].oneCId, oldPrice: 50000, newPrice: 50000 } })
  const products = []
  for (let i = 0; i < 35; i++) products.push(await product())
  const operation = await workflow.start(products.map(p => p.id))
  assert.equal(operation.total, 35)
  assert.equal((await workflow.start([idle[0].id])).id, operation.id, 'duplicate press returns the same fixed selection')
  await checked()
  for (let i = 0; i < 35; i++) await workflow.advance()
  let status = await workflow.current()
  assert.equal(status.ready, 35)
  assert.equal(status.queued, 0)
  assert.equal(status.state, 'WAITING')
  assert.deepEqual((await sync.scope()).map(p => p.id).sort((a, b) => a - b), idle.map(p => p.id).sort((a, b) => a - b), 'pending protects every old scope permission')
  assert.equal((await sync.pending()).items[0].id, old.id)
  await sync.receipts({ items: [{ id: old.id, appliedPrice: 50000 }] })
  // A fresh coordinator instance uses persisted selection and progress.
  const resumed = new PriceUpdateWorkflow(prisma, db => monitor.bulkPriceSnapshot(db), async () => { throw new Error('already checked products must not be reprocessed') })
  await resumed.advance()
  status = await resumed.current()
  assert.equal(status.queued, 30)
  assert.equal(status.pending, 30)
  assert.equal(status.ready, 5)
  assert.equal(status.applied, 0)
  assert.equal((await sync.scope()).length, 30)
  assert((await sync.scope()).every(p => products.slice(0, 30).some(candidate => candidate.id === p.id)))
  assert.equal(await prisma.product.count({ where: { id: { in: products.map(p => p.id) }, price: 50000 } }), 35, 'queueing does not publish prices')
  await sync.heartbeat({ state: 'idle', applied: 30 })
  assert.equal((await resumed.current()).applied, 0, 'heartbeat is not a receipt')
  await sync.heartbeat({ state: 'processing' })
  for (let i = 0; i < 3; i++) {
    const packet = await sync.pending()
    assert.equal(packet.items.length, 10)
    await sync.receipts({ items: packet.items.map(change => ({ id: change.id, appliedPrice: change.targetPrice })) })
  }
  await resumed.advance()
  assert.equal((await resumed.current()).pending, 0, 'do not rotate the cached 1C scope until that session exits')
  assert.equal((await resumed.current()).ready, 5)
  await sync.heartbeat({ state: 'idle', applied: 30 })
  await resumed.advance()
  status = await resumed.current()
  assert.equal(status.applied, 30)
  assert.equal(status.pending, 5)
  assert.equal(status.queued, 35)
  assert.equal((await sync.scope()).length, 5)
  const packet = await sync.pending()
  await sync.receipts({ items: packet.items.map(change => ({ id: change.id, appliedPrice: change.targetPrice })) })
  await resumed.advance()
  status = await resumed.current()
  assert.equal(status.state, 'COMPLETED')
  assert.equal(status.applied, 35)
  assert.equal(await prisma.product.count({ where: { id: { in: products.map(p => p.id) }, price: 49000 } }), 35)
})

test('one click keeps identity, file, stock, stale-price and 10% blockers; cancellation preserves queued failures', async () => {
  const { product, workflow, checked, sync } = await fixture()
  const good = await product()
  const wrongMemory = await product({}, { externalName: 'Смартфон Apple iPhone 15 256 Гб черный' })
  const wrongColor = await product({}, { externalName: 'Смартфон Apple iPhone 15 128 Гб белый' })
  const used = await product({}, { externalName: 'Смартфон Apple iPhone 15 128 Гб черный б/у' })
  const file = await product({}, { priceSource: 'USER_FILE' })
  const stock = await product({ stockQty: 0 })
  const large = await product({ price: 60000 })
  const stale = await product({}, { lastSuccessAt: new Date(Date.now() - 25 * 3600000) })
  const products = [good, wrongMemory, wrongColor, used, file, stock, large, stale]
  const operation = await workflow.start(products.map(p => p.id))
  await checked()
  for (let i = 0; i < products.length; i++) await workflow.advance()
  const status = await workflow.current()
  assert.equal(status.queued, 1)
  assert.equal(status.skipped, 7)
  for (const id of [wrongMemory.id, wrongColor.id, used.id]) assert.match(status.items.find(item => item.productId === id).reason, /не совпадает/)
  assert.match(status.items.find(item => item.productId === large.id).reason, /10%/)
  const message = (await sync.pending()).items[0]
  await sync.receipts({ items: [{ id: message.id, error: 'Не удалось провести документ' }] })
  await workflow.advance()
  const failed = await workflow.current()
  assert.equal(failed.pending, 1)
  assert.equal(failed.applied, 0)
  assert.match(failed.items.find(item => item.productId === good.id).reason, /провести/)
  const cancelled = await workflow.cancel(operation.id)
  assert.equal(cancelled.state, 'CANCELLED')
  assert.equal(cancelled.pending, 1)
  assert.equal((await sync.pending()).items[0].id, message.id)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: good.id } })).price, 50000)
})

test('worker rechecks the real saved card, respects TEST switches, database lease and recovers completed matching cursor', async () => {
  const { product, checked } = await fixture()
  const imported = await product()
  const calls = []
  const parser = { parse: async url => {
    calls.push(url)
    return { url, name: imported.name, brand: 'Apple', attributes: {}, price: 49100,
      oldPrice: null, inStock: true, priceSource: 'PRODUCT_PAGE', seller: null, region: null }
  } }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma), {}, {})
  process.env.ONE_C_BASE_KIND = 'PRODUCTION'
  await assert.rejects(() => monitor.startPriceUpdate({ productIds: [imported.id] }), /отключена/)
  assert.equal(await prisma.monitorJob.count(), 0)
  process.env.ONE_C_BASE_KIND = 'TEST'
  const started = await monitor.startPriceUpdate({ productIds: [imported.id] })
  await checked() // Simulate a restart after the child saved its completed cursor.
  await prisma.monitorJob.update({ where: { id: 'test-price-update-current' }, data: { leaseUntil: new Date(Date.now() + 60000) } })
  await monitor.priceUpdate.advance()
  assert.equal(calls.length, 0, 'an unexpired lease protects another coordinator')
  await prisma.monitorJob.update({ where: { id: 'test-price-update-current' }, data: { leaseUntil: new Date(Date.now() - 1) } })
  await monitor.priceUpdate.advance()
  assert.deepEqual(calls, [imported.link.externalUrl], 'fresh parse of actual source URL before queue')
  const current = await monitor.currentPriceUpdate()
  assert.equal(current.id, started.id)
  assert.equal(current.pending, 1)
  assert.equal(current.applied, 0)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: imported.id } })).price, 50000)
})

test('workflow replaces a freshly disproved legacy 128GB used link with a unique exact 256GB card in the same click', async () => {
  const { product } = await fixture()
  const imported = await product({ name: 'Смартфон Apple iPhone 15 256 Гб черный' }, {
    externalName: 'Смартфон Apple iPhone 15 128 Гб черный б/у',
  })
  const correctUrl = 'https://05.ru/cat/test/p/correct-' + randomUUID() + '/'
  await prisma.competitorCatalogEntry.create({ data: { externalUrl: correctUrl, title: imported.name, model: 'iphone 15', storage: '256', color: 'black' } })
  const calls = []
  const parser = { parse: async url => {
    calls.push(url)
    return { url, name: url === imported.link.externalUrl ? imported.link.externalName : imported.name,
      brand: 'Apple', attributes: {}, price: 49100, inStock: true, priceSource: 'PRODUCT_PAGE' }
  }, searchProducts: async () => { throw new Error('unique saved index hint should be enough') } }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma), {}, {})
  await monitor.startPriceUpdate({ productIds: [imported.id] })
  await monitor.tick()
  await monitor.tick()
  const status = await monitor.currentPriceUpdate()
  assert.equal(status.pending, 1)
  assert.equal(status.applied, 0)
  const old = await prisma.competitorProduct.findUniqueOrThrow({ where: { id: imported.link.id } })
  assert.equal(old.matchStatus, 'REVIEW_REQUIRED')
  assert.equal(old.productId, null, 'disproved binding is detached, its history retained')
  const replacement = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: correctUrl } })
  assert.equal(replacement.productId, imported.id)
  assert.equal(replacement.matchStatus, 'CONFIRMED')
  assert.equal((await prisma.oneCPriceChange.findFirstOrThrow({ where: { productId: imported.id } })).sourceLinkId, replacement.id)
  assert.deepEqual(calls, [imported.link.externalUrl, correctUrl, correctUrl], 'replacement is reread fresh before queueing')
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: imported.id } })).price, 50000)
})

test('workflow leaves ambiguous or manual-review alternatives unqueued after disproving a legacy card', async () => {
  const { product } = await fixture()
  const imported = await product({ name: 'Смартфон Apple iPhone 15 256 Гб черный' }, {
    externalName: 'Смартфон Apple iPhone 15 128 Гб черный б/у',
  })
  const exactName = imported.name
  const candidates = [exactName, exactName + ' (E-Sim)'].map((name, i) => ({
    url: 'https://05.ru/cat/test/p/ambiguous-' + i + '-' + randomUUID() + '/',
    name, brand: 'Apple', attributes: {}, price: 49100, inStock: true, priceSource: 'PRODUCT_PAGE',
  }))
  for (const result of candidates) await prisma.competitorCatalogEntry.create({ data: {
    externalUrl: result.url, title: result.name, model: 'iphone 15', storage: '256', color: 'black',
  } })
  const parser = { parse: async url => candidates.find(result => result.url === url) || {
    url, name: imported.link.externalName, attributes: {}, price: 49100, inStock: true, priceSource: 'PRODUCT_PAGE',
  } }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma), {}, {})
  await monitor.startPriceUpdate({ productIds: [imported.id] })
  await monitor.tick()
  await monitor.tick()
  const status = await monitor.currentPriceUpdate()
  assert.equal(status.queued, 0)
  assert.equal(status.skipped, 1)
  assert.equal(status.state, 'PARTIAL')
  assert.equal(await prisma.oneCPriceChange.count(), 0)
  assert.equal((await prisma.competitorProduct.findUniqueOrThrow({ where: { id: imported.link.id } })).productId, imported.id, 'ambiguous discovery does not remove even the old binding')
  assert.equal(await prisma.competitorProduct.count({ where: { productId: imported.id, matchStatus: 'CONFIRMED' } }), 0)
})
