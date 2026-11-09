// Built frontend + real Nest API and isolated SQLite. No live shop, payment or 1C writes.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
const require = createRequire(resolve('server/package.json'))
const { PrismaClient } = require('@prisma/client')
const { chromium } = require('playwright')
const bcrypt = require('bcryptjs')
const db = resolve('server/prisma/monitor-test-store-' + randomUUID() + '.db')
const dbUrl = 'file:' + db.replace(/\\/g, '/')
const screenshot = async (page, name, fullPage = true) => {
  if (process.env.SCREENSHOT_DIR) {
    if (fullPage) await page.evaluate(() => window.scrollTo(0, 0))
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIR, name + '.png'), fullPage })
  }
}
writeFileSync(db, '')
let prisma, child, browser
try {
  const push = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], {
    cwd: resolve('server'), env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8',
  })
  assert.equal(push.status, 0, push.stdout + push.stderr)
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  const category = await prisma.category.create({ data: { name: 'Смартфоны', slug: 'smartphones' } })
  const accessories = await prisma.category.create({ data: { name: 'Аксессуары', slug: 'accessories' } })
  const names = ['Смартфон Apple iPhone 16 128 Гб черный', 'Смартфон Samsung Galaxy S25 256 Гб серебристый', 'Смартфон Xiaomi 15 256 Гб зеленый', 'Смартфон Apple iPhone 15 256 Гб белый', 'Смартфон Samsung Galaxy A56 128 Гб черный']
  const products = []
  for (let i = 0; i < names.length; i++) products.push(await prisma.product.create({ data: {
    categoryId: category.id, name: names[i], brand: names[i].split(' ')[1], image: '/products/phone-alt.svg',
    oneCId: randomUUID(), price: i ? 49900 + i * 5000 : 58900, sku: randomUUID(), slug: randomUUID(),
    stockQty: i ? 8 : 2, shortSpec: '128 ГБ · AMOLED · USB-C', warranty: '12 месяцев', deliveryNote: 'Самовывоз и доставка',
    description: 'Смартфон для работы, фотографий и повседневных задач.', specs: [{ label: 'Память', value: '128 ГБ' }],
  } }))
  const soldOut = await prisma.product.create({ data: { categoryId: accessories.id, name: 'Кабель Hoco X90 белый', brand: 'Hoco',
    price: 900, stockQty: 0, sku: 'EMPTY', slug: 'empty', image: '/products/phone.svg' } })
  const email = 'store-browser@test.local', password = randomUUID()
  await prisma.user.create({ data: { email, name: 'Director', role: 'DIRECTOR', passwordHash: await bcrypt.hash(password, 4) } })
  const socket = net.createServer()
  await new Promise(done => socket.listen(0, '127.0.0.1', done))
  const port = socket.address().port
  await new Promise(done => socket.close(done))
  const url = 'http://127.0.0.1:' + port
  child = spawn(process.execPath, ['dist/main.js'], { cwd: resolve('server'), env: { ...process.env,
    DATABASE_URL: dbUrl, JWT_SECRET: randomUUID(), ONE_C_API_KEY: randomUUID(), NODE_ENV: 'test',
    HOST: '127.0.0.1', PORT: String(port), FRONTEND_ORIGIN: url, FRONTEND_PUBLIC_URL: url,
    TEXHORU_ENV_FILE: 'tests/nonexistent.env', MONITOR_WORKER_DISABLED: 'true', SERVE_STOREFRONT: 'true',
    PAYMENT_PROVIDER: 'mock', ALLOW_DEV_PAYMENT: 'false', ONE_C_BASE_KIND: 'TEST', ONE_C_TEST_PRICE_SYNC_ENABLED: 'true',
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', data => { log += data }); child.stderr.on('data', data => { log += data })
  let ready = false
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(url + '/api/health')).ok) { ready = true; break } } catch {}
    await new Promise(done => setTimeout(done, 100))
  }
  assert(ready, log.slice(-2000))
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  let lastPage, lastContext
  for (const width of [1440, 768, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', timezoneId: 'Europe/Moscow' })
    const page = await context.newPage()
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    // Corrupt saved baskets must not crash the storefront.
    await page.addInitScript(() => { if (!sessionStorage.getItem('cart-seeded')) { localStorage.setItem('texhoru_cart', '{"invalid":true}'); sessionStorage.setItem('cart-seeded', 'true') } })
    await page.goto(url)
    const card = page.locator(`[data-product-id="${products[0].id}"]`)
    await card.getByRole('button', { name: 'Добавить ' + names[0] + ' в корзину', exact: true }).waitFor()
    assert(await page.locator('.app-shell').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'home overflows at ' + width)
    await screenshot(page, 'store-home-' + width)
    const search = page.getByLabel('Поиск по каталогу', { exact: true })
    await search.fill('Samsung')
    await search.press('Enter')
    assert.equal(await search.inputValue(), 'Samsung', 'Enter preserves the search query')
    assert.equal(await page.locator('.product-card').count(), 2)
    await page.getByRole('button', { name: 'Очистить поиск', exact: true }).click()
    await page.locator('.phone-portal__button').click()
    await page.waitForURL('**/catalog/smartphones')
    assert(await page.locator('.app-shell').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'phone catalog overflows at ' + width)
    await page.getByRole('button', { name: /^Apple/ }).click()
    await page.waitForURL('**/catalog/smartphones/apple')
    assert.equal(await page.locator('.product-card').count(), 2)
    await page.locator('.header .brand-button').click()
    await page.waitForURL(url + '/')
    const photo = await card.locator('img').getAttribute('src')
    await card.getByRole('button', { name: /Добавить/ }).click()
    const dialog = page.getByRole('dialog', { name: /Корзина/ })
    await dialog.waitFor()
    assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden')
    assert.equal(await dialog.locator('.cart-line__image img').getAttribute('src'), photo)
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Перейти к оформлению')
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Закрыть корзину')
    await dialog.getByRole('button', { name: 'Увеличить количество: ' + names[0], exact: true }).click()
    assert(await dialog.getByRole('button', { name: 'Увеличить количество: ' + names[0], exact: true }).isDisabled())
    assert.equal((await dialog.locator('.total strong').innerText()).replace(/\s/g, ''), '117800₽')
    assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'basket overflows at ' + width)
    await screenshot(page, 'store-cart-' + width, false)
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.equal(await page.evaluate(() => document.body.style.overflow), '')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Открыть корзину: ' + names[0])
    // Reload keeps a valid basket and authoritative prices/stock come from the API.
    await page.reload()
    await card.getByRole('button', { name: 'Открыть корзину: ' + names[0], exact: true }).waitFor()
    await card.getByRole('button', { name: 'Открыть корзину: ' + names[0], exact: true }).click()
    await dialog.getByRole('button', { name: 'Удалить из корзины: ' + names[0], exact: true }).click()
    await dialog.getByText('Здесь будут ваши покупки', { exact: true }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: 'Перейти к оформлению', exact: true }).count(), 0)
    await dialog.getByRole('button', { name: 'Продолжить покупки', exact: true }).click()
    await card.getByRole('button', { name: /Добавить/ }).click()
    await dialog.getByRole('button', { name: 'Перейти к оформлению', exact: true }).click()
    await page.getByRole('heading', { name: 'Ваш заказ', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Онлайн Картой на сайте', exact: true }).count(), 0, 'unconfigured payment is not offered')
    await page.getByRole('button', { name: 'Доставка Кизилюрт и Дагестан', exact: true }).click()
    assert.equal(await page.getByLabel('Адрес доставки', { exact: true }).inputValue(), '')
    assert.equal(await page.getByLabel('Адрес доставки', { exact: true }).evaluate(el => el.checkValidity()), false)
    await page.getByRole('button', { name: 'Самовывоз Кизилюрт', exact: true }).click()
    assert(await page.locator('.app-shell').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'checkout overflows at ' + width)
    await screenshot(page, 'store-checkout-' + width)
    await page.goto(url + '/product/' + products[0].id)
    await page.getByRole('heading', { name: names[0], exact: true }).waitFor()
    assert(await page.locator('.app-shell').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'product overflows at ' + width)
    await screenshot(page, 'store-product-' + width)
    await page.goto(url + '/product/' + soldOut.id)
    await page.getByRole('heading', { name: soldOut.name, exact: true }).waitFor()
    assert(await page.getByRole('button', { name: 'Добавить в корзину', exact: true }).isDisabled(), 'sold out is not a preorder')
    assert.deepEqual(errors, [])
    lastPage = page; lastContext = context
  }
  // Retry after a lost response: the real isolated API keeps one order and one reservation.
  await lastPage.goto(url + '/checkout')
  await lastPage.getByLabel('Имя', { exact: true }).fill('Тестовый покупатель')
  await lastPage.getByLabel('Телефон', { exact: true }).fill('+79991234567')
  const attempts = []
  await lastPage.route('**/api/orders', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    attempts.push(route.request().postDataJSON())
    if (attempts.length > 1) return route.continue()
    const response = await route.fetch()
    assert.equal(response.status(), 201)
    // Simulate a lost response after the server accepted the first order.
    await route.fulfill({ status: 503, json: { message: 'Попробуйте ещё раз' } })
  })
  await lastPage.getByRole('button', { name: /Оформить заказ/ }).click()
  await lastPage.getByRole('alert').getByText('Попробуйте ещё раз', { exact: true }).waitFor()
  await lastPage.getByRole('button', { name: /Оформить заказ/ }).click()
  await lastPage.waitForURL('**/order/**')
  const order = await prisma.order.findFirst({ include: { items: true } })
  assert.equal(order.total, 58900)
  assert.equal(order.items.length, 1)
  assert.equal(order.items[0].quantity, 1)
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].idempotencyKey, attempts[1].idempotencyKey)
  assert.equal(await prisma.order.count(), 1, 'retrying an accepted order does not duplicate it')
  assert.equal((await prisma.product.findUnique({ where: { id: products[0].id } })).reservedQty, 1)
  assert.equal(await lastPage.evaluate(() => localStorage.getItem('texhoru_cart')), '[]')
  await lastPage.goto(url + '/checkout')
  await lastPage.getByRole('heading', { name: 'Корзина пока пуста', exact: true }).waitFor()
  assert.equal(await lastPage.locator('form').count(), 0)
  assert((await lastContext.request.post(url + '/api/auth/login', { data: { email, password } })).ok())
  await lastPage.setViewportSize({ width: 1440, height: 1000 })
  await lastPage.goto(url + '/admin')
  await lastPage.getByRole('heading', { name: 'Рабочий стол', exact: true }).waitFor()
  await screenshot(lastPage, 'admin-brand-1440')
  await lastPage.getByRole('button', { name: 'Цены', exact: true }).click()
  await lastPage.getByRole('heading', { name: 'Цены под контролем', exact: true }).waitFor()
  await screenshot(lastPage, 'admin-prices-brand-1440')
  console.log('PASS: desktop/mobile catalog, shared images and totals, basket persistence/removal, stock limits, keyboard focus, honest payment options, empty checkout and real isolated order reservation.')
} finally {
  await browser?.close()
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') }
  await prisma?.$disconnect()
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(db + suffix, { force: true })
}
