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
  const workflow = new PriceUpdateWorkflow(prisma, db => monitor.bulkPriceSnapshot(db))
  async function product(overrides = {}, external = {}) {
    const key = randomUUID()
    const product = await prisma.product.create({ data: {
      oneCId: randomUUID(), sku: key, slug: key, name: 'Смартфон Apple iPhone 15 128 Гб черный',
      brand: 'Apple', price: 50000, costPrice: 40000, stockQty: 1, priceSyncEnabled: true, categoryId: category.id, ...overrides,
    } })
    const externalName = external.externalName || product.name
    const link = await prisma.competitorProduct.create({ data: {
      sourceId: source.id, productId: product.id, externalUrl: 'https://05.ru/cat/test/p/' + key + '/',
      externalName, matchStatus: 'CONFIRMED', latestPrice: 49100, inStock: true,
      priceSource: 'PRODUCT_PAGE', lastSuccessAt: new Date(), lastCheckedAt: new Date(),
      confirmedFingerprint: fingerprint({ name: externalName, attributes: {} }),
      confirmedProductFingerprint: fingerprint(product), attributes: {}, ...external,
    } })
    if (link.latestPrice !== null) await prisma.competitorPriceHistory.create({ data: { competitorProductId: link.id, price: link.latestPrice, inStock: true } })
    return { ...product, link }
  }
  return { product, workflow, monitor, sync: new OneCPriceSyncService(prisma) }
}

test('150 products: default update queues only the 30 permitted ones without parsing or changing scope', async () => {
  const { product, workflow, monitor, sync } = await fixture()
  const allowed = [], outside = []
  for (let i = 0; i < 30; i++) allowed.push(await product())
  for (let i = 0; i < 120; i++) outside.push(await product({ priceSyncEnabled: false }))
  const before = await monitor.priceReadiness()
  assert.equal(before.items.filter(row => row.status === 'READY').length, 30)
  assert.equal(before.items.filter(row => row.status === 'BLOCKED').length, 120)
  const operation = await workflow.start()
  assert.equal(operation.total, 30)
  assert.equal(operation.ready, 30)
  assert.equal((await workflow.start([outside[0].id])).id, operation.id)
  assert.equal(await prisma.monitorJob.count({ where: { kind: 'MATCH_1C' } }), 0)
  const resumed = new PriceUpdateWorkflow(prisma, db => monitor.bulkPriceSnapshot(db))
  await resumed.advance()
  assert.equal((await resumed.current()).pending, 30)
  assert.equal((await sync.scope()).length, 30)
  assert.equal(await prisma.product.count({ where: { id: { in: outside.map(p => p.id) }, priceSyncEnabled: true } }), 0)
  assert.equal(await prisma.product.count({ where: { id: { in: allowed.map(p => p.id) }, price: 50000 } }), 30)
  for (let i = 0; i < 3; i++) {
    const packet = await sync.pending()
    await sync.receipts({ items: packet.items.map(row => ({ id: row.id, appliedPrice: row.targetPrice })) })
  }
  await resumed.advance()
  assert.equal((await resumed.current()).applied, 30)
  assert.equal((await resumed.current()).state, 'COMPLETED')
  const after = await monitor.priceReadiness()
  assert.equal(after.items.filter(row => row.status === 'READY').length, 0)
  assert.equal(after.items.filter(row => row.reason?.includes('уже совпадает')).length, 30)
  const recheck = await monitor.checkAllowedPrices()
  assert.equal(recheck.queued, 30)
  const job = await prisma.monitorJob.findUniqueOrThrow({ where: { id: recheck.id } })
  assert(job.pendingUrls.every(url => allowed.some(product => product.link.externalUrl === url)))
})

