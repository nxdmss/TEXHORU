const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const { rmSync, writeFileSync, mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { PrismaClient } = require('@prisma/client')
const { ConfigService } = require('@nestjs/config')
const { pruneOperationalData } = require('../dist/maintenance/maintenance.service')
const { MediaService } = require('../dist/media/media.service')
const { PriceMonitorService } = require('../dist/price-monitor/price-monitor.service')
const { MonitorExchangeService } = require('../dist/price-monitor/monitor-exchange.service')
const { fingerprint } = require('../dist/price-monitor/product-matching')
const { setAdminPassword } = require('../../deploy/cloud/set-admin-password.cjs')
const bcrypt = require('bcryptjs')
let db, database
before(async () => {
  database = resolve(__dirname, '../prisma/monitor-test-maintenance-' + randomUUID() + '.db')
  writeFileSync(database, '')
  const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], {
    cwd: resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: 'file:' + database.replace(/\\/g, '/') }, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  db = new PrismaClient({ datasources: { db: { url: 'file:' + database.replace(/\\/g, '/') } } })
})
after(async () => {
  await db?.$disconnect()
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(database + suffix, { force: true })
})

test('retention removes only old operational data, preserves two observations and unresolved/receipt state', async () => {
  const old = new Date(Date.now() - 60 * 86400000)
  const category = await db.category.create({ data: { name: 'Test', slug: randomUUID() } })
  const product = await db.product.create({ data: { categoryId: category.id, name: 'Test', brand: 'Apple', sku: randomUUID(), slug: randomUUID(), price: 1000, oneCId: randomUUID() } })
  const source = await db.competitorSource.create({ data: { key: '05ru', name: '05.ru', baseUrl: 'https://05.ru' } })
  const link = await db.competitorProduct.create({ data: { sourceId: source.id, productId: product.id, externalUrl: 'https://05.ru/test/' } })
  const history = []
  for (let i = 0; i < 4; i++) history.push(await db.competitorPriceHistory.create({ data: {
    competitorProductId: link.id, price: 1000 + i, createdAt: old, checkedAt: new Date(old.getTime() + i * 1000),
  } }))
  await db.monitorDelivery.create({ data: { historyId: history[0].id, linkId: link.id, payload: {}, status: 'PENDING', createdAt: old } })
  await db.monitorDelivery.create({ data: { historyId: history[1].id, linkId: link.id, payload: {}, status: 'DELIVERED', createdAt: old } })
  for (const status of ['PENDING', 'DELIVERED', 'CONFLICT']) await db.oneCPriceChange.create({ data: {
    productId: product.id, oneCId: product.oneCId, oldPrice: 900, newPrice: 1000, status, createdAt: old,
  } })
  await db.monitorJob.createMany({ data: [
    { id: 'finished', kind: 'RECHECK', status: 'COMPLETED', finishedAt: old },
    { id: 'test-price-update-current', kind: 'PRICE_UPDATE', status: 'COMPLETED', finishedAt: old },
    { id: 'failed', kind: 'RECHECK', status: 'FAILED', finishedAt: old },
    { id: 'queued', kind: 'RECHECK', status: 'QUEUED', createdAt: old },
  ] })
  await db.syncLog.createMany({ data: [
    { id: 'success', direction: 'FROM_1C', entity: 'CATALOG', status: 'SUCCESS', createdAt: old },
    { id: 'error', direction: 'FROM_1C', entity: 'CATALOG', status: 'FAILED', createdAt: old },
    { id: 'onec-agent-status', direction: 'FROM_1C', entity: 'AGENT', status: 'SUCCESS', createdAt: old },
  ] })
  await db.notification.createMany({ data: [
    { type: 'TEST', title: 'Read', body: 'test', isRead: true, createdAt: old },
    { type: 'TEST', title: 'Unread', body: 'test', isRead: false, createdAt: old },
  ] })
  await db.auditLog.create({ data: { action: 'REJECT_MONITOR_PROPOSAL', entity: 'Product', entityId: String(product.id), createdAt: old } })
  const result = await pruneOperationalData(db)
  assert.equal(result.jobs, 1)
  assert.equal(result.logs, 1)
  assert.equal(result.deliveries, 1)
  assert.equal(result.notifications, 1)
  assert.equal(result.history, 1)
  assert.deepEqual((await db.competitorPriceHistory.findMany()).map(row => row.id).sort(), [history[0].id, history[2].id, history[3].id].sort())
  assert.equal(await db.oneCPriceChange.count(), 3)
  assert.equal(await db.auditLog.count(), 1)
  assert.equal(await db.product.count(), 1)
  assert.equal(await db.monitorJob.count(), 3)
  assert.equal(Object.values(await pruneOperationalData(db)).reduce((a, b) => a + b, 0), 0)
  await assert.rejects(() => pruneOperationalData(db, new Date(), 0), /Invalid retention/)
})

