import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'

const requireServer = createRequire(resolve('server/package.json'))
const { PrismaClient } = requireServer('@prisma/client')
const { chromium } = requireServer('playwright')
const bcrypt = requireServer('bcryptjs')
const database = resolve('server/prisma/monitor-test-promo-browser-' + randomUUID() + '.db')
const databaseUrl = 'file:' + database.replace(/\\/g, '/')
let prisma, server, browser

try {
  writeFileSync(database, '')
  const push = spawnSync(process.execPath, [requireServer.resolve('prisma/build/index.js'), 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], {
    cwd: resolve('server'), env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8',
  })
  assert.equal(push.status, 0, push.stdout + push.stderr)
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  const email = 'promo@test.local', password = 'Independent-promos-2026'
  await prisma.user.create({ data: { email, name: 'Director', role: 'DIRECTOR', passwordHash: await bcrypt.hash(password, 4) } })
  const image = (color) => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="600"><rect width="1600" height="600" fill="${color}"/></svg>`).toString('base64')
  const first = await prisma.promoBanner.create({ data: { blockId: 'promo-a', kicker: 'A', title: 'Фото только блока A', body: '', ctaLabel: '', category: 'Все', image: image('#d42b48') } })
  const second = await prisma.promoBanner.create({ data: { blockId: 'promo-b', kicker: 'B', title: 'Фото только блока B', body: '', ctaLabel: '', category: 'Все', image: image('#245dd8') } })
  const layout = { version: 1, blocks: [
    { id: 'promo-a', type: 'promo', width: 12, visible: true, title: 'Реклама A' },
    { id: 'promo-b', type: 'promo', width: 12, visible: true, title: 'Реклама B' },
  ] }
  await prisma.storefrontLayout.create({ data: { id: 'home', draft: layout, published: layout, publishedAt: new Date() } })

  const socket = net.createServer()
  await new Promise(done => socket.listen(0, '127.0.0.1', done))
  const port = socket.address().port
  await new Promise(done => socket.close(done))
  const url = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, ['dist/main.js'], { cwd: resolve('server'), env: { ...process.env, DATABASE_URL: databaseUrl, JWT_SECRET: randomUUID(), ONE_C_API_KEY: randomUUID(), NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), FRONTEND_ORIGIN: url, FRONTEND_PUBLIC_URL: url, TEXHORU_ENV_FILE: 'tests/nonexistent.env', MONITOR_WORKER_DISABLED: 'true', SERVE_STOREFRONT: 'true', MEDIA_STORAGE_DRIVER: 'local' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; server.stdout.on('data', data => { log += data }); server.stderr.on('data', data => { log += data })
  let ready = false
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url + '/api/health')).ok) { ready = true; break } } catch {} await new Promise(done => setTimeout(done, 100)) }
  assert(ready, log.slice(-2000))

  browser = await chromium.launch({ headless: true, ...(existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}) })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' })
  await page.goto(url + '/admin')
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('button', { name: /Оформление/ }).click()
  await page.locator('.page-builder').waitFor()

  const blocks = page.locator('.page-builder__block')
  assert.equal(await blocks.count(), 2)
  await blocks.nth(0).getByRole('button', { name: 'Редактировать баннер' }).click()
  const manager = page.getByRole('dialog', { name: 'Фотографии блока Реклама A' })
  await manager.waitFor()
  assert.equal(await manager.getByText('Фото только блока A', { exact: true }).count(), 1)
  assert.equal(await manager.getByText('Фото только блока B', { exact: true }).count(), 0)
  page.once('dialog', dialog => dialog.accept())
  await manager.getByRole('button', { name: 'Удалить', exact: true }).click()
  await manager.getByText('В этом блоке ещё нет фото', { exact: true }).waitFor()

  assert.equal(await prisma.promoBanner.findUnique({ where: { id: first.id } }), null)
  assert.equal((await prisma.promoBanner.findUnique({ where: { id: second.id } })).blockId, 'promo-b')

  await manager.getByRole('button', { name: 'Добавить первое фото' }).click()
  const editor = page.locator('.promo-editor')
  await editor.waitFor()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZK5sAAAAASUVORK5CYII=', 'base64')
  await editor.locator('input[type="file"]').first().setInputFiles({ name: 'promo-a.png', mimeType: 'image/png', buffer: png })
  await editor.locator('input[placeholder="Например: Осенняя акция"]').fill('Новое фото блока A')
  await editor.getByRole('button', { name: 'Сохранить слайд' }).click()
  await editor.waitFor({ state: 'detached' })
  await manager.getByText('Новое фото блока A', { exact: true }).waitFor()
  const created = await prisma.promoBanner.findFirst({ where: { title: 'Новое фото блока A' } })
  assert.equal(created.blockId, 'promo-a')

  await manager.getByRole('button', { name: 'Закрыть' }).click()
  await blocks.nth(1).getByRole('button', { name: 'Редактировать баннер' }).click()
  const secondManager = page.getByRole('dialog', { name: 'Фотографии блока Реклама B' })
  assert.equal(await secondManager.getByText('Фото только блока B', { exact: true }).count(), 1)
  console.log('PASS: promo blocks keep independent photo sets and deleting from one block leaves the other untouched.')
} finally {
  if (browser) await browser.close()
  if (server) { server.kill(); await new Promise(done => setTimeout(done, 100)) }
  if (prisma) await prisma.$disconnect()
  rmSync(database, { force: true })
}