test('startup connects every existing TEST import and an old agent drains more than thirty changes safely', async () => {
  const { product, sync } = await fixture()
  const products = []
  for (let i = 0; i < 75; i++) products.push(await product({ priceSyncEnabled: false }))
  const manual = await prisma.product.create({ data: { categoryId: products[0].categoryId, name: 'Local only', brand: 'Test', price: 1000, sku: randomUUID(), slug: randomUUID() } })
  process.env.ONE_C_BASE_KIND = 'PRODUCTION'
  await sync.onApplicationBootstrap()
  assert.equal((await sync.scope()).length, 0)
  process.env.ONE_C_BASE_KIND = 'TEST'
  process.env.ONE_C_TEST_PRICE_SYNC_ENABLED = 'false'
  await sync.onApplicationBootstrap()
  assert.equal((await sync.scope()).length, 0)
  process.env.ONE_C_TEST_PRICE_SYNC_ENABLED = 'true'
  await sync.onApplicationBootstrap()
  await sync.configureScope({ oneCIds: [products[0].oneCId] })
  assert.equal((await sync.scope()).filter(p => products.some(item => item.id === p.id)).length, 75)
  assert.equal((await prisma.product.findUnique({ where: { id: manual.id } })).priceSyncEnabled, false)
  assert.equal(await prisma.oneCPriceChange.count(), 0, 'automatic eligibility never sends prices')
  const logs = await prisma.syncLog.count({ where: { entity: 'PRICE_SYNC_SCOPE' } })
  await sync.onApplicationBootstrap()
  assert.equal(await prisma.syncLog.count({ where: { entity: 'PRICE_SYNC_SCOPE' } }), logs, 'restart does not create duplicate grant logs')
  for (const p of products) await OneCPriceSyncService.queue(prisma, { ...p, priceSyncEnabled: true }, 49000, p.link.id)
  let sessions = 0, delivered = 0
  while ((await sync.pending()).items.length) {
    const window = await sync.scopeForAgent()
    assert(window.length > 0 && window.length <= 30)
    const allowed = new Set(window.map(p => p.oneCId))
    for (let batch = 0; batch < 3; batch++) {
      const pending = (await sync.pending()).items
      if (!pending.length) break
      assert(pending.length <= 10)
      assert(pending.every(p => allowed.has(p.oneCId)), 'pending batches must stay in the session scope')
      await sync.receipts({ items: pending.map(p => ({ id: p.id, appliedPrice: p.targetPrice })) })
      delivered += pending.length
    }
    sessions++
  }
  assert.equal(sessions, 3)
  assert.equal(delivered, 75)
  assert.equal(await prisma.product.count({ where: { id: { in: products.map(p => p.id) }, price: 49000, priceSyncEnabled: true } }), 75)
  const archived = await prisma.oneCPriceChange.create({ data: { productId: products[0].id, oneCId: products[0].oneCId, oldPrice: 49000, newPrice: 48000, sourceLinkId: products[0].link.id } })
  await prisma.product.update({ where: { id: products[0].id }, data: { status: 'ARCHIVED' } })
  assert.equal((await sync.scopeForAgent()).length, 0)
  assert.equal((await sync.pending()).items.length, 0)
  assert.equal((await prisma.oneCPriceChange.findUnique({ where: { id: archived.id } })).status, 'CANCELLED', 'a hidden product cannot stall the session window')
})

test('one update sends the entire automatic TEST catalog across successive agent sessions', async () => {
  const { product, workflow, sync } = await fixture()
  const products = []
  for (let i = 0; i < 45; i++) products.push(await product({ priceSyncEnabled: false }))
  await sync.onApplicationBootstrap()
  const operation = await workflow.start()
  assert.equal(operation.total, 45)
  assert.equal(operation.ready, 45)
  for (const size of [30, 15]) {
    await workflow.advance()
    assert.equal(await prisma.oneCPriceChange.count({ where: { status: 'PENDING' } }), size)
    assert.equal(await prisma.product.count({ where: { id: { in: products.map(p => p.id) }, priceSyncEnabled: true } }), 45)
    const session = new Set((await sync.scopeForAgent()).map(p => p.oneCId))
    while ((await sync.pending()).items.length) {
      const items = (await sync.pending()).items
      assert(items.every(p => session.has(p.oneCId)))
      await sync.receipts({ items: items.map(p => ({ id: p.id, appliedPrice: p.targetPrice })) })
    }
  }
  await workflow.advance()
  assert.equal((await workflow.current()).state, 'COMPLETED')
  assert.equal((await workflow.current()).applied, 45)
  assert.equal(await prisma.product.count({ where: { id: { in: products.map(p => p.id) }, price: 49000 } }), 45)
})

