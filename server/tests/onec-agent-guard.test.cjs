const { test } = require('node:test')
const assert = require('node:assert/strict')
const { IntegrationsController } = require('../dist/integrations/integrations.controller')

test('reverse retail-price exchange requires an explicit TEST server switch', async () => {
  const calls = []
  const sync = {
    configureScope: async dto => { calls.push('scope-write'); return { ok: true, count: dto.oneCIds.length } },
    scope: async () => { calls.push('scope-read'); return [] },
    productByOneCId: async id => { calls.push('product-read'); return { oneCId: id } },
    pending: async () => { calls.push('pending-read'); return { schemaVersion: 1, items: [] } },
    heartbeat: async dto => { calls.push('heartbeat'); return { ok: true } },
    receipts: async dto => { calls.push('receipt-write'); return { ok: true, results: dto.items } },
  }
  const controller = new IntegrationsController({}, sync)
  const previousKind = process.env.ONE_C_BASE_KIND
  const previousEnabled = process.env.ONE_C_TEST_PRICE_SYNC_ENABLED
  const restore = (key, value) => value === undefined ? delete process.env[key] : (process.env[key] = value)

  const routes = [
    () => controller.priceScope({ oneCIds: ['test-guid'] }),
    () => controller.getPriceScope(),
    () => controller.priceSyncProduct('test-guid'),
    () => controller.pendingPrices(),
    () => controller.heartbeat({ state: 'idle' }),
    () => controller.priceReceipts({ items: [{ id: 'test-change', appliedPrice: 100 }] }),
  ]

  try {
    delete process.env.ONE_C_BASE_KIND
    delete process.env.ONE_C_TEST_PRICE_SYNC_ENABLED
    for (const route of routes) {
      assert.throws(route, /Обратная передача цен отключена/)
    }

    process.env.ONE_C_BASE_KIND = 'TEST'
    process.env.ONE_C_TEST_PRICE_SYNC_ENABLED = 'false'
    for (const route of routes) {
      assert.throws(route, /Обратная передача цен отключена/)
    }

    process.env.ONE_C_BASE_KIND = 'PRODUCTION'
    process.env.ONE_C_TEST_PRICE_SYNC_ENABLED = 'true'
    for (const route of routes) {
      assert.throws(route, /Обратная передача цен отключена/)
    }

    process.env.ONE_C_BASE_KIND = 'TEST'
    process.env.ONE_C_TEST_PRICE_SYNC_ENABLED = 'true'
    assert.deepEqual(await controller.priceScope({ oneCIds: ['test-guid'] }), { ok: true, count: 1 })
    assert.deepEqual(await controller.getPriceScope(), [])
    assert.deepEqual(await controller.priceSyncProduct('test-guid'), { oneCId: 'test-guid' })
    assert.deepEqual(await controller.pendingPrices(), { schemaVersion: 1, items: [] })
    assert.deepEqual(await controller.priceReceipts({ items: [{ id: 'test-change', appliedPrice: 100 }] }),
      { ok: true, results: [{ id: 'test-change', appliedPrice: 100 }] })
    assert.deepEqual(await controller.heartbeat({ state: 'idle' }), { ok: true })
    assert.deepEqual(calls, ['scope-write', 'scope-read', 'product-read', 'pending-read', 'receipt-write', 'heartbeat'])
  } finally {
    restore('ONE_C_BASE_KIND', previousKind)
    restore('ONE_C_TEST_PRICE_SYNC_ENABLED', previousEnabled)
  }
})
