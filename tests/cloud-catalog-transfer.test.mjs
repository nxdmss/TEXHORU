import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { exportCloudCatalog } from '../scripts/export-cloud-catalog.mjs'
import catalog from '../deploy/cloud/catalog-transfer.cjs'
const require = createRequire(resolve('server/package.json'))
const { PrismaClient } = require('@prisma/client')

test('catalog-only transfer preserves cloud credentials and 1C GUID/bindings, drops old jobs and resets reservations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texhoru-catalog-'))
  const prior = process.env.DATABASE_URL
  const sourceFile = join(root, 'server', 'prisma', 'dev-local.db')
  const cloudFile = join(root, 'cloud', 'texhoru.db')
  let source, cloud
  const open = file => new PrismaClient({ datasources: { db: { url: 'file:' + file.replace(/\\/g, '/') } } })
  try {
    mkdirSync(join(root, 'server', 'prisma'), { recursive: true }); mkdirSync(join(root, 'cloud'))
    mkdirSync(join(root, 'server', 'uploads', 'products'), { recursive: true })
    writeFileSync(join(root, 'server', 'uploads', 'products', 'photo.png'), 'source-photo')
    writeFileSync(join(root, 'server', '.env.local'), 'DATABASE_URL=file:./dev-local.db\n')
    for (const file of [sourceFile, cloudFile]) {
      writeFileSync(file, '')
      const pushed = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], {
        cwd: resolve('server'), env: { ...process.env, DATABASE_URL: 'file:' + file.replace(/\\/g, '/') }, encoding: 'utf8',
      })
      assert.equal(pushed.status, 0, pushed.stdout + pushed.stderr)
    }
    source = open(sourceFile); cloud = open(cloudFile)
    await source.user.create({ data: { email: 'old-private-user@test.local', passwordHash: 'old-private-password-hash', name: 'Old', role: 'DIRECTOR' } })
    const owner = await cloud.user.create({ data: { email: 'new-cloud-owner@test.local', passwordHash: 'new-cloud-password-hash', name: 'Cloud owner', role: 'DIRECTOR' } })
    await cloud.syncLog.create({ data: { id: 'onec-agent-status', entity: 'AGENT', direction: 'FROM_1C', status: 'SUCCESS', message: 'keep-cloud-agent-state' } })
    await cloud.competitorSource.create({ data: { key: '05ru', name: 'Cloud default', baseUrl: 'https://05.ru' } })
    const category = await source.category.create({ data: { name: 'Смартфоны', slug: 'phones', oneCId: randomUUID() } })
    const product = await source.product.create({ data: { categoryId: category.id, name: 'Apple iPhone 16 128GB Green', brand: 'Apple', sku: 'SOURCE', slug: 'source', oneCId: randomUUID(), price: 64890, stockQty: 5, reservedQty: 2, priceSyncEnabled: true, image: '/api/uploads/products/photo.png' } })
    const store = await source.competitorSource.create({ data: { key: '05ru', name: '05.ru', baseUrl: 'https://05.ru' } })
    const link = await source.competitorProduct.create({ data: { sourceId: store.id, productId: product.id, externalUrl: 'https://05.ru/cat/test/p/source/', externalName: product.name, matchStatus: 'CONFIRMED', latestPrice: 64990, confirmedFingerprint: 'source-fingerprint', confirmedProductFingerprint: 'source-product-fingerprint' } })
    for (let i = 0; i < 3; i++) await source.competitorPriceHistory.create({ data: { competitorProductId: link.id, price: 64900 + i, checkedAt: new Date(Date.now() + i * 1000) } })
    await source.oneCPriceChange.create({ data: { id: 'old-pending-message', productId: product.id, oneCId: product.oneCId, oldPrice: 64890, newPrice: 64000 } })
    await source.monitorJob.create({ data: { id: 'old-active-job', kind: 'MATCH_1C', status: 'QUEUED' } })
    await source.$disconnect(); source = null
    process.env.DATABASE_URL = 'file:./dev-local.db'
    const directory = await exportCloudCatalog(root)
    const text = readFileSync(join(directory, 'catalog.json'), 'utf8')
    for (const secret of ['old-private-user', 'old-private-password', 'old-pending-message', 'old-active-job']) assert(!text.includes(secret))
    await cloud.$disconnect(); cloud = null
    const uploads = join(root, 'cloud-uploads')
    const catalogFile = join(directory, 'catalog.json'), manifestFile = join(directory, 'manifest.json')
    const original = readFileSync(catalogFile, 'utf8')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, sha256: 'incorrect' }))
    assert.throws(() => catalog.importCatalog(directory, cloudFile, uploads), /checksum/)
    const invalid = JSON.parse(original)
    invalid.tables.Product.rows[0][invalid.tables.Product.columns.indexOf('categoryId')] = 'missing-category'
    writeFileSync(catalogFile, JSON.stringify(invalid))
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, sha256: catalog.sha256(catalogFile) }))
    assert.throws(() => catalog.importCatalog(directory, cloudFile, uploads), /FOREIGN KEY/)
    cloud = open(cloudFile)
    assert.equal(await cloud.product.count(), 0, 'failed import rolls back catalog inserts')
    assert.deepEqual(await cloud.user.findUniqueOrThrow({ where: { id: owner.id } }), owner)
    await cloud.$disconnect(); cloud = null
    writeFileSync(catalogFile, original); writeFileSync(manifestFile, JSON.stringify(manifest))
    assert.deepEqual(catalog.importCatalog(directory, cloudFile, uploads), { products: 1, categories: 1, links: 1 })
    cloud = open(cloudFile)
    assert.deepEqual(await cloud.user.findUniqueOrThrow({ where: { id: owner.id } }), owner)
    assert.equal(await cloud.user.count(), 1)
    assert.equal(await cloud.oneCPriceChange.count(), 0)
    assert.equal(await cloud.monitorJob.count(), 0)
    assert.equal((await cloud.syncLog.findUniqueOrThrow({ where: { id: 'onec-agent-status' } })).message, 'keep-cloud-agent-state')
    const copied = await cloud.product.findUniqueOrThrow({ where: { oneCId: product.oneCId } })
    assert.equal(copied.id, product.id); assert.equal(copied.priceSyncEnabled, true); assert.equal(copied.reservedQty, 0)
    assert.deepEqual(await cloud.competitorProduct.findUniqueOrThrow({ where: { id: link.id } }), link)
    assert.equal(await cloud.competitorPriceHistory.count(), 2)
    assert.equal(readFileSync(join(uploads, 'products', 'photo.png'), 'utf8'), 'source-photo')
    await cloud.$disconnect(); cloud = null
    assert.throws(() => catalog.importCatalog(directory, cloudFile, uploads), /not empty/)
    source = open(sourceFile)
    assert.equal(await source.oneCPriceChange.count(), 1, 'source pending queue is not modified')
    assert.equal((await source.product.findUniqueOrThrow({ where: { id: product.id } })).reservedQty, 2)
  } finally {
    await source?.$disconnect(); await cloud?.$disconnect()
    if (prior === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prior
    rmSync(root, { recursive: true, force: true })
  }
})