test('readiness includes missing links, missing prices, stale cards and pending changes; recheck targets saved permitted cards only', async () => {
  const { product, monitor, sync } = await fixture()
  const good = await product()
  const missing = await product()
  await prisma.competitorProduct.delete({ where: { id: missing.link.id } })
  const noPrice = await product({}, { latestPrice: null })
  const stale = await product({}, { lastSuccessAt: new Date(0) })
  const outside = await product({ priceSyncEnabled: false })
  const pending = await product()
  await prisma.oneCPriceChange.create({ data: { productId: pending.id, oneCId: pending.oneCId, oldPrice: pending.price, newPrice: 49000, sourceLinkId: pending.link.id } })
  const rows = (await monitor.priceReadiness()).items
  assert.equal(rows.find(row => row.productId === good.id).status, 'READY')
  assert.equal(rows.find(row => row.productId === missing.id).reason, 'Нет привязки к 05.ru')
  assert.match(rows.find(row => row.productId === noPrice.id).reason, /Нет актуальной цены/)
  assert.match(rows.find(row => row.productId === stale.id).reason, /устарела/)
  assert.equal(rows.find(row => row.productId === outside.id).reason, 'Не разрешён обмен с 1С')
  assert.equal(rows.find(row => row.productId === pending.id).status, 'PENDING')
  assert.equal(await prisma.monitorJob.count(), 0, 'readiness is read-only')
  const result = await monitor.checkAllowedPrices()
  const job = await prisma.monitorJob.findUniqueOrThrow({ where: { id: result.id } })
  assert.equal(job.kind, 'RECHECK')
  assert(!job.pendingUrls.includes(outside.link.externalUrl))
  assert(job.pendingUrls.includes(good.link.externalUrl))
  assert.equal((await sync.pending()).items.length, 1, 'recheck never queues prices')
})

test('a fast failed recheck remains visible in readiness after completion and reload without changing cached prices', async () => {
  const { product } = await fixture()
  const p = await product({}, { lastSuccessAt: new Date(0) })
  const monitor = new PriceMonitorService(prisma, { parse: async () => { throw Error('HTTP 403') } }, new MonitorExchangeService(prisma))
  const queued = await monitor.checkAllowedPrices()
  await prisma.monitorJob.update({ where: { id: queued.id }, data: { status: 'RUNNING' } })
  await monitor.recheckBatch(queued.id, queued.pendingUrls, '05ru')
  const view = await monitor.priceReadiness()
  assert.equal(view.checking, false)
  assert.equal(view.priceCheck.id, queued.id)
  assert.equal(view.priceCheck.status, 'FAILED')
  assert.equal(view.priceCheck.processed, 0)
  assert.equal(view.priceCheck.errors, 0, 'blocked pages remain queued for retry instead of counted as processed')
  assert.match(view.priceCheck.lastError, /HTTP 403/)
  assert(view.priceCheck.finishedAt)
  const reload = new PriceMonitorService(prisma, {}, new MonitorExchangeService(prisma))
  assert.equal((await reload.priceReadiness()).priceCheck.id, queued.id)
  const link = await prisma.competitorProduct.findUniqueOrThrow({ where: { id: p.link.id } })
  assert.equal(link.latestPrice, p.link.latestPrice)
  assert.equal(link.lastSuccessAt.getTime(), 0)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).price, p.price)
  assert.equal(await prisma.oneCPriceChange.count(), 0)
})

