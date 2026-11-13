const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID, createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const { rmSync, writeFileSync } = require('node:fs')

test('SMTP failures expose diagnostic codes without credentials or account links', async () => {
  const { AccountMailService } = require('../dist/auth/account-mail.service')
  const secrets = { SMTP_HOST: 'smtp.example.test', SMTP_USER: 'sender@example.test', SMTP_PASSWORD: randomUUID(), MAIL_FROM: 'sender@example.test', FRONTEND_PUBLIC_URL: 'https://shop.example.test' }
  const token = randomUUID(), messages = []
  const service = new AccountMailService({ get: key => secrets[key] })
  service.logger = { error: message => messages.push(message) }
  for (const failure of [
    { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN', message: secrets.SMTP_PASSWORD },
    { code: 'ETIMEDOUT', command: 'CONN', response: token },
    { code: token, command: secrets.SMTP_USER },
    null,
  ]) {
    service.transport = { sendMail: async () => { throw failure }, close() {} }
    await assert.rejects(service.send('recipient@example.test', 'Test', token, 'VERIFY'), error => error.getStatus() === 503)
  }
  assert.match(messages[0], /code=EAUTH responseCode=535 command=AUTH PLAIN/)
  assert.match(messages[1], /code=ETIMEDOUT responseCode=unknown command=CONN/)
  assert.match(messages[2], /code=unknown responseCode=unknown command=unknown/)
  for (const secret of [secrets.SMTP_PASSWORD, secrets.SMTP_USER, token, 'recipient@example.test']) assert(!messages.join(' ').includes(secret))
  service.onModuleDestroy()
})

// Real HTTP controllers/guards, real isolated SQLite; mail transport is replaced in tests.
test('customer lifecycle, access boundaries, and resumable bounded catalog exchange', async t => {
  const database = resolve(__dirname, '../prisma/monitor-test-accounts-' + randomUUID() + '.db')
  const dbUrl = 'file:' + database
  writeFileSync(database, '')
  const env = { DATABASE_URL: dbUrl, JWT_SECRET: randomUUID(), ONE_C_API_KEY: randomUUID(),
    NODE_ENV: 'test', TEXHORU_ENV_FILE: 'tests/missing.env', MONITOR_WORKER_DISABLED: 'true',
    FRONTEND_PUBLIC_URL: 'http://localhost', MEDIA_STORAGE_DRIVER: 'local', ALLOW_DEV_PAYMENT: 'false' }
  Object.assign(process.env, env)
  const push = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], { cwd: resolve(__dirname, '..'), env: process.env, encoding: 'utf8' })
  assert.equal(push.status, 0, push.stdout + push.stderr)
  const { Test } = require('@nestjs/testing')
  const { ValidationPipe } = require('@nestjs/common')
  const { AppModule } = require('../dist/app.module')
  const { AccountMailService } = require('../dist/auth/account-mail.service')
  const { PrismaService } = require('../dist/prisma/prisma.service')
  const { accountEmail } = require('../dist/auth/auth-email')
  const delivered = []
  let failMail = false
  const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AccountMailService).useValue({
    configured: () => true, assertConfigured() {}, send: async (email, name, token, purpose) => { if (failMail) throw new Error('mail unavailable'); delivered.push({ email, name, token, purpose }) },
  }).compile()
  const app = module.createNestApplication({ logger: false })
  app.setGlobalPrefix('api'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
  await app.listen(0, '127.0.0.1')
  const base = await app.getUrl(), db = app.get(PrismaService)
  async function request(path, data, cookie, key = false, method = 'POST') {
    const res = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(key ? { 'x-1c-key': env.ONE_C_API_KEY } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
    return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], body: await res.json() }
  }
  const email = 'customer@example.ru', password = 'original-password-123', newer = 'new-secure-password-456'
  let cookie, staffCookie, user
  try {
    await t.test('registration cannot choose a role and sends a hashed, expiring, one-use verification token', async () => {
      assert.equal((await request('/auth/register', { email, password, name: 'Амина', role: 'ADMIN' })).status, 400)
      assert.equal((await request('/auth/register', { email, password, name: 'Амина' })).status, 201)
      user = await db.user.findUniqueOrThrow({ where: { email } })
      assert.equal(user.role, 'CUSTOMER'); assert.equal(user.emailVerifiedAt, null)
      assert.notEqual(user.passwordHash, password)
      const record = await db.emailToken.findFirstOrThrow({ where: { userId: user.id } })
      assert.notEqual(record.tokenHash, delivered[0].token)
      assert.equal(record.tokenHash, createHash('sha256').update(delivered[0].token).digest('hex'))
      assert(record.expiresAt > new Date())
      assert.equal((await request('/auth/customer-login', { email, password })).status, 403)
      assert.equal((await request('/auth/verify-email', { token: delivered[0].token })).status, 201)
      assert.equal((await request('/auth/verify-email', { token: delivered[0].token })).status, 400)
      const login = await request('/auth/customer-login', { email, password })
      assert.equal(login.status, 201); cookie = login.cookie
      assert(cookie.startsWith('texhoru_customer=')); assert(!login.body.accessToken)
    })
    await t.test('customer profile is scoped, and customer credentials cannot enter administration', async () => {
      assert.equal((await request('/auth/login', { email, password })).status, 401)
      assert.equal((await request('/admin/products', undefined, cookie, false, 'GET')).status, 401)
      assert.equal((await request('/account/profile', undefined, undefined, false, 'GET')).status, 401)
      const saved = await request('/account/profile', { name: 'Амина Тест', phone: '+79991234567', deliveryAddress: 'Кизилюрт, тестовая улица' }, cookie, false, 'PATCH')
      assert.equal(saved.status, 200); assert.equal(saved.body.name, 'Амина Тест'); assert.equal(saved.body.passwordHash, undefined)
      assert.equal((await request('/account/profile', { name: 'Амина', role: 'ADMIN' }, cookie, false, 'PATCH')).status, 400)
    })
    const category = await db.category.create({ data: { name: 'Тест', slug: randomUUID() } })
    const product = await db.product.create({ data: { name: 'Наушники', brand: 'Тест', categoryId: category.id, sku: randomUUID(), slug: randomUUID(), price: 5000, stockQty: 10 } })
    await t.test('orders belong to the authenticated user, never an unverified email match', async () => {
      const input = { idempotencyKey: randomUUID(), customerName: 'Амина', customerPhone: '+79991234567', customerEmail: 'different@example.ru', deliveryMethod: 'PICKUP', deliveryAddress: 'Кизилюрт', paymentMethod: 'ON_RECEIPT', items: [{ productId: product.id, quantity: 1 }] }
      assert.equal((await request('/orders', input, cookie)).status, 201)
      const mine = await request('/account/orders', undefined, cookie, false, 'GET')
      assert.equal(mine.status, 200); assert.equal(mine.body.length, 1)
      assert.equal((await db.order.findFirstOrThrow()).userId, user.id)
      const guest = { ...input, idempotencyKey: randomUUID(), customerEmail: email }
      assert.equal((await request('/orders', guest)).status, 201)
      assert.equal((await request('/account/orders', undefined, cookie, false, 'GET')).body.length, 1)
      const another = await db.user.create({ data: { name: 'Other', email: 'other@example.ru', emailVerifiedAt: new Date(), passwordHash: user.passwordHash } })
      const other = await request('/auth/customer-login', { email: another.email, password })
      assert.equal((await request('/account/orders', undefined, other.cookie, false, 'GET')).body.length, 0)
    })
    await t.test('expired/reset tokens, repeat requests, and old sessions are rejected', async () => {
      assert.equal((await request('/auth/forgot-password', { email })).status, 201)
      const reset = delivered.find(item => item.purpose === 'RESET')
      const count = delivered.length
      await request('/auth/forgot-password', { email }); assert.equal(delivered.length, count)
      assert.equal((await request('/auth/reset-password', { token: reset.token, password: newer })).status, 201)
      assert.equal((await request('/account/profile', undefined, cookie, false, 'GET')).status, 401)
      assert.equal((await request('/auth/customer-login', { email, password })).status, 401)
      assert.equal((await request('/auth/customer-login', { email, password: newer })).status, 201)
      assert.equal((await request('/auth/reset-password', { token: reset.token, password: newer })).status, 400)
      const token = 'a'.repeat(64)
      await db.emailToken.create({ data: { userId: user.id, purpose: 'RESET', tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(0) } })
      assert.equal((await request('/auth/reset-password', { token, password: newer })).status, 400)
      const content = accountEmail('<img onerror=bad>', 'https://example.ru/account#token=secret', 'VERIFY')
      assert(!content.html.includes('<img onerror')); assert(content.html.includes('&lt;img'))
      assert(content.text.includes('https://example.ru/')); assert(content.html.includes('Подтвердить почту'))
    })
    await t.test('catalog batch replay is atomic, conflicts are explicit, only one session can run', async () => {
      const sessionId = randomUUID(), start = { sessionId, clientId: 'test-base', mode: 'FULL' }
      assert.equal((await request('/integrations/1c/catalog-sync/start', start)).status, 401)
      assert.equal((await request('/integrations/1c/catalog-sync/start', start, null, true)).status, 201)
      assert.equal((await request('/integrations/1c/catalog-sync/start', { ...start, sessionId: randomUUID() }, null, true)).status, 409)
      const cid = randomUUID(), pid = randomUUID()
      const batch = { batch: 0, categories: [{ oneCId: cid, name: 'Смартфоны', slug: 'category-' + cid }], products: [{ oneCId: pid, sku: '1C-' + pid, slug: '1c-' + pid, categoryOneCId: cid, name: 'Смартфон Apple iPhone 16 128 Гб черный', brand: 'Apple', price: 50000, stockQty: 3 }] }
      const path = '/integrations/1c/catalog-sync/' + sessionId
      const first = await request(path + '/batch', batch, null, true)
      assert.equal(first.status, 201, JSON.stringify(first.body)); assert.equal(first.body.nextBatch, 1)
      assert.equal((await request(path + '/batch', batch, null, true)).body.nextBatch, 1)
      assert.equal(await db.product.count({ where: { oneCId: pid } }), 1)
      assert.equal((await db.catalogImportSession.findUniqueOrThrow({ where: { id: sessionId } })).processed, 1)
      assert.equal((await request(path + '/batch', { ...batch, products: [{ ...batch.products[0], price: 1 }] }, null, true)).status, 409)
      const bad = { ...batch, batch: 1, products: [{ ...batch.products[0], categoryOneCId: 'missing' }] }
      assert.equal((await request(path + '/batch', bad, null, true)).status, 500)
      assert.equal((await db.catalogImportSession.findUniqueOrThrow({ where: { id: sessionId } })).nextBatch, 1)
      assert.equal((await request(path + '/batch', { ...batch, batch: 1, products: [{ ...batch.products[0], stockQty: 0 }] }, null, true)).status, 201)
      assert.equal((await db.product.findUniqueOrThrow({ where: { oneCId: pid } })).stockQty, 0)
      assert.equal((await request(path + '/finish', {}, null, true)).body.status, 'COMPLETED')
      assert.equal((await request(path + '/finish', {}, null, true)).body.status, 'COMPLETED')
      assert.equal((await request('/integrations/1c/catalog-sync/start', start, null, true)).body.status, 'COMPLETED')
      assert.equal((await request(path + '/batch', { ...batch, batch: 2 }, null, true)).status, 409)
      assert.equal((await request('/integrations/1c/catalog-sync/start', { ...start, sessionId: randomUUID() }, null, true)).status, 201)
    })
    await t.test('server catalog pages, case-insensitive search, exact model paths and public fields stay bounded', async () => {
      await db.product.createMany({ data: Array.from({ length: 130 }, (_, i) => ({ name: 'Наушники модель ' + i, brand: 'Audio', categoryId: category.id, sku: randomUUID(), slug: randomUUID(), price: 1000+i, costPrice: 500, stockQty: 2 })) })
      const page1 = await request('/catalog/products?take=24&page=1&sort=price-desc', undefined, null, false, 'GET')
      const page2 = await request('/catalog/products?take=24&page=2&sort=price-desc', undefined, null, false, 'GET')
      assert.equal(page1.status, 200); assert.equal(page1.body.items.length, 24); assert.equal(page2.body.items.length, 24)
      assert(page1.body.hasMore); assert(!page2.body.items.some(item => page1.body.items.some(first => first.id === item.id)))
      assert(page1.body.items.every((item,i,rows) => !i || item.price <= rows[i-1].price))
      assert(page1.body.items.every(item => item.costPrice === undefined && item.reservedQty === undefined && item.importVariantKey === undefined))
      const query = await request('/catalog/products?q=' + encodeURIComponent('НАУШНИКИ МОДЕЛЬ 129'), undefined, null, false, 'GET')
      assert.equal(query.body.items.length, 1); assert.equal(query.body.items[0].name, 'Наушники модель 129')
      assert.equal((await request('/catalog/products?take=101', undefined, null, false, 'GET')).status, 400)
      assert((await request('/catalog/home', undefined, null, false, 'GET')).body.length <= 100)
      const phones = await db.category.create({ data: { name: 'Смартфоны', slug: randomUUID() } })
      for (const name of ['Apple iPhone 17 Pro 256 Гб белый', 'Apple iPhone 17 Pro Max 256 Гб белый']) await db.product.create({ data: { name, brand: 'Apple', categoryId: phones.id, sku: randomUUID(), slug: randomUUID(), price: 50000, stockQty: 1 } })
      const model = await request('/catalog/products?path=' + encodeURIComponent('Смартфоны / iPhone 17 Pro'), undefined, null, false, 'GET')
      assert.equal(model.body.items.length, 1); assert.equal(model.body.items[0].name, 'Apple iPhone 17 Pro 256 Гб белый')
    })
    await t.test('legacy imports yield to a running session and administrators can stop it without losing products', async () => {
      const bcrypt = require('bcryptjs')
      await db.user.create({ data: { email: 'director@example.ru', name: 'Director', role: 'DIRECTOR', passwordHash: await bcrypt.hash(password, 4) } })
      const login = await request('/auth/login', { email: 'director@example.ru', password }); staffCookie = login.cookie
      assert.equal(login.status, 201); assert(staffCookie.startsWith('texhoru_admin='))
      assert.equal((await request('/account/profile', undefined, staffCookie, false, 'GET')).status, 401)
      const state = await request('/admin/integrations/1c/catalog-sync', undefined, staffCookie, false, 'GET')
      assert.equal(state.status, 200); const id = state.body.session.id
      assert.equal((await request('/integrations/1c/catalog', { categories: [], products: [] }, null, true)).status, 429)
      const before = await db.product.count()
      assert.equal((await request('/admin/integrations/1c/catalog-sync/' + id + '/cancel', {}, staffCookie)).status, 201)
      assert.equal(await db.product.count(), before)
      assert.equal((await request('/integrations/1c/catalog-sync/' + id + '/finish', {}, null, true)).status, 409)
      assert.equal((await request('/integrations/1c/catalog-sync/start', { sessionId: randomUUID(), clientId: 'next-base', mode: 'DELTA' }, null, true)).status, 201)
    })
    await t.test('storefront editor keeps drafts private until an administrator publishes them', async () => {
      const initial = await request('/content/layout', undefined, null, false, 'GET')
      assert.equal(initial.status, 200)
      assert.deepEqual(initial.body.layout.blocks.map(item => item.type), ['collections', 'promo', 'products'])
      assert.equal((await request('/admin/content/layout', undefined, undefined, false, 'GET')).status, 401)
      const layout = { version: 1, blocks: [
        { id: 'intro', type: 'text', width: 6, visible: true, eyebrow: 'TEXHORU', title: 'Новая главная', body: 'Черновик' },
        { id: 'catalog', type: 'products', width: 6, visible: true, title: 'Выбор магазина' },
      ] }
      const saved = await request('/admin/content/layout/draft', { layout }, staffCookie, false, 'PUT')
      assert.equal(saved.status, 200, JSON.stringify(saved.body))
      assert.deepEqual(saved.body.draft.blocks.map(item => item.id), ['intro', 'catalog'])
      const beforePublish = await request('/content/layout', undefined, null, false, 'GET')
      assert.deepEqual(beforePublish.body.layout.blocks.map(item => item.type), ['collections', 'promo', 'products'])
      const published = await request('/admin/content/layout/publish', { layout }, staffCookie)
      assert.equal(published.status, 201, JSON.stringify(published.body))
      const publicLayout = await request('/content/layout', undefined, null, false, 'GET')
      assert.deepEqual(publicLayout.body.layout.blocks.map(item => item.id), ['intro', 'catalog'])
      assert.equal((await request('/admin/content/layout/draft', { layout: { version: 1, blocks: [{ id: 'bad', type: 'script', width: 12 }] } }, staffCookie, false, 'PUT')).status, 400)
    })
    await t.test('oversized catalog batches are rejected before importing', async () => {
      const session = await db.catalogImportSession.findFirstOrThrow({ where: { status: 'RUNNING' } })
      const rows = Array.from({ length: 101 }, () => ({ oneCId: randomUUID(), sku: randomUUID(), slug: randomUUID(), categoryOneCId: 'x', name: 'x', brand: 'x', price: 1, stockQty: 1 }))
      assert.equal((await request('/integrations/1c/catalog-sync/' + session.id + '/batch', { batch: 0, categories: [], products: rows }, null, true)).status, 400)
      assert.equal((await db.catalogImportSession.findUniqueOrThrow({ where: { id: session.id } })).nextBatch, 0)
    })
  } finally {
    await app.close()
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(database + suffix, { force: true })
  }
})
