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
  const unapproved = await prisma.product.create({ data: { categoryId: accessories.id, brand: 'Baseus', name: 'Автовизитка Baseus', sku: 'ACCESSORY', slug: 'accessory', oneCId: randomUUID(), price: 500, stockQty: 1 } })
  const source = await prisma.competitorSource.create({ data: { key: '05ru', name: '05.ru', baseUrl: 'https://05.ru' } })
  const products = []
  for (const [name, price] of [['Apple iPhone 16 128GB Green', 63900], ['Apple iPhone 15 256GB Black', 61900], ['Apple iPhone 16 128GB White', 57900]]) {
    products.push(await prisma.product.create({ data: { categoryId: category.id, name, price, oneCId: randomUUID(), brand: 'Apple', sku: randomUUID(), slug: randomUUID(), stockQty: 1, priceSyncEnabled: true } }))
  }
  for (let i = 0; i < products.length; i++) {
    const p = products[i], externalName = i !== 1 ? p.name : 'Apple iPhone 15 128GB Black б/у'
    await prisma.competitorProduct.create({ data: { sourceId: source.id, productId: p.id, externalName,
      externalUrl: 'https://05.ru/cat/test/p/' + i + '/', attributes: {}, matchStatus: i !== 1 ? 'CONFIRMED' : 'SUGGESTED',
      confirmedFingerprint: i !== 1 ? fingerprint({ name: externalName, attributes: {} }) : null,
      confirmedProductFingerprint: i !== 1 ? fingerprint(p) : null,
      latestPrice: i !== 1 ? 64990 : 37990, inStock: true, lastSuccessAt: new Date(), priceSource: 'JSON-LD Offer' } })
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
    if (request.method() === 'GET') {
      if (!operation) { await route.continue(); return } // Exercise the real first-run JSON contract.
      await route.fulfill({ json: operation }); return
    }
    if (request.url().endsWith('/cancel')) {
      operation = { ...operation, state: 'CANCELLED', finishedAt: new Date().toISOString(),
        items: operation.items.map(item => ({ ...item, status: 'SKIPPED', reason: 'Остановлено пользователем' })) }
      await route.fulfill({ json: operation }); return
    }
    const body = request.postDataJSON(); startBodies.push(body)
    const target = body.productIds ? all.filter(p => body.productIds.includes(p.id)) : all
    operation = { id: randomUUID(), state: 'QUEUING', total: target.length, checked: target.length,
      ready: 0, queued: 0, pending: 0, applied: 0, failed: 0, skipped: 0,
      createdAt: new Date().toISOString(), finishedAt: null,
      items: target.map(p => ({ productId: p.id, name: p.name, categoryPath: p.category.name,
        status: 'READY', reason: null, oldPrice: p.price, newPrice: null, messageId: null })) }
    await route.fulfill({ json: operation })
  })
  const page = await context.newPage()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  let dialogs = 0; page.on('dialog', dialog => { dialogs++; void dialog.dismiss() })
  let hiddenToolRequests = 0; page.on('request', r => { if (r.url().endsWith('/price-monitor/jobs')) hiddenToolRequests++ })
  await page.goto(url + '/admin')
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace('.png', '-overview.png'), fullPage: true })
  await page.getByRole('button', { name: 'Цены', exact: true }).click()
  await page.getByRole('button', { name: 'Обновить готовые (2)', exact: true }).waitFor()
  assert.equal(await page.locator('.pu-selection').getAttribute('open'), null)
  assert.equal(await page.locator('.pu-advanced').getAttribute('open'), null)
  assert.equal(await page.locator('.pu-advanced .mp-shell').count(), 0)
  assert.equal(await page.locator('.pa-scope').count(), 0, 'technical permissions must not be mounted on the default screen')
  assert.equal(hiddenToolRequests, 0)
  await page.getByRole('button', { name: '2 Нельзя обновить', exact: true }).click()
  await page.getByText('Не совпадают характеристики', { exact: true }).waitFor()
  await page.getByText('Не разрешён обмен с 1С', { exact: true }).waitFor()
  assert.equal(await page.locator('.pu-product-list input[type=checkbox]').count(), 0)
  await page.getByRole('button', { name: '2 Готовы к обновлению', exact: true }).click()
  await page.getByLabel('Раздел товаров').selectOption(category.name)
  assert.equal(await page.locator('.pu-product-list label').count(), 2)
  await page.getByRole('button', { name: 'Снять выбор', exact: true }).click()
  assert(await page.getByRole('button', { name: 'Обновить выбранные (0)', exact: true }).isDisabled())
  await page.getByLabel('Обновить товар: ' + products[0].name).check()
  await page.getByRole('button', { name: 'Обновить выбранные (1)', exact: true }).click()
  await page.getByText('Подготавливаем передачу в 1С', { exact: true }).waitFor()
  assert.deepEqual(startBodies, [{ productIds: [products[0].id] }])
  assert.equal(dialogs, 0)
  operation = { ...operation, state: 'WAITING', checked: 1, pending: 1, queued: 1,
    items: operation.items.map(item => ({ ...item, status: 'PENDING', newPrice: 64890, messageId: 'fixture-receipt' })) }
  await page.getByText('Ожидаем подтверждения 1С: 1', { exact: true }).waitFor({ timeout: 12000 })
  assert.equal(await page.locator('.pu-counts').innerText(), '0 обновлено\n1 ждут 1С')
  await page.locator('.pu-advanced > summary').click()
  await page.getByRole('button', { name: '02 Допуск к обмену', exact: true }).click()
  assert.equal(await page.locator('.pa-scope [role=alert]').count(), 0, 'busy workflow does not mean TEST is disabled')
  assert(await page.getByLabel('Найти товар для TEST').isDisabled())
  await page.locator('.pu-advanced > summary').click()
  operation = { ...operation, state: 'COMPLETED', pending: 0, applied: 1, finishedAt: new Date().toISOString(),
    items: operation.items.map(item => ({ ...item, status: 'APPLIED' })) }
  await page.getByText('Обновление завершено', { exact: true }).waitFor({ timeout: 12000 })
  await page.locator('.pu-results summary').first().click()
  await page.getByText('Обновлено', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Все готовые', exact: true }).click()
  await page.getByRole('button', { name: 'Обновить готовые (2)', exact: true }).click()
  await page.getByText('Подготавливаем передачу в 1С', { exact: true }).waitFor()
  assert.deepEqual(startBodies[1], { productIds: [products[0].id, products[2].id] }, 'all-ready action must send only permitted ready IDs')
  await page.getByRole('button', { name: 'Остановить подготовку', exact: true }).click()
  await page.getByText('Оставшиеся товары остановлены', { exact: true }).waitFor()
  await page.locator('.pu-results summary').first().click()
  await page.evaluate(() => window.scrollTo(0, 0))
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace('.png', '-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert(await page.locator('.pu-root').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'price UI overflows on mobile')
  assert.deepEqual(errors, [])
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true })
  // New-product setup is reachable from the overview; no matching requests until the links step.
  await page.getByRole('button', { name: 'Разделы', exact: true }).click()
  assert(await page.getByRole('button', { name: 'Выйти из аккаунта', exact: true }).isVisible(), 'logout remains accessible on mobile')
  await page.getByRole('button', { name: 'Главная', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Разделы', exact: true }).getAttribute('aria-expanded'), 'false')
  await page.getByRole('button', { name: /Новые товары/ }).click()
  await page.getByRole('region', { name: 'Добавление товаров из 1С' }).waitFor()
  assert.equal(hiddenToolRequests, 0)
  assert(await page.getByText('Агент цен получает задания, а каталог отправляется отдельной выгрузкой.', { exact: false }).count() > 0)
  assert(await page.locator('.admin-control').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'admin shell overflows on mobile')
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace('.png', '-setup-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Я выгрузил — обновить каталог' }).click()
  await page.getByRole('region', { name: 'Допуск товаров к обмену' }).waitFor()
  assert.equal(hiddenToolRequests, 0)
  assert(await page.getByRole('button', { name: 'Разрешить обмен (0)', exact: true }).isDisabled())
  await page.getByLabel('Найти товар для TEST').fill('Baseus')
  await page.locator('.pa-scope-list input[type=checkbox]').check()
  await page.getByRole('button', { name: 'Разрешить обмен (1)', exact: true }).click()
  await page.getByText('Добавлено: 1. Можно перейти к карточкам 05.ru.', { exact: true }).waitFor()
  assert.equal((await prisma.product.findUnique({ where: { id: unapproved.id } })).priceSyncEnabled, true)
  assert.equal(dialogs, 0, 'explicit scope action does not need an additional dialog')
  await prisma.product.create({ data: { categoryId: accessories.id, brand: 'Hoco', name: 'Кабель Hoco X90',
    sku: 'NEW-UNAPPROVED', slug: 'new-unapproved', oneCId: randomUUID(), price: 900, stockQty: 1 } })
  const matchBodies = []
  await context.route('**/api/admin/price-monitor/auto-find-1c', route => {
    matchBodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { queued: 1 } })
  })
  const linksLoaded = page.waitForRequest(r => r.url().endsWith('/price-monitor/jobs'))
  await page.getByRole('button', { name: 'Далее: карточки 05.ru' }).click()
  await page.locator('.mp-shell').waitFor()
  await linksLoaded
  assert(hiddenToolRequests > 0)
  await page.waitForFunction(() => document.querySelector('.mp-top-count b')?.textContent === '4')
  assert.equal(await page.getByRole('button', { name: 'Для обмена', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: 'Найти карточки товаров на 05.ru', exact: true }).click()
  await page.getByText('05.ru: быстрый поиск без полного обхода каталога. Запущено проверок: 1.', { exact: true }).waitFor()
  assert.equal(matchBodies[0].onlyAllowed, true)
  assert.equal(matchBodies[0].indexCatalog, false)
  await page.getByRole('button', { name: 'Весь каталог', exact: true }).click()
  assert.equal(await page.locator('.mp-top-count b').innerText(), '5')
  assert.equal(matchBodies.length, 1, 'changing the search scope does not launch matching')
  assert(await page.locator('.admin-control').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'matching tools overflow on mobile')
  await page.getByRole('button', { name: 'Готово — к обновлению цен' }).click()
  assert.equal(await page.locator('.pu-advanced .mp-shell').count(), 0)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Главная', exact: true }).click()
  await page.getByRole('button', { name: /Новые товары/ }).click()
  await page.evaluate(() => window.scrollTo(0, 0))
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace('.png', '-setup-desktop.png'), fullPage: true })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const name of ['Товары', 'Заказы', 'Сообщения', 'Оформление', 'Обмен с 1С']) {
      if (width === 390) await page.getByRole('button', { name: 'Разделы', exact: true }).click()
      await page.getByRole('button', { name, exact: true }).click()
      assert(await page.locator('.admin-control').evaluate(el => el.scrollWidth <= el.clientWidth + 1), name + ' overflows at ' + width)
      if (process.env.SCREENSHOT_PATH && name === 'Товары') {
        await page.evaluate(() => window.scrollTo(0, 0))
        await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace('.png', '-catalog-' + width + '.png'), fullPage: true })
      }
    }
  }
  // A check can fail before the first five-second poll; its result must remain visible.
  let priceCheck = null, checkStarts = 0
  await context.route('**/api/admin/price-monitor/price-readiness', async route => {
    const response = await route.fetch()
    const body = await response.json()
    if (priceCheck?.status === 'COMPLETED') {
      body.items = body.items.map(item => item.productId !== products[0].id ? item : {
        ...item, status: 'BLOCKED', newPrice: checkStarts === 3 ? item.oldPrice : item.newPrice,
        reason: checkStarts === 3 ? 'Предлагаемая цена уже совпадает с текущей ценой TEXHORU'
          : 'Последняя проверка завершилась ошибкой: Цена на странице не найдена; Цена 05.ru устарела: нужна успешная проверка не старше 24 часов',
      })
    }
    await route.fulfill({ json: { ...body, checking: !!priceCheck && ['QUEUED', 'RUNNING'].includes(priceCheck.status), priceCheck } })
  })
  await context.route('**/api/admin/price-monitor/check-allowed-prices', route => {
    checkStarts++
    priceCheck = { id: randomUUID(), status: [2, 4].includes(checkStarts) ? 'RUNNING' : checkStarts === 3 ? 'COMPLETED' : 'FAILED',
      perPage: 2, processed: checkStarts === 3 ? 2 : 0, errors: 0,
      createdAt: new Date().toISOString(), finishedAt: [2, 4].includes(checkStarts) ? null : new Date().toISOString(),
      lastError: checkStarts === 1 ? 'https://05.ru/cat/test/p/0/: сайт ограничил запросы, задача остановлена (HTTP 403)' : null }
    return route.fulfill({ json: { queued: 2 } })
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Цены', exact: true }).click()
  await page.getByRole('button', { name: 'Проверить цены разрешённых', exact: true }).click()
  const checkPanel = page.getByRole('region', { name: 'Результат проверки цен 05.ru', exact: true })
  await checkPanel.getByText('Проверка цен остановлена', { exact: true }).waitFor()
  await checkPanel.getByText('05.ru ограничил доступ к карточкам (HTTP 403).', { exact: true }).waitFor()
  assert(await page.getByRole('button', { name: 'Проверить цены разрешённых', exact: true }).isEnabled())
  assert.equal(await page.locator('.pu-advanced .mp-shell').count(), 0, 'failure must be visible without opening technical tools')
  await page.reload()
  await page.getByRole('button', { name: 'Цены', exact: true }).click()
  await checkPanel.getByText('Проверка цен остановлена', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Проверить цены разрешённых', exact: true }).click()
  await checkPanel.getByText('Проверяем цены 05.ru', { exact: true }).waitFor()
  assert(await page.getByRole('button', { name: 'Проверяем цены…', exact: true }).isDisabled())
  priceCheck = { ...priceCheck, status: 'COMPLETED', processed: 2, errors: 1,
    lastError: 'https://05.ru/cat/test/p/0/: Цена на странице не найдена', finishedAt: new Date().toISOString() }
  await checkPanel.getByText('Проверка завершена с замечаниями', { exact: true }).waitFor({ timeout: 12000 })
  await page.getByRole('button', { name: /Нельзя обновить/ }).click()
  await page.getByText('Ошибка проверки 05.ru', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Проверить цены разрешённых', exact: true }).click()
  await checkPanel.getByText('Цены 05.ru проверены', { exact: true }).waitFor()
  assert.match(await checkPanel.innerText(), /Цена уже актуальна: 1/)
  await page.getByRole('button', { name: 'Проверить цены разрешённых', exact: true }).click()
  priceCheck = { ...priceCheck, status: 'COMPLETED', processed: 2, errors: 2,
    lastError: 'Не удалось проверить 05.ru: Не найден браузер для фонового парсера 05.ru. На Windows установи Microsoft Edge и перезапусти TEXHORU.',
    finishedAt: new Date().toISOString() }
  await checkPanel.getByText('Не удалось запустить браузер проверки на сервере.', { exact: true }).waitFor({ timeout: 20000 })
  await page.setViewportSize({ width: 390, height: 844 })
  assert(await page.locator('.pu-root').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'check result overflows on mobile')
  if (process.env.SCREENSHOT_PATH) {
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace('.png', '-check-result.png'), fullPage: true })
  }
  assert.deepEqual(errors, [])
  console.log('PASS: readiness groups, permitted-only updates, receipt-only success, product setup, visible fast recheck failure/reload, progress, per-card errors and unchanged prices. Workflow and recheck transitions are mocked; persistence is tested in backend suite.')

} finally {
  await browser?.close()
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') }
  await prisma?.$disconnect()
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(db + suffix, { force: true })
}