test('finished rechecks expose per-card failures without disguising them as an empty successful check', async () => {
  const { product } = await fixture()
  const p = await product({}, { lastSuccessAt: new Date(0) })
  const monitor = new PriceMonitorService(prisma, { parse: async () => { throw Error('Цена на странице не найдена') } }, new MonitorExchangeService(prisma))
  const queued = await monitor.checkAllowedPrices()
  await prisma.monitorJob.update({ where: { id: queued.id }, data: { status: 'RUNNING' } })
  await monitor.recheckBatch(queued.id, queued.pendingUrls, '05ru')
  const view = await monitor.priceReadiness()
  assert.equal(view.priceCheck.status, 'COMPLETED')
  assert.equal(view.priceCheck.processed, 1)
  assert.equal(view.priceCheck.errors, 1)
  assert.match(view.priceCheck.lastError, /Цена на странице не найдена/)
  const row = view.items.find(item => item.productId === p.id)
  assert.match(row.reason, /Последняя проверка завершилась ошибкой/)
  assert.match(row.reason, /устарела/)
})

test('an older recheck resumed for retry takes precedence over a newer finished result', async () => {
  const { product, monitor } = await fixture()
  await product()
  const queued = await monitor.checkAllowedPrices()
  await prisma.monitorJob.update({ where: { id: queued.id }, data: { status: 'RUNNING', createdAt: new Date(Date.now() - 60_000) } })
  await prisma.monitorJob.create({ data: { kind: 'RECHECK', sourceKey: '05ru', status: 'COMPLETED', processed: 1, perPage: 1, finishedAt: new Date() } })
  const view = await monitor.priceReadiness()
  assert.equal(view.checking, true)
  assert.equal(view.priceCheck.id, queued.id)
  assert.equal(view.priceCheck.status, 'RUNNING')
})

test('one click keeps identity, file, stock and stale-price blockers while allowing large TEST changes; cancellation preserves queued failures', async () => {
  const { product, workflow, sync } = await fixture()
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
  for (let i = 0; i < products.length; i++) await workflow.advance()
  const status = await workflow.current()
  assert.equal(status.queued, 2)
  assert.equal(status.skipped, 6)
  for (const id of [wrongMemory.id, wrongColor.id, used.id]) assert.match(status.items.find(item => item.productId === id).reason, /не совпадает/)
  assert.equal(status.items.find(item => item.productId === large.id).status, 'PENDING')
  const largeMessage = (await sync.pending()).items.find(item => item.id === status.items.find(row => row.productId === large.id).messageId)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: large.id } })).price, 60000)
  await sync.receipts({ items: [{ id: largeMessage.id, appliedPrice: largeMessage.targetPrice }] })
  const message = (await sync.pending()).items[0]
  await sync.receipts({ items: [{ id: message.id, error: 'Не удалось провести документ' }] })
  await workflow.advance()
  const failed = await workflow.current()
  assert.equal(failed.pending, 1)
  assert.equal(failed.applied, 1)
  assert.match(failed.items.find(item => item.productId === good.id).reason, /провести/)
  const cancelled = await workflow.cancel(operation.id)
  assert.equal(cancelled.state, 'CANCELLED')
  assert.equal(cancelled.pending, 1)
  assert.equal((await sync.pending()).items[0].id, message.id)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: good.id } })).price, 50000)
})

test('all iPhone 16 price changes queue in TEST and publish only after receipts', async () => {
  const { product, workflow, monitor, sync } = await fixture()
  const products = []
  for (const price of [57900, 58900, 63900]) products.push(await product({ price }, { latestPrice: 64990 }))
  process.env.ONE_C_BASE_KIND = 'PRODUCTION'
  try {
    const snapshot = await monitor.bulkPriceSnapshot(prisma)
    assert.equal(snapshot.items.filter(row => row.blockedReasons.some(reason => reason.includes('10%'))).length, 2)
  } finally { process.env.ONE_C_BASE_KIND = 'TEST' }
  await workflow.start(products.map(row => row.id))
  for (const row of products) await workflow.advance()
  assert.equal((await workflow.current()).pending, 3)
  for (const row of products) assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: row.id } })).price, row.price)
  const packet = await sync.pending()
  assert.equal(packet.items.length, 3)
  for (const row of packet.items) assert.equal(row.targetPrice, 64890)
  await sync.receipts({ items: packet.items.map(row => ({ id: row.id, appliedPrice: row.targetPrice })) })
  await workflow.advance()
  assert.equal((await workflow.current()).applied, 3)
})

