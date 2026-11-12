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
  await prisma.oneCCatalogAgent.create({ data: { baseId, agentId, state: 'idle', groupsUpdatedAt: new Date() } })
  for (let i = 0; i < 105; i++) await prisma.oneCRemoteGroup.create({ data: { baseId, oneCId: i === 0 ? groupId : randomUUID(), parentId: '', name: i === 0 ? 'Телефоны' : 'Я группа ' + String(i).padStart(3, '0'), searchName: i === 0 ? 'телефоны' : 'я группа ' + String(i).padStart(3, '0'), itemCount: i * 100, generation: randomUUID() } })
  await prisma.oneCRemoteGroup.create({ data: { baseId, oneCId: subId, parentId: groupId, name: 'Apple', searchName: 'apple', itemCount: 8500, generation: randomUUID() } })
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
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(url + '/admin')
  await page.getByRole('button', { name: 'Обмен с 1С', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Каталог основной базы 1С' })
  await panel.getByText('Агент на связи', { exact: true }).waitFor()
  await panel.getByRole('button', { name: /Телефоны/ }).click()
  await panel.getByRole('button', { name: /Apple/ }).waitFor()
  await panel.getByRole('checkbox', { name: 'Выбрать Apple' }).check()
  await panel.getByRole('button', { name: 'Загрузить выбранные (1)' }).click()
  await panel.getByText('В очереди', { exact: true }).waitFor()
  const job = await prisma.oneCCatalogJob.findFirstOrThrow({ where: { kind: 'CATALOG' } })
  assert.equal(job.groupId, subId)
  await panel.getByRole('button', { name: 'Пауза', exact: true }).click()
  await panel.getByText('На паузе', { exact: true }).waitFor()
  await page.reload(); await page.getByRole('button', { name: 'Обмен с 1С', exact: true }).click()
  await panel.getByRole('button', { name: 'Продолжить', exact: true }).click()
  await panel.getByText('В очереди', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Отменить', exact: true }).click()
  await panel.getByText('Отменено', { exact: true }).waitFor()
  await panel.getByRole('textbox', { name: 'Поиск группы в 1С' }).fill('Apple')
  await panel.getByRole('button', { name: /Apple.*товаров/ }).waitFor()
  assert.equal(await panel.locator('.remote-catalog__group').count(), 1)
  await panel.getByRole('textbox', { name: 'Поиск группы в 1С' }).fill('')
  await panel.getByRole('button', { name: 'Далее', exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Далее', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.remote-catalog__group').length === 5)
  await panel.getByRole('button', { name: 'Обновить группы', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.remote-catalog__jobs')?.textContent.includes('Обновление групп'))
  mkdirSync(resolve('artifacts/remote-catalog'), { recursive: true })
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    assert(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'panel overflow ' + width)
    await panel.screenshot({ path: resolve('artifacts/remote-catalog/panel-' + width + '.png') })
  }
  assert.deepEqual(errors, [])
  console.log('PASS: real staff login, main-base groups, nesting, search, pagination, enqueue selected, pause/reload/resume/cancel, refresh groups and responsive layout.')
} catch (e) { console.error(e); if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) console.error((await page.locator('body').innerText()).slice(-4000)) }; process.exitCode = 1 }
finally { await browser?.close(); if (child) { child.kill(); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r)) }; await prisma?.$disconnect(); for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true }) }
