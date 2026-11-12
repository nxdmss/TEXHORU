const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { writeFileSync, rmSync } = require('node:fs')
const { resolve } = require('node:path')
const { once } = require('node:events')
const net = require('node:net')
const bcrypt = require('bcryptjs')
const { PrismaClient } = require('@prisma/client')

test('production HTTP validates the source profile and returns JSON for empty/saved updates', async () => {
  const database = resolve(__dirname, '../prisma/monitor-test-price-http-' + randomUUID() + '.db')
  const databaseUrl = 'file:' + database.replace(/\\/g, '/')
  writeFileSync(database, '')
  let prisma, child
  try {
    const push = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], {
      cwd: resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8',
    })
    assert.equal(push.status, 0, push.stdout + push.stderr)
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    const email = 'price-http@test.local', password = randomUUID()
    await prisma.user.create({ data: { email, name: 'HTTP test', role: 'DIRECTOR', passwordHash: await bcrypt.hash(password, 4) } })
    const category = await prisma.category.create({ data: { name: 'Test', slug: 'test', oneCId: randomUUID() } })
    const product = await prisma.product.create({ data: { categoryId: category.id, name: 'HTTP test product', brand: 'Test',
      sku: randomUUID(), slug: randomUUID(), oneCId: randomUUID(), price: 1000, stockQty: 1 } })
    const socket = net.createServer()
    await new Promise((done, fail) => { socket.once('error', fail); socket.listen(0, '127.0.0.1', done) })
    const port = socket.address().port
    await new Promise(done => socket.close(done))
    const integrationKey = randomUUID()
    child = spawn(process.execPath, ['dist/main.js'], { cwd: resolve(__dirname, '..'), env: { ...process.env,
      DATABASE_URL: databaseUrl, JWT_SECRET: randomUUID(), ONE_C_API_KEY: integrationKey, NODE_ENV: 'test',
      PORT: String(port), HOST: '127.0.0.1', TEXHORU_ENV_FILE: 'tests/nonexistent.env',
      MONITOR_WORKER_DISABLED: 'true', SERVE_STOREFRONT: 'false',
      ONE_C_BASE_KIND: 'PRODUCTION', ONE_C_TEST_PRICE_SYNC_ENABLED: 'false',
      ONE_C_PRODUCTION_PRICE_SYNC_ENABLED: 'true', ONE_C_PRODUCTION_BASE_ID: 'http-main-ut103',
    }, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', d => { log += d }); child.stderr.on('data', d => { log += d })
    const base = 'http://127.0.0.1:' + port + '/api'
    let ready = false
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/health')).ok) { ready = true; break } } catch {}
      await new Promise(done => setTimeout(done, 100))
    }
    assert(ready, log.slice(-1500))
    const pendingUrl = base + '/integrations/1c/price-sync/pending'
    assert.equal((await fetch(pendingUrl)).status, 401)
    assert.equal((await fetch(pendingUrl, {headers:{'x-1c-key':integrationKey}})).status, 403)
    assert.equal((await fetch(pendingUrl, {headers:{'x-1c-key':integrationKey,'x-1c-base-kind':'TEST','x-1c-base-id':'http-main-ut103'}})).status, 403)
    assert.equal((await fetch(pendingUrl, {headers:{'x-1c-key':integrationKey,'x-1c-base-kind':'PRODUCTION','x-1c-base-id':'http-main-ut103'}})).status, 200)

    assert.equal((await prisma.product.findUniqueOrThrow({where:{id:product.id}})).priceSyncEnabled,false,
      'old permissions are not inherited by the production profile')
    const imported = await fetch(base + '/integrations/1c/catalog', {method:'POST',headers:{
      'content-type':'application/json','x-1c-key':integrationKey,'x-1c-base-kind':'PRODUCTION','x-1c-base-id':'http-main-ut103'
    },body:JSON.stringify({categories:[{oneCId:category.oneCId,name:category.name,slug:category.slug}],products:[{
      oneCId:product.oneCId,sku:product.sku,slug:product.slug,name:product.name,brand:product.brand,
      categoryOneCId:category.oneCId,price:1000,stockQty:1,costPrice:700
    }]})})
    assert.equal(imported.status,201,await imported.text())
    assert.equal((await prisma.product.findUniqueOrThrow({where:{id:product.id}})).priceSyncEnabled,true,
      'a fresh authenticated main-base import grants permission')
    const currentUrl = base + '/admin/price-monitor/price-update/current'
    assert.equal((await fetch(currentUrl)).status, 401)
    const login = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
    assert.equal(login.status, 201)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const empty = await fetch(currentUrl, { headers: { cookie } })
    assert.equal(empty.status, 200)
    const text = await empty.text()
    assert.notEqual(text.length, 0, 'No saved update must return JSON null, not an empty HTTP body')
    assert.match(empty.headers.get('content-type') || '', /application\/json/)
    assert.equal(JSON.parse(text), null)
    const readinessUrl = base + '/admin/price-monitor/price-readiness'
    assert.equal((await fetch(readinessUrl)).status, 401)
    const readiness = await (await fetch(readinessUrl, { headers: { cookie } })).json()
    assert.equal(readiness.items.length, 1)
    assert.equal(readiness.items[0].status, 'BLOCKED')
    assert.equal(readiness.items[0].reason, 'Нет привязки к 05.ru')
    const started = await fetch(base + '/admin/price-monitor/price-update', { method: 'POST',
      headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ productIds: [product.id] }) })
    assert.equal(started.status, 201)
    const operation = await started.json()
    assert.equal(operation.total, 1)
    assert.equal(operation.state, 'QUEUING')
    const saved = await fetch(currentUrl, { headers: { cookie } })
    assert.equal(saved.status, 200)
    assert.match(saved.headers.get('content-type') || '', /application\/json/)
    const body = await saved.json()
    assert.equal(body.id, operation.id)
    assert.equal(body.items[0].productId, product.id)
    assert.equal(await prisma.oneCPriceChange.count(), 0, 'reading or creating the workflow does not fabricate completed price updates')
    assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).price, 1000)
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
    await prisma?.$disconnect()
    for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(database + suffix, { force: true })
  }
})