test('permission removal and stale prices between click and queue are revalidated atomically', async () => {
  const { product, workflow } = await fixture()
  const revoked = await product(), stale = await product()
  const operation = await workflow.start([revoked.id, stale.id])
  assert.equal(operation.ready, 2)
  await prisma.product.update({ where: { id: revoked.id }, data: { priceSyncEnabled: false } })
  await prisma.competitorProduct.update({ where: { id: stale.link.id }, data: { lastSuccessAt: new Date(0) } })
  await workflow.advance()
  assert.equal((await workflow.current()).skipped, 2)
  assert.equal(await prisma.oneCPriceChange.count(), 0)
})

test('selected forbidden or conflicting items never parse, grant scope or discover a replacement', async () => {
  const { product, monitor } = await fixture()
  const forbidden = await product({ priceSyncEnabled: false })
  const conflict = await product({}, { externalName: 'Смартфон Apple iPhone 15 256 Гб черный б/у' })
  process.env.ONE_C_BASE_KIND = 'PRODUCTION'
  try { await assert.rejects(() => monitor.startPriceUpdate({ productIds: [forbidden.id] }), /отключена/) }
  finally { process.env.ONE_C_BASE_KIND = 'TEST' }
  await monitor.startPriceUpdate({ productIds: [forbidden.id, conflict.id] })
  await monitor.priceUpdate.advance()
  const status = await monitor.currentPriceUpdate()
  assert.equal(status.skipped, 2)
  assert.equal(status.queued, 0)
  assert.equal(await prisma.monitorJob.count({ where: { kind: 'MATCH_1C' } }), 0)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: forbidden.id } })).priceSyncEnabled, false)
  assert.equal((await prisma.competitorProduct.findUniqueOrThrow({ where: { id: conflict.link.id } })).productId, conflict.id)
})

test('purchase floor is enforced at proposal, queue, stale-cost recheck and receipt', async () => {
  const { product, monitor, sync } = await fixture()
  const row = await product({ costPrice: 49050 })
  const preview = await monitor.previewBulkPrices({})
  assert.equal(preview.items.find(item => item.productId === row.id).newPrice, 49050)
  await assert.rejects(() => monitor.applyRecommended(row.link.id, {
    expectedCurrentPrice: 50000, expectedCompetitorPrice: 49100, targetPrice: 49000,
  }), /Цена изменилась/)
  await monitor.applyRecommended(row.link.id, {
    expectedCurrentPrice: 50000, expectedCompetitorPrice: 49100, targetPrice: 49050,
  })
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: row.id } })).price, 50000)
  const packet = await sync.pending()
  assert.equal(packet.items[0].targetPrice, 49050)
  assert.equal(packet.items[0].purchasePrice, 49050)
  await prisma.product.update({ where: { id: row.id }, data: { costPrice: 49500 } })
  assert.equal((await sync.pending()).items.length, 0, 'stale below-cost task is not sent')
  assert.equal((await prisma.oneCPriceChange.findUniqueOrThrow({ where: { id: packet.items[0].id } })).status, 'CANCELLED')
  const noCost = await product({ costPrice: null })
  await assert.rejects(() => monitor.applyRecommended(noCost.link.id, {
    expectedCurrentPrice: 50000, expectedCompetitorPrice: 49100, targetPrice: 49000,
  }), /закупочная/)
  assert.equal(await prisma.oneCPriceChange.count({ where: { productId: noCost.id } }), 0)
})

test('a purchase-price change invalidates the approved bulk snapshot', async () => {
  const { product, monitor } = await fixture()
  const row = await product({ costPrice: 40000 })
  const snapshot = await monitor.previewBulkPrices({})
  await prisma.product.update({ where: { id: row.id }, data: { costPrice: 49500 } })
  await assert.rejects(() => monitor.applyBulkPrices({ token: snapshot.token, ids: [row.link.id] }), /изменились/)
  assert.equal(await prisma.oneCPriceChange.count(), 0)
})

