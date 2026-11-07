const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const { rmSync, writeFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { PrismaClient } = require('@prisma/client')
const { OneCPriceSyncService } = require('../dist/integrations/price-sync.service')
const { ProductsService } = require('../dist/products/products.service')
const { OneCAgentHeartbeatDto } = require('../dist/integrations/price-sync.dto')
const { validate } = require('class-validator')

test('30 approved prices drain in three batches; heartbeat cannot acknowledge prices; errors stay visible', async () => {
  const db = resolve(__dirname, '../prisma/monitor-test-demo-' + randomUUID() + '.db')
  writeFileSync(db, '')
  const push = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], {
    cwd: resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: 'file:' + db.replace(/\\/g, '/') }, encoding: 'utf8',
  })
  assert.equal(push.status, 0, push.stdout + push.stderr)
  const prisma = new PrismaClient({ datasources: { db: { url: 'file:' + db.replace(/\\/g, '/') } } })
  try {
    const cat = await prisma.category.create({ data: { name: 'Demo', slug: 'demo' } })
    const products = []
    for (let i = 0; i < 30; i++) products.push(await prisma.product.create({ data: {
      oneCId: randomUUID(), sku: 'DEMO' + i, slug: 'demo-' + i, name: 'Demo ' + i,
      brand: 'Test', price: 1000, stockQty: 1, categoryId: cat.id,
    } }))
    const sync = new OneCPriceSyncService(prisma)
    const site = new ProductsService(prisma, { log: async () => {} })
    await sync.configureScope({ oneCIds: products.map(p => p.oneCId) })
    for (const p of products) await site.update(p.id, { price: 1100 })
    await sync.heartbeat({ state: 'processing', applied: 30 })
    assert.equal((await sync.dashboard()).summary.delivered, 0, 'activity is not proof of delivery')
    assert.equal((await sync.dashboard()).summary.pending, 30)
    let lastReceipt
    for (let i = 0; i < 3; i++) {
      const packet = await sync.pending()
      assert.equal(packet.items.length, 10)
      lastReceipt = { items: packet.items.map(p => ({ id: p.id, appliedPrice: p.targetPrice })) }
      assert((await sync.receipts(lastReceipt)).results.every(r => r.status === 'DELIVERED'))
    }
    await sync.receipts(lastReceipt) // Duplicate HTTP delivery is harmless.
    assert.equal((await sync.pending()).items.length, 0)
    assert.equal((await sync.dashboard()).summary.delivered, 30)
    await site.update(products[0].id, { price: 1200 })
    const packet = await sync.pending()
    await sync.receipts({ items: [{ id: packet.items[0].id, error: 'Нет способа расчёта' }] })
    await sync.heartbeat({ state: 'error', applied: 0, failed: 1 })
    const dashboard = await sync.dashboard()
    assert.equal(dashboard.summary.pending, 1)
    assert.equal(dashboard.summary.needsAttention, 1)
    assert.equal(dashboard.changes.find(c => c.id === packet.items[0].id).error, 'Нет способа расчёта')
    assert.equal(dashboard.agent.state, 'error')
    assert.equal(dashboard.agent.online, true)
    await sync.heartbeat({ state: 'idle' })
    assert.equal(await prisma.syncLog.count({ where: { entity: 'ONEC_AGENT' } }), 1, 'polls do not grow the log')
    await prisma.syncLog.update({ where: { id: 'onec-agent-status' }, data: { createdAt: new Date(Date.now() - 6 * 60_000) } })
    assert.equal((await sync.dashboard()).agent.online, false)
    for (const invalid of [{ state: 'success' }, { state: 'idle', applied: 31 }, { state: 'idle', failed: -1 }])
      assert((await validate(Object.assign(new OneCAgentHeartbeatDto(), invalid))).length > 0)
  } finally {
    await prisma.$disconnect()
    for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(db + suffix, { force: true })
  }
})
