const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const { rmSync, writeFileSync } = require('node:fs')
const bcrypt = require('bcryptjs')
test('remote catalog: staff-only queue, bounded groups, leases, atomic progress, replay, pause/restart, delta and profile isolation', async t => {
  const file = resolve(__dirname, '../prisma/monitor-test-remote-' + randomUUID() + '.db')
  const baseId = randomUUID(), agentId = randomUUID(), key = randomUUID()
  Object.assign(process.env, { DATABASE_URL: 'file:' + file, JWT_SECRET: randomUUID(), ONE_C_API_KEY: key, ONE_C_BASE_KIND: 'PRODUCTION', ONE_C_PRODUCTION_BASE_ID: baseId, ONE_C_PRODUCTION_PRICE_SYNC_ENABLED: 'false', MONITOR_WORKER_DISABLED: 'true', NODE_ENV: 'test', TEXHORU_ENV_FILE: 'tests/missing.env' })
  writeFileSync(file, '')
  const push = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], { cwd: resolve(__dirname, '..'), env: process.env, encoding: 'utf8' })
  assert.equal(push.status, 0, push.stdout + push.stderr)
  const { Test } = require('@nestjs/testing'), { ValidationPipe } = require('@nestjs/common')
  const { AppModule } = require('../dist/app.module'), { PrismaService } = require('../dist/prisma/prisma.service')
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = module.createNestApplication({ logger: false })
  app.setGlobalPrefix('api'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
  await app.listen(0, '127.0.0.1')
  const base = await app.getUrl(), db = app.get(PrismaService)
  let cookie
  const admin = '/admin/integrations/1c/remote', remote = '/integrations/1c/remote'
  async function req(path, body, kind = 'agent', extra = {}) {
    const response = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(kind === 'agent' ? { 'x-1c-key': key, 'x-1c-base-kind': 'PRODUCTION', 'x-1c-base-id': baseId } : kind === 'staff' ? { cookie } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const poll = (id = agentId) => req(remote + '/poll', { agentId: id, state: 'idle' })
  const groupId = randomUUID(), subId = randomUUID(), productId = randomUUID()
  try {
    const pass = randomUUID()
    await db.user.create({ data: { name: 'Director', role: 'DIRECTOR', email: 'remote@test.local', passwordHash: await bcrypt.hash(pass, 4) } })
    cookie = (await req('/auth/login', { email: 'remote@test.local', password: pass }, 'none')).cookie
    assert(cookie)
    await t.test('access guards enforce profile and administration separately', async () => {
      assert.equal((await req(admin, undefined, 'none')).status, 401)
      assert.equal((await req(admin, undefined, 'agent')).status, 401)
      assert.equal((await req(remote + '/poll', { agentId, state: 'idle' }, 'staff')).status, 401)
      assert.equal((await req(remote + '/poll', { agentId, state: 'idle' }, 'agent', { 'x-1c-base-kind': 'TEST' })).status, 403)
      assert.equal((await req(remote + '/poll', { agentId, state: 'idle' }, 'agent', { 'x-1c-base-id': randomUUID() })).status, 403)
    })
    let groupsJob
    await t.test('agent initially discovers groups without importing products; only one leased worker', async () => {
      groupsJob = (await poll()).body.job
      assert.equal(groupsJob.kind, 'GROUPS')
      assert.equal((await poll(randomUUID())).body.job, null)
      const body = { leaseToken: groupsJob.leaseToken, batch: 0, cursor: '000001', scanned: 2, products: [], categories: [], hashes: [], groups: [
        { oneCId: groupId, parentId: '', name: 'Телефоны', itemCount: 0 }, { oneCId: subId, parentId: groupId, name: 'Apple', itemCount: 8000 },
      ] }
      assert.equal((await req(remote + '/jobs/' + groupsJob.id + '/batch', body)).status, 201)
      assert.equal((await req(remote + '/jobs/' + groupsJob.id + '/batch', body)).status, 201)
      assert.equal((await req(remote + '/jobs/' + groupsJob.id + '/finish', { leaseToken: groupsJob.leaseToken })).status, 201)
      assert.equal((await req(remote + '/jobs/' + groupsJob.id + '/finish', { leaseToken: groupsJob.leaseToken })).status, 201)
      assert.equal(await db.product.count(), 0)
      const tree = (await req(admin, undefined, 'staff')).body
      assert.equal(tree.groups.length, 1); assert.equal(tree.groups[0].name, 'Телефоны'); assert(tree.agent.online)
      assert.equal(tree.jobs[0].leaseToken, undefined)
      assert.equal((await req(admin + '?parent=' + groupId, undefined, 'staff')).body.groups[0].itemCount, 8000)
      assert.equal((await req(admin + '?search=apple', undefined, 'staff')).body.total, 1)
    })
    await t.test('first full mirror starts automatically after the group snapshot', async () => {
      const automatic = (await poll()).body.job
      assert.equal(automatic.kind, 'CATALOG'); assert.equal(automatic.mode, 'FULL'); assert.equal(automatic.groupId, '')
      assert.equal((await req(admin + '/jobs/' + automatic.id + '/action', { action: 'cancel' }, 'staff')).status, 201)
    })
    let job, batch
    await t.test('enqueue/claim FULL, persist bounded products and checkpoint in one transaction', async () => {
      const created = await req(admin + '/jobs', { kind: 'CATALOG', groupId, mode: 'FULL' }, 'staff')
      assert.equal(created.status, 201)
      assert.equal((await req(admin + '/jobs', { kind: 'CATALOG', groupId, mode: 'FULL' }, 'staff')).body.id, created.body.id)
      job = (await poll()).body.job
      batch = { leaseToken: job.leaseToken, batch: 0, cursor: productId, scanned: 1, groups: [], hashes: [{ oneCId: productId, hash: 'a'.repeat(64) }], categories: [{ oneCId: subId, name: 'Телефоны / Apple', slug: '1c-' + subId }], products: [{ oneCId: productId, sku: '1C-' + productId, slug: '1c-' + productId, name: 'Apple iPhone 16 128GB Black', brand: 'Apple', categoryOneCId: subId, price: 50000, costPrice: 48000, stockQty: 5, sourceCode: '0000046151', sourceArticle: 'MYE73RU/A', sourceFullName: 'Смартфон Apple iPhone 16 128GB Black', sourceKind: 'Товар', sourceUnit: 'шт' }] }
      assert.equal((await req(remote + '/jobs/' + job.id + '/batch', { ...batch, leaseToken: randomUUID() })).status, 409)
      assert.equal((await req(remote + '/jobs/' + job.id + '/batch', batch)).status, 201)
      assert.equal((await req(remote + '/jobs/' + job.id + '/batch', batch)).status, 201)
      const state = await db.oneCCatalogJob.findUniqueOrThrow({ where: { id: job.id } })
      assert.equal(state.nextBatch, 1); assert.equal(state.scanned, 1); assert.equal(state.processed, 1)
      assert.equal(await db.product.count(), 1)
      assert.equal((await db.product.findFirst()).costPrice, 48000)
      const source = await db.oneCNomenclatureItem.findFirst()
      assert.equal(source.code, '0000046151'); assert.equal(source.article, 'MYE73RU/A'); assert.equal(source.fullName, 'Смартфон Apple iPhone 16 128GB Black')
      const treeResponse = await req(admin + '/tree', undefined, 'staff')
      assert.equal(treeResponse.status, 200); assert.equal(treeResponse.body.itemCount, 1); assert.equal(treeResponse.body.groups.length, 2)
      const mirror = await req(admin + '/nomenclature?group=' + subId, undefined, 'staff')
      assert.equal(mirror.status, 200); assert.equal(mirror.body.items[0].unitName, 'шт'); assert.equal(mirror.body.items[0].purchasePrice, 48000)
      const found = await req(admin + '/nomenclature?search=mye73', undefined, 'staff')
      assert.equal(found.body.total, 1)
      assert.equal((await req(remote + '/jobs/' + job.id + '/batch', { ...batch, scanned: 2 })).status, 409)
    })
    await t.test('pause revokes lease, survives service restart, resume uses stored cursor; rollback on invalid data', async () => {
      assert.equal((await req(admin + '/jobs/' + job.id + '/action', { action: 'pause' }, 'staff')).status, 201)
      assert.equal((await poll()).body.job, null)
      assert.equal((await req(remote + '/jobs/' + job.id + '/batch', { ...batch, batch: 1, cursor: randomUUID() })).status, 409)
      const { RemoteCatalogService } = require('../dist/integrations/remote-catalog.service')
      const { IntegrationsService } = require('../dist/integrations/integrations.service')
      const restarted = new RemoteCatalogService(db, app.get(IntegrationsService))
      assert.equal((await restarted.dashboard('', '', 0)).jobs.find(j => j.id === job.id).status, 'PAUSED')
      assert.equal((await req(admin + '/jobs/' + job.id + '/action', { action: 'resume' }, 'staff')).status, 201)
      const resumed = (await poll()).body.job
      assert.equal(resumed.cursor, productId); assert.equal(resumed.nextBatch, 1); assert.notEqual(resumed.leaseToken, job.leaseToken)
      const invalid = { ...batch, leaseToken: resumed.leaseToken, batch: 1, cursor: randomUUID(), products: [{ ...batch.products[0], categoryOneCId: randomUUID() }], categories: [] }
      assert((await req(remote + '/jobs/' + job.id + '/batch', invalid)).status >= 400)
      assert.equal((await db.oneCCatalogJob.findUnique({ where: { id: job.id } })).nextBatch, 1)
      assert.equal((await req(remote + '/jobs/' + job.id + '/finish', { leaseToken: resumed.leaseToken })).status, 201)
      const known = await req(remote + '/known', { hashes: batch.hashes })
      assert.deepEqual(known.body.needed, [])
      assert.deepEqual((await req(remote + '/known', { hashes: [{ oneCId: productId, hash: 'b'.repeat(64) }] })).body.needed, [productId])
    })
    await t.test('DELTA advances over unchanged rows; expired leases revoked; failure/retry/cancel releases queue', async () => {
      await req(admin + '/jobs', { kind: 'CATALOG', groupId, mode: 'DELTA' }, 'staff')
      const delta = (await poll()).body.job
      assert.equal((await req(remote + '/jobs/' + delta.id + '/batch', { ...batch, leaseToken: delta.leaseToken, products: [], categories: [] })).status, 201)
      assert.equal((await db.oneCCatalogJob.findUnique({ where: { id: delta.id } })).processed, 0)
      await db.oneCCatalogJob.update({ where: { id: delta.id }, data: { leaseUntil: new Date(0) } })
      const takeover = (await poll(randomUUID())).body.job
      assert.notEqual(takeover.leaseToken, delta.leaseToken)
      assert.equal((await req(remote + '/jobs/' + delta.id + '/finish', { leaseToken: delta.leaseToken })).status, 409)
      await req(remote + '/poll', { agentId: takeover.agentId, state: 'error', error: 'CATALOG_READ' })
      assert.equal((await db.oneCCatalogJob.findUnique({ where: { id: delta.id } })).status, 'FAILED')
      assert.equal((await req(admin + '/jobs/' + delta.id + '/action', { action: 'retry' }, 'staff')).status, 201)
      await poll()
      assert.equal((await req(admin + '/jobs/' + delta.id + '/action', { action: 'cancel' }, 'staff')).status, 201)
      assert.equal(await db.catalogImportSession.count({ where: { activeKey: 'catalog' } }), 0)
      assert.equal(await db.product.count(), 1)
      assert.equal((await req(remote + '/known', { hashes: Array.from({ length: 51 }, () => batch.hashes[0]) })).status, 400)
      assert.equal((await req(remote + '/jobs/' + delta.id + '/batch', { ...batch, products: Array(51).fill(batch.products[0]) })).status, 400)
      const huge = { ...batch, categories: [{ ...batch.categories[0], name: 'x'.repeat(600000) }] }
      assert((await req(remote + '/jobs/' + delta.id + '/batch', huge)).status >= 400)
    })
    await t.test('excluded branches are physically removed from the mirror, hidden from the storefront and skipped by the agent until restored', async () => {
      const excluded = await req(admin + '/groups/' + subId + '/exclude', {}, 'staff')
      assert.equal(excluded.status, 201); assert.equal(excluded.body.removed, 1); assert.equal(excluded.body.productsDeleted, 1)
      assert.equal(await db.oneCNomenclatureItem.count(), 0)
      assert.equal(await db.product.count(), 0)
      assert.equal(await db.category.findUnique({ where: { oneCId: subId } }), null)
      const tree = (await req(admin + '/tree', undefined, 'staff')).body
      assert.equal(tree.itemCount, 0); assert.deepEqual(tree.groups.map(group => group.oneCId), [groupId])
      assert.equal((await req(admin + '/nomenclature?search=iphone', undefined, 'staff')).body.total, 0)
      const excludedList = (await req(admin + '/excluded-groups', undefined, 'staff')).body
      assert.deepEqual(excludedList.map(group => group.oneCId), [subId])

      const root = await req(admin + '/jobs', { kind: 'CATALOG', mode: 'FULL' }, 'staff')
      const leased = (await poll()).body.job
      assert.equal(leased.id, root.body.id); assert.deepEqual(leased.excludedGroupIds, [subId])
      assert.equal((await req(admin + '/jobs/' + leased.id + '/action', { action: 'cancel' }, 'staff')).status, 201)

      const restored = await req(admin + '/groups/' + subId + '/restore', {}, 'staff')
      assert.equal(restored.status, 201); assert(restored.body.jobId)
      assert.equal((await req(admin + '/tree', undefined, 'staff')).body.groups.length, 2)
      assert.deepEqual((await req(remote + '/known', { hashes: batch.hashes })).body.needed, [productId])
      assert.equal((await req(admin + '/jobs/' + restored.body.jobId + '/action', { action: 'cancel' }, 'staff')).status, 201)
    })
    await t.test('a cancelled group snapshot is recreated automatically', async () => {
      const cancelled = await req(admin + '/jobs', { kind: 'GROUPS', mode: 'FULL' }, 'staff')
      assert.equal(cancelled.status, 201)
      assert.equal((await req(admin + '/jobs/' + cancelled.body.id + '/action', { action: 'cancel' }, 'staff')).status, 201)
      const replacement = (await poll()).body.job
      assert.equal(replacement.kind, 'GROUPS'); assert.notEqual(replacement.id, cancelled.body.id)
      assert.equal((await req(admin + '/jobs/' + replacement.id + '/action', { action: 'cancel' }, 'staff')).status, 201)
    })
  } finally {
    await app.close()
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true })
  }
})