test('production needs its own switch and base ID; TEST keys cannot silently identify a main-base agent', () => {
  const { priceSyncEnabled } = require('../dist/integrations/test-catalog-policy')
  const { OneCGuard } = require('../dist/integrations/onec.guard')
  const keys = ['ONE_C_BASE_KIND','ONE_C_TEST_PRICE_SYNC_ENABLED','ONE_C_PRODUCTION_PRICE_SYNC_ENABLED','ONE_C_PRODUCTION_BASE_ID']
  const saved = keys.map(key => process.env[key])
  try {
    process.env.ONE_C_BASE_KIND = 'PRODUCTION'
    process.env.ONE_C_TEST_PRICE_SYNC_ENABLED = 'true'
    delete process.env.ONE_C_PRODUCTION_PRICE_SYNC_ENABLED
    delete process.env.ONE_C_PRODUCTION_BASE_ID
    assert.equal(priceSyncEnabled(), false)
    process.env.ONE_C_PRODUCTION_PRICE_SYNC_ENABLED = 'true'
    assert.equal(priceSyncEnabled(), false)
    process.env.ONE_C_PRODUCTION_BASE_ID = 'main-ut103'
    assert.equal(priceSyncEnabled(), true)
    const config = { get: key => key === 'ONE_C_API_KEY' ? 'main-private-key' : process.env[key] }
    const guard = new OneCGuard(config)
    const context = headers => ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) })
    assert.throws(() => guard.canActivate(context({ 'x-1c-key': 'main-private-key' })), /профиль/)
    assert.throws(() => guard.canActivate(context({ 'x-1c-key': 'main-private-key', 'x-1c-base-kind': 'TEST', 'x-1c-base-id': 'main-ut103' })), /профиль/)
    assert.throws(() => guard.canActivate(context({ 'x-1c-key': 'main-private-key', 'x-1c-base-kind': 'PRODUCTION', 'x-1c-base-id': 'other-main' })), /профиль/)
    assert.equal(guard.canActivate(context({ 'x-1c-key': 'main-private-key', 'x-1c-base-kind': 'PRODUCTION', 'x-1c-base-id': 'main-ut103' })), true)
  } finally { keys.forEach((key,i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]) }
})

test('switching to the main profile cancels TEST writes and waits for a fresh primary catalog', async () => {
  const { product, monitor, sync } = await fixture()
  const row = await product()
  await monitor.applyRecommended(row.link.id, { expectedCurrentPrice: 50000, expectedCompetitorPrice: 49100, targetPrice: 49000 })
  const keys = ['ONE_C_BASE_KIND','ONE_C_PRODUCTION_PRICE_SYNC_ENABLED','ONE_C_PRODUCTION_BASE_ID']
  const saved = keys.map(key => process.env[key])
  try {
    process.env.ONE_C_BASE_KIND = 'PRODUCTION'
    process.env.ONE_C_PRODUCTION_PRICE_SYNC_ENABLED = 'true'
    process.env.ONE_C_PRODUCTION_BASE_ID = 'fresh-main-' + randomUUID()
    process.env.ONE_C_PRODUCTION_PRICE_SYNC_ENABLED = 'false'
    await sync.onApplicationBootstrap()
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: row.id } })).priceSyncEnabled, false)
    assert.equal((await prisma.oneCPriceChange.findFirstOrThrow({ where: { productId: row.id } })).status, 'CANCELLED')
    assert.equal((await sync.pending()).items.length, 0)
    process.env.ONE_C_PRODUCTION_PRICE_SYNC_ENABLED = 'true'
    await prisma.product.update({ where: { id: row.id }, data: { priceSyncEnabled: true } })
    await sync.onApplicationBootstrap()
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: row.id } })).priceSyncEnabled, true, 'same profile keeps approvals on restart')
    process.env.ONE_C_PRODUCTION_BASE_ID += '-different'
    await sync.onApplicationBootstrap()
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: row.id } })).priceSyncEnabled, false)
  } finally { keys.forEach((key,i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]) }
})