test('production local uploads require explicit persistent path opt-in and survive service recreation', async () => {
  const previous = process.env.TEXHORU_UPLOADS_DIR
  const folder = mkdtempSync(resolve(tmpdir(), 'texhoru-media-'))
  try {
    delete process.env.TEXHORU_UPLOADS_DIR
    const base = { NODE_ENV: 'production', MEDIA_STORAGE_DRIVER: 'local' }
    assert.throws(() => new MediaService(new ConfigService(base)), /yandex is required/)
    assert.throws(() => new MediaService(new ConfigService({ ...base, ALLOW_PERSISTENT_LOCAL_MEDIA: 'true' })), /yandex is required/)
    process.env.TEXHORU_UPLOADS_DIR = folder
    const config = new ConfigService({ ...base, ALLOW_PERSISTENT_LOCAL_MEDIA: 'true' })
    const media = new MediaService(config)
    const uploaded = await media.uploadProductImage({ mimetype: 'image/png', originalname: 'test.png', buffer: Buffer.from('test'), size: 4 })
    const reopened = await new MediaService(config).openLocalProductImage(uploaded.url.split('/').at(-1))
    const chunks = []
    for await (const chunk of reopened.stream) chunks.push(chunk)
    assert.equal(Buffer.concat(chunks).toString(), 'test')
  } finally {
    if (previous === undefined) delete process.env.TEXHORU_UPLOADS_DIR; else process.env.TEXHORU_UPLOADS_DIR = previous
    rmSync(folder, { recursive: true, force: true })
  }
})

test('cloud schedule checks only permitted saved cards, at most two concurrently', async () => {
  await db.monitorJob.deleteMany()
  const oldScope = process.env.MONITOR_SCHEDULE_AUTHORIZED_ONLY
  const oldConcurrency = process.env.MONITOR_RECHECK_CONCURRENCY
  process.env.MONITOR_SCHEDULE_AUTHORIZED_ONLY = 'true'
  process.env.MONITOR_RECHECK_CONCURRENCY = '2'
  const category = await db.category.findFirstOrThrow()
  const source = await db.competitorSource.findUniqueOrThrow({ where: { key: '05ru' } })
  const allowed = []
  for (let i = 0; i < 5; i++) {
    const product = await db.product.create({ data: { categoryId: category.id, name: 'Смартфон Apple iPhone 16 128 Гб черный', brand: 'Apple', sku: randomUUID(), slug: randomUUID(), oneCId: randomUUID(), price: 63900, stockQty: 1, priceSyncEnabled: i < 3 } })
    const url = 'https://05.ru/cat/test/p/cloud-' + i + '/'
    if (i < 3) allowed.push(url)
    await db.competitorProduct.create({ data: { sourceId: source.id, productId: product.id, externalUrl: url, externalName: product.name, matchStatus: 'CONFIRMED', latestPrice: 64990, inStock: true, priceSource: 'PRODUCT_PAGE', lastSuccessAt: new Date(), attributes: {}, confirmedProductFingerprint: fingerprint(product), confirmedFingerprint: fingerprint(product) } })
  }
  await db.monitorSettings.create({ data: { id: '05ru', intervalMinutes: 1440, nextRunAt: new Date(0) } })
  const calls = []; let concurrent = 0, maximum = 0
  const parser = { parse: async url => {
    calls.push(url); maximum = Math.max(maximum, ++concurrent)
    await new Promise(done => setImmediate(done)); concurrent--
    return { url, name: 'Смартфон Apple iPhone 16 128 Гб черный', brand: 'Apple', attributes: {}, price: 64990, oldPrice: null, inStock: true, priceSource: 'PRODUCT_PAGE', seller: null, region: null }
  } }
  const monitor = new PriceMonitorService(db, parser, new MonitorExchangeService(db), {}, {})
  try {
    await monitor.tick()
    assert.equal(calls.length, 2)
    await monitor.tick()
    assert.deepEqual(calls.sort(), allowed.sort())
    assert.equal(maximum, 2)
  } finally {
    monitor.onModuleDestroy()
    if (oldScope === undefined) delete process.env.MONITOR_SCHEDULE_AUTHORIZED_ONLY; else process.env.MONITOR_SCHEDULE_AUTHORIZED_ONLY = oldScope
    if (oldConcurrency === undefined) delete process.env.MONITOR_RECHECK_CONCURRENCY; else process.env.MONITOR_RECHECK_CONCURRENCY = oldConcurrency
  }
})

test('operator password change hashes only the chosen active administrator and refuses customer/short/oversized passwords', async () => {
  const admin = await db.user.create({ data: { email: 'admin-password@test.local', name: 'Admin', role: 'DIRECTOR', passwordHash: await bcrypt.hash('original-password-12345', 4) } })
  const customer = await db.user.create({ data: { email: 'customer-password@test.local', name: 'Customer', role: 'CUSTOMER', passwordHash: 'unchanged' } })
  const password = 'new password with $quotes#123456'
  await setAdminPassword(db, bcrypt.hash, admin.email.toUpperCase(), password)
  const updated = await db.user.findUniqueOrThrow({ where: { id: admin.id } })
  assert(await bcrypt.compare(password, updated.passwordHash))
  assert(!(await bcrypt.compare('original-password-12345', updated.passwordHash)))
  assert.equal(updated.role, 'DIRECTOR')
  for (const bad of ['short', 'я'.repeat(40), 'valid-length-but\nnewline']) {
    await assert.rejects(() => setAdminPassword(db, bcrypt.hash, admin.email, bad), /16/)
  }
  await assert.rejects(() => setAdminPassword(db, bcrypt.hash, customer.email, password), /не найден/)
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: customer.id } })).passwordHash, 'unchanged')
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).passwordHash, updated.passwordHash)
})
