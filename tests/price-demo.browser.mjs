// Run from the checkout root after npm run build:all. Uses an isolated SQLite DB.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
const require = createRequire(resolve('server/package.json'))
const { PrismaClient } = require('@prisma/client')
const { chromium } = require('playwright')
const bcrypt = require('bcryptjs')
const { fingerprint } = require('./dist/price-monitor/product-matching')
const db = resolve('server/prisma/monitor-test-ui-' + randomUUID() + '.db')
const dbUrl = 'file:' + db.replace(/\\/g, '/')
writeFileSync(db, '')
let prisma, child, browser
try {
  const push = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], {
    cwd: resolve('server'), env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8',
  })
  assert.equal(push.status, 0, push.stdout + push.stderr)
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  const email = 'demo-browser@test.local', password = randomUUID(), key = randomUUID()
  await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash(password, 4), name: 'Test', role: 'DIRECTOR' } })
  const category = await prisma.category.create({ data: { name: 'МОБИЛЬНАЯ СВЯЗЬ / Смартфоны / Смартфоны Apple', slug: 'apple' } })
  const accessories = await prisma.category.create({ data: { name: 'Аксессуары', slug: 'accessories' } })
  await prisma.product.create({ data: { categoryId: accessories.id, brand: 'Baseus', name: 'Автовизитка Baseus', sku: 'ACCESSORY', slug: 'accessory', oneCId: randomUUID(), price: 500 } })
  const source = await prisma.competitorSource.create({ data: { key: '05ru', name: '05.ru', baseUrl: 'https://05.ru' } })
  const products = []
  for (const [name, price] of [['Apple iPhone 16 128GB Green', 63900], ['Apple iPhone 15 256GB Black', 61900]]) {
    products.push(await prisma.product.create({ data: { categoryId: category.id, name, price, oneCId: randomUUID(), brand: 'Apple', sku: randomUUID(), slug: randomUUID(), stockQty: 1 } }))
  }
  for (let i = 0; i < products.length; i++) {
    const p = products[i], externalName = i === 0 ? p.name : 'Apple iPhone 15 128GB Black б/у'
    await prisma.competitorProduct.create({ data: { sourceId: source.id, productId: p.id, externalName,
      externalUrl: 'https://05.ru/cat/test/p/' + i + '/', attributes: {}, matchStatus: i === 0 ? 'CONFIRMED' : 'SUGGESTED',
      confirmedFingerprint: i === 0 ? fingerprint({ name: externalName, attributes: {} }) : null,
      confirmedProductFingerprint: i === 0 ? fingerprint(p) : null,
      latestPrice: i === 0 ? 64990 : 37990, inStock: true, lastSuccessAt: new Date(), priceSource: 'JSON-LD Offer' } })
  }
  const socket = net.createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  child = spawn(process.execPath, ['dist/main.js'], { cwd: resolve('server'), env: { ...process.env,
    DATABASE_URL: dbUrl, JWT_SECRET: randomUUID(), ONE_C_API_KEY: key, NODE_ENV: 'test',
    PORT: String(port), HOST: '127.0.0.1', FRONTEND_ORIGIN: 'http://127.0.0.1:' + port,
    TEXHORU_ENV_FILE: 'tests/nonexistent.env', MONITOR_WORKER_DISABLED: 'true', SERVE_STOREFRONT: 'true',
    ONE_C_BASE_KIND: 'TEST', ONE_C_TEST_PRICE_SYNC_ENABLED: 'true',
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', d => { log += d }); child.stderr.on('data', d => { log += d })
  const url = 'http://127.0.0.1:' + port
  let ready = false
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(url + '/api/health')).ok) { ready = true; break } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert(ready, log.slice(-1500))
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const context = await browser.newContext({ timezoneId: 'Europe/Moscow' })
  assert((await context.request.post(url + '/api/auth/login', { data: { email, password } })).ok())
  assert((await context.request.post(url + '/api/integrations/1c/agent/heartbeat', { headers: { 'x-1c-key': key }, data: { state: 'idle' } })).ok())
  let operation = null
  const startBodies = []
  const all = await prisma.product.findMany({ include: { category: true } })
  await context.route(/\/api\/admin\/price-monitor\/price-update(?:\/current|\/[^/]+\/cancel)?$/, async route => {
    const request = route.request()
    if (request.method() === 'GET') { await route.fulfill({ json: operation }); return }
    if (request.url().endsWith('/cancel')) {
      operation = { ...operation, state: 'CANCELLED', finishedAt: new Date().toISOString(),
        items: operation.items.map(item => ({ ...item, status: 'SKIPPED', reason: 'Остановлено пользователем' })) }
      await route.fulfill({ json: operation }); return
    }
    const body = request.postDataJSON(); startBodies.push(body)
    const target = body.productIds ? all.filter(p => body.productIds.includes(p.id)) : all
    operation = { id: randomUUID(), state: 'CHECKING', total: target.length, checked: 0,
      ready: 0, queued: 0, pending: 0, applied: 0, failed: 0, skipped: 0,
      createdAt: new Date().toISOString(), finishedAt: null,
      items: target.map(p => ({ productId: p.id, name: p.name, categoryPath: p.category.name,
        status: 'CHECKING', reason: null, oldPrice: p.price, newPrice: null, messageId: null })) }
    await route.fulfill({ json: operation })
  })
  const page = await context.newPage()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  let dialogs = 0; page.on('dialog', dialog => { dialogs++; void dialog.dismiss() })
  let hiddenToolRequests = 0; page.on('request', r => { if (r.url().endsWith('/price-monitor/jobs')) hiddenToolRequests++ })
  await page.goto(url + '/admin')
  await page.getByRole('button', { name: 'Цены', exact: true }).click()
  await page.getByRole('button', { name: 'Обновить все цены', exact: true }).waitFor()
  assert.equal(await page.locator('.pu-selection').getAttribute('open'), null)
  assert.equal(await page.locator('.pu-advanced').getAttribute('open'), null)
  assert.equal(await page.locator('.pu-advanced .price-monitor').count(), 0)
  assert.equal(hiddenToolRequests, 0, 'hidden matching tools must not poll')
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace('.png', '-desktop.png'), fullPage: true })
  await page.locator('.pu-selection summary').click()
  await page.getByLabel('Раздел товаров').selectOption(category.name)
  await page.getByRole('button', { name: 'Обновить выбранные (2)', exact: true }).waitFor()
  assert.equal(await page.locator('.pu-product-list label').count(), 2)
  await page.getByRole('button', { name: 'Снять выбор', exact: true }).click()
  assert(await page.getByRole('button', { name: 'Обновить выбранные (0)', exact: true }).isDisabled())
  await page.getByLabel('Обновить товар: ' + products[0].name).check()
  const startButton = page.getByRole('button', { name: 'Обновить выбранные (1)', exact: true })
  await startButton.click()
  await page.getByText('Проверяем цены: 0 из 1', { exact: true }).waitFor()
  assert.deepEqual(startBodies, [{ productIds: [products[0].id] }])
  assert.equal(dialogs, 0, 'the explicit update button should not require another dialog')
  assert(await page.getByRole('button', { name: 'Обновление идёт…', exact: true }).isDisabled())
  operation = { ...operation, state: 'WAITING', checked: 1, pending: 1, queued: 1,
    items: operation.items.map(item => ({ ...item, status: 'PENDING', newPrice: 64890, messageId: 'fixture-receipt' })) }
  await page.getByText('Ожидаем подтверждения 1С: 1', { exact: true }).waitFor({ timeout: 12000 })
  assert.equal(await page.locator('.pu-counts').innerText(), '0 обновлено\n1 ждут 1С')
  assert.equal(await page.locator('.pu-results').getAttribute('open'), null)
  operation = { ...operation, state: 'COMPLETED', pending: 0, applied: 1, finishedAt: new Date().toISOString(),
    items: operation.items.map(item => ({ ...item, status: 'APPLIED' })) }
  await page.getByText('Обновление завершено', { exact: true }).waitFor({ timeout: 12000 })
  await page.locator('.pu-results summary').first().click()
  await page.getByText('Обновлено', { exact: true }).waitFor()
  assert((await page.locator('.pu-result').innerText()).includes('64'))
  await page.getByRole('button', { name: 'Все товары', exact: true }).click()
  await page.getByRole('button', { name: 'Обновить все цены', exact: true }).click()
  await page.getByText('Проверяем цены: 0 из 3', { exact: true }).waitFor()
  assert.deepEqual(startBodies[1], {}, 'all-products action must not silently retain selected IDs')
  if ((await page.locator('.pu-results').getAttribute('open')) === null) await page.locator('.pu-results summary').first().click()
  await page.getByRole('button', { name: 'Остановить подготовку', exact: true }).click()
  await page.getByText('Оставшиеся товары остановлены', { exact: true }).waitFor()
  await page.locator('.pu-results summary').first().click()
  await page.locator('.pu-selection summary').click()
  await page.setViewportSize({ width: 390, height: 844 })
  assert(await page.locator('.pu-root').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'price UI overflows on mobile')
  assert.deepEqual(errors, [])
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true })
  console.log('PASS: compact default, collapsed tools, category/selected/all intent, one click, receipt-only success, cancellation and mobile layout. Workflow HTTP responses are mocked; persistence is tested in backend suite.')

} finally {
  await browser?.close()
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') }
  await prisma?.$disconnect()
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(db + suffix, { force: true })
}
