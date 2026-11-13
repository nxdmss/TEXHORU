import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'

const require = createRequire(resolve('server/package.json'))
const { PrismaClient } = require('@prisma/client'), { chromium } = require('playwright'), bcrypt = require('bcryptjs')
const file = resolve('server/prisma/monitor-test-remote-browser-' + randomUUID() + '.db')
const dbUrl = 'file:' + file.replace(/\\/g, '/')
let prisma, child, browser
try {
  writeFileSync(file, '')
  const push = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], { cwd: resolve('server'), env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' })
  assert.equal(push.status, 0, push.stdout + push.stderr)
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  const baseId = randomUUID(), key = randomUUID(), agentId = randomUUID(), password = randomUUID(), groupId = randomUUID(), subId = randomUUID()
  await prisma.user.create({ data: { email: 'remote-browser@test.local', passwordHash: await bcrypt.hash(password, 4), name: 'Test', role: 'DIRECTOR' } })
  await prisma.oneCCatalogAgent.create({ data: { baseId, agentId, state: 'idle', groupsUpdatedAt: new Date(), nomenclatureUpdatedAt: new Date() } })
  for (let i = 0; i < 105; i++) await prisma.oneCRemoteGroup.create({ data: { baseId, oneCId: i === 0 ? groupId : randomUUID(), parentId: '', name: i === 0 ? 'ТЕЛЕФОНЫ И ГАДЖЕТЫ' : 'Я группа ' + String(i).padStart(3, '0'), searchName: i === 0 ? 'телефоны и гаджеты' : 'я группа ' + String(i).padStart(3, '0'), itemCount: i === 0 ? 125 : i, generation: randomUUID() } })
  await prisma.oneCRemoteGroup.create({ data: { baseId, oneCId: subId, parentId: groupId, name: 'Apple', searchName: 'apple', itemCount: 125, generation: randomUUID() } })
  for (let i = 0; i < 125; i++) {
    await prisma.oneCNomenclatureItem.create({ data: {
      baseId, oneCId: randomUUID(), parentId: subId, code: String(46151 + i).padStart(11, '0'), article: 'MYE' + String(i).padStart(3, '0') + 'RU/A',
      name: 'Apple iPhone 16 ' + i, fullName: 'Смартфон Apple iPhone 16 128GB номер ' + i, itemKind: 'Товар', unitName: 'шт',
      retailPrice: 80000 + i, purchasePrice: 70000 + i, stockQty: i, generation: 'seed', searchText: ('apple iphone 16 mye' + String(i).padStart(3, '0') + 'ru/a').toLowerCase(),
    } })
  }
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r))
  child = spawn(process.execPath, ['dist/main.js'], { cwd: resolve('server'), env: { ...process.env, DATABASE_URL: dbUrl, JWT_SECRET: randomUUID(), ONE_C_API_KEY: key, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', FRONTEND_ORIGIN: 'http://127.0.0.1:' + port, TEXHORU_ENV_FILE: 'tests/nonexistent.env', MONITOR_WORKER_DISABLED: 'true', SERVE_STOREFRONT: 'true', ONE_C_BASE_KIND: 'PRODUCTION', ONE_C_PRODUCTION_BASE_ID: baseId, ONE_C_PRODUCTION_PRICE_SYNC_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', d => { log += d }); child.stderr.on('data', d => { log += d })
  const url = 'http://127.0.0.1:' + port
  let ready = false
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/health')).ok) { ready = true; break } } catch {} await new Promise(r => setTimeout(r, 100)) }
  assert(ready, log.slice(-2000))
  browser = await chromium.launch({ headless: true, ...(existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  assert((await context.request.post(url + '/api/auth/login', { data: { email: 'remote-browser@test.local', password } })).ok())
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url + '/admin')
  await page.getByRole('button', { name: 'Номенклатура 1С', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Номенклатура основной базы 1С' })
  await panel.getByText('Онлайн-связь с агентом 1С', { exact: true }).waitFor()
  await panel.getByText('125 позиций из 1С', { exact: true }).waitFor()
  await panel.locator('.onec-tree').getByRole('button', { name: 'ТЕЛЕФОНЫ И ГАДЖЕТЫ', exact: true }).click()
  const appleGroupRow = panel.locator('.onec-table__row.is-group', { hasText: 'Apple' })
  await appleGroupRow.waitFor()
  await appleGroupRow.click()
  await panel.getByText('Apple iPhone 16 0', { exact: true }).waitFor()
  for (const heading of ['Код', 'Артикул', 'Наименование', 'Вид / единица', 'Розничная / закупочная', 'Остаток', 'Статус']) await panel.getByText(heading, { exact: true }).waitFor()
  assert.equal(await panel.locator('.onec-table__row.is-item').count(), 100)
  await panel.getByRole('button', { name: 'Далее →', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.onec-table__row.is-item').length === 25)
  await panel.getByRole('textbox', { name: 'Поиск по номенклатуре' }).fill('MYE024')
  await panel.getByText('Apple iPhone 16 24', { exact: true }).waitFor()
  assert.equal(await panel.locator('.onec-table__row.is-item').count(), 1)
  await panel.getByRole('checkbox', { name: 'Выбрать Apple iPhone 16 24', exact: true }).check()
  await panel.getByRole('button', { name: 'Загрузить 1', exact: true }).click()
  await panel.getByText(/Загрузка выбранных товаров: 1: В очереди/).waitFor()
  await panel.getByText('Очередь и диагностика', { exact: false }).click()
  await panel.getByRole('button', { name: 'Отменить', exact: true }).click()
  await panel.getByRole('button', { name: 'Только в наличии', exact: true }).click()
  await panel.getByText(/Загрузка группы: Apple · в наличии: В очереди/).waitFor()
  await panel.getByRole('button', { name: 'Отменить', exact: true }).click()
  await panel.getByRole('button', { name: 'Все товары', exact: true }).click()
  await panel.getByText(/Загрузка группы: Apple: В очереди/).waitFor()
  await panel.getByRole('button', { name: 'Отменить', exact: true }).click()
  page.once('dialog', dialog => dialog.accept())
  await panel.getByRole('button', { name: 'Исключить', exact: true }).click()
  await panel.getByText(/Группа «Apple» исключена\. Удалено из зеркала: 125/).waitFor()
  assert.equal(await prisma.oneCNomenclatureItem.count(), 0)
  await panel.getByText('Исключённые группы', { exact: false }).click()
  await panel.getByText('Не загружается из 1С', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Вернуть', exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Обновить', exact: true }).click()
  await panel.getByText(/Обновление списка товаров: В очереди/).waitFor()
  await panel.getByRole('button', { name: 'Пауза', exact: true }).click()
  await panel.getByText(/Обновление списка товаров: На паузе/).waitFor()
  await page.reload(); await page.getByRole('button', { name: 'Номенклатура 1С', exact: true }).click()
  await panel.getByText(/Обновление списка товаров: На паузе/).waitFor()
  mkdirSync(resolve('artifacts/remote-catalog'), { recursive: true })
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'panel overflow ' + width)
    await panel.screenshot({ path: resolve('artifacts/remote-catalog/panel-' + width + '.png') })
  }
  assert.deepEqual(errors, [])
  console.log('PASS: lightweight 1C picker, selected and whole-group imports, exclusions, pagination, search, queue controls and responsive layout.')
} catch (error) {
  console.error(error)
  if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) console.error((await page.locator('body').innerText()).slice(-5000)) }
  process.exitCode = 1
} finally {
  await browser?.close()
  if (child) { child.kill(); await new Promise(resolveExit => child.exitCode !== null ? resolveExit() : child.once('exit', resolveExit)) }
  await prisma?.$disconnect()
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true })
}
