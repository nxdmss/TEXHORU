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
  const context = await browser.newContext()
  assert((await context.request.post(url + '/api/auth/login', { data: { email, password } })).ok())
  const page = await context.newPage()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', dialog => void dialog.accept())
  await page.goto(url + '/admin')
  await page.getByRole('button', { name: 'Цены', exact: true }).click()
  await page.locator('.pa-category-filter summary').click()
  const levels = ['МОБИЛЬНАЯ СВЯЗЬ', 'Смартфоны', 'Смартфоны Apple']
  for (const [i, name] of levels.entries()) {
    const response = page.waitForResponse(r => r.url().endsWith('/bulk-price-preview') && r.request().postDataJSON()?.categoryPath === levels.slice(0, i + 1).join(' / '))
    await page.locator('.pa-folders button').filter({ hasText: name }).click()
    await response
  }
  assert.equal(await page.locator('.pa-diagnostics').count(), 0, 'unlinked accessories must not appear in Apple diagnostics')
  await page.locator('.pa-scope summary').click()
  const bad = page.locator('.pa-offer').filter({ hasText: products[1].name })
  assert((await bad.locator('.pa-price-new').innerText()).includes('Сначала проверь привязку'))
  assert((await bad.locator('.pa-source-name').innerText()).includes('128GB Black б/у'))
  assert(await bad.locator('input[type=checkbox]').isDisabled())
  const good = page.locator('.pa-offer').filter({ hasText: products[0].name })
  assert(await good.locator('input[type=checkbox]').isDisabled(), 'scope is required before sending')
  await page.locator('.pa-scope-list label').filter({ hasText: products[0].name }).locator('input').check()
  await page.getByRole('button', { name: 'Разрешить выбранные для TEST (1)', exact: true }).click()
  await page.getByText(/Добавлено в TEST: 1/).waitFor()
  await good.locator('input[type=checkbox]').check()
  assert.equal(await prisma.oneCPriceChange.count(), 0, 'granting scope must not enqueue prices')
  await page.getByRole('button', { name: 'Отправить выбранные в 1С', exact: true }).click()
  await page.getByText(/В очереди 1С: 1/).waitFor()
  await good.getByText('Ожидает 1С', { exact: true }).waitFor()
  const changes = await prisma.oneCPriceChange.findMany()
  assert.equal(changes.length, 1)
  assert.equal(changes[0].productId, products[0].id)
  assert.equal(changes[0].newPrice, 64890)
  assert.equal((await prisma.product.findUnique({ where: { id: products[0].id } })).price, 63900)
  assert((await context.request.post(url + '/api/integrations/1c/price-sync/receipts', {
    headers: { 'x-1c-key': key }, data: { items: [{ id: changes[0].id, appliedPrice: 64890 }] },
  })).ok())
  assert.equal((await prisma.product.findUnique({ where: { id: products[0].id } })).price, 64890)
  assert.equal((await prisma.product.findUnique({ where: { id: products[1].id } })).price, 61900)
  assert.deepEqual(errors, [])
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true })
  console.log('PASS: Apple diagnostics, wrong-candidate blocking, explicit TEST approval, selected queueing and price publication after receipt.')
} finally {
  await browser?.close()
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') }
  await prisma?.$disconnect()
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(db + suffix, { force: true })
}
