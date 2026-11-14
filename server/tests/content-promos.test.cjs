const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const { writeFileSync, rmSync } = require('node:fs')
const { spawnSync } = require('node:child_process')

const requireServer = createRequire(resolve(__dirname, '../package.json'))
const { PrismaClient } = requireServer('@prisma/client')
const { ContentService } = require('../dist/content/content.service')

test('each storefront promo block owns an independent set of photos', async () => {
  const database = resolve(__dirname, '../prisma/monitor-test-promos-' + randomUUID() + '.db')
  const databaseUrl = 'file:' + database.replace(/\\/g, '/')
  writeFileSync(database, '')
  const push = spawnSync(process.execPath, [requireServer.resolve('prisma/build/index.js'), 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], {
    cwd: resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8',
  })
  assert.equal(push.status, 0, push.stdout + push.stderr)

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  const service = new ContentService(prisma, { log: async () => undefined })
  const photo = (title, blockId) => ({ blockId, kicker: 'РЕКЛАМА', title, body: '', ctaLabel: 'Смотреть', category: 'Все', image: '/uploads/promos/' + title + '.webp' })
  try {
    const first = await service.create(photo('Первый', 'promo-a'))
    const second = await service.create(photo('Второй', 'promo-b'))
    const all = await service.publicPromos()
    assert.deepEqual(all.map(item => [item.title, item.blockId]), [['Первый', 'promo-a'], ['Второй', 'promo-b']])

    await service.remove(first.id)
    const remaining = await service.publicPromos()
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].id, second.id)
    assert.equal(remaining[0].blockId, 'promo-b')

    const legacy = await service.create({ ...photo('Старый', undefined), blockId: undefined })
    assert.equal(legacy.blockId, 'home-promos')
  } finally {
    await prisma.$disconnect()
    rmSync(database, { force: true })
  }
})
