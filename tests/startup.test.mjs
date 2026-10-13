import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { backupData, cacheBase, copyApplication, databasePath, prepareRuntime, sourceFingerprint } from '../scripts/runtime-preparation.mjs'
import { session, stopSession } from '../scripts/session-control.mjs'

const original = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = process.env.TEXHORU_TEST_TEMP || join(original, '.texhoru', 'tests')
mkdirSync(scratch, { recursive: true })
const require = createRequire(import.meta.url)
const { PrismaClient } = require('../server/node_modules/@prisma/client')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function fixture() {
  const temp = mkdtempSync(join(scratch, 'startup-'))
  const root = join(temp, 'OneDrive', 'Desktop', 'TEXHORU with spaces')
  copyApplication(original, root)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const name of ['runtime-preparation.mjs', 'auto-start.mjs', 'auto-stop.mjs', 'session-control.mjs']) cpSync(join(original, 'scripts', name), join(root, 'scripts', name))
  mkdirSync(join(root, '.texhoru'), { recursive: true })
  return { temp, root }
}

test('Runtime clone excludes old dependencies, secrets, uploads and the database; fingerprint ignores data changes', () => {
  const { temp, root } = fixture()
  try {
    mkdirSync(join(root, 'server', 'node_modules', 'react-native', 'React'), { recursive: true })
    writeFileSync(join(root, 'server', 'node_modules', 'react-native', 'React', 'busy.marker'), 'keep old dependencies')
    writeFileSync(join(root, 'server', '.env.local'), 'SECRET=private\n')
    writeFileSync(join(root, 'server', 'prisma', 'dev-local.db'), 'database')
    mkdirSync(join(root, 'server', 'uploads'), { recursive: true }); writeFileSync(join(root, 'server', 'uploads', 'image.png'), 'image')
    const before = sourceFingerprint(root)
    const clone = join(temp, 'outside-cloud-cache'); copyApplication(root, clone)
    assert(!existsSync(join(clone, 'server', 'node_modules')))
    assert(!existsSync(join(clone, 'server', '.env.local')))
    assert(!existsSync(join(clone, 'server', 'prisma', 'dev-local.db')))
    assert(!existsSync(join(clone, 'server', 'uploads')))
    writeFileSync(join(root, 'server', 'prisma', 'dev-local.db'), 'updated data')
    assert.equal(sourceFingerprint(root), before)
    assert.equal(databasePath(root, 'file:./dev-local.db'), join(root, 'server', 'prisma', 'dev-local.db'))
    assert.throws(() => databasePath(root, 'postgresql://localhost/database'))
    const backup = backupData(root, join(root, 'server', 'prisma', 'dev-local.db'), 'test')
    assert.equal(readFileSync(join(backup, 'database.db'), 'utf8'), 'updated data')
    assert.equal(readFileSync(join(backup, 'uploads', 'image.png'), 'utf8'), 'image')
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('Cold prepare, warm reuse, live site, media from original folder and authenticated stop preserve existing data', async () => {
  const { temp, root } = fixture()
  let child
  const oldCache = process.env.TEXHORU_CACHE_DIR
  const oldDatabase = process.env.DATABASE_URL
  const oldEnv = { ...process.env }
  try {
    process.env.TEXHORU_CACHE_DIR = join(temp, 'local-cache')
    delete process.env.DATABASE_URL
    cpSync(join(original, 'server', '.env.example'), join(root, 'server', '.env.local'))
    const marker = join(root, 'server', 'node_modules', 'react-native', 'React', 'busy.marker')
    mkdirSync(dirname(marker), { recursive: true }); writeFileSync(marker, 'must remain untouched')
    // Representative existing SQLite database, with an already-created admin.
    const db = join(root, 'server', 'prisma', 'dev-local.db'); writeFileSync(db, '')
    const cli = join(original, 'server', 'node_modules', 'prisma', 'build', 'index.js')
    const setup = spawnSync(process.execPath, [cli, 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], { cwd: join(original, 'server'), env: { ...process.env, DATABASE_URL: `file:${db}` }, encoding: 'utf8' })
    assert.equal(setup.status, 0, setup.stdout + setup.stderr)
    const prisma = new PrismaClient({ datasources: { db: { url: `file:${db}` } } })
    const category = await prisma.category.create({ data: { name: 'Keep', slug: 'keep' } })
    await prisma.product.create({ data: { sku: 'STARTUP-KEEP', slug: 'keep', name: 'Keep product', brand: 'Apple', price: 4321, stockQty: 7, reservedQty: 2, categoryId: category.id } })
    await prisma.user.create({ data: { email: 'existing@test.local', name: 'Existing', role: 'ADMIN', passwordHash: 'do-not-reset' } })
    await prisma.$disconnect()
    const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    mkdirSync(join(root, 'server', 'uploads', 'products'), { recursive: true }); writeFileSync(join(root, 'server', 'uploads', 'products', 'keep.png'), picture)
    const log = join(root, '.texhoru', 'startup.log'); writeFileSync(log, '')
    const first = await prepareRuntime(root, log, message => console.log(message))
    assert(first.runtime.startsWith(cacheBase(root)))
    assert(!first.runtime.includes('OneDrive'))
    assert.equal(readFileSync(marker, 'utf8'), 'must remain untouched')
    assert.equal(first.env.TEXHORU_UPLOADS_DIR, join(root, 'server', 'uploads'))
    const second = await prepareRuntime(root, log, () => {})
    assert.equal(second.runtime, first.runtime)
    assert.equal(readdirSync(join(root, 'backups')).length, 1)
    child = spawn(process.execPath, [join(root, 'scripts', 'auto-start.mjs')], { cwd: root, env: { ...process.env, TEXHORU_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    let active
    for (let n = 0; n < 120; n++) { active = await session(root); if (active?.status.ready) break; if (child.exitCode !== null) break; await sleep(250) }
    assert(active?.status.ready, output + '\n' + readFileSync(log, 'utf8').slice(-1800))
    assert.equal((await fetch('http://127.0.0.1:5173/')).status, 200)
    const image = await fetch('http://127.0.0.1:3000/api/uploads/products/keep.png')
    assert.equal(image.status, 200)
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), picture)
    const unauthorized = await fetch(`http://127.0.0.1:${active.port}/texhoru/stop`, { method: 'POST' })
    assert.equal(unauthorized.status, 401)
    const duplicate = spawnSync(process.execPath, [join(root, 'scripts', 'auto-start.mjs')], { cwd: root, env: { ...process.env, TEXHORU_NO_BROWSER: '1' }, encoding: 'utf8' })
    assert.equal(duplicate.status, 0, duplicate.stderr)
    assert.match(duplicate.stdout, /уже запущен/)
    assert(await stopSession(root))
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    assert.equal(await session(root), null)
    const inspect = new PrismaClient({ datasources: { db: { url: `file:${db}` } } })
    const product = await inspect.product.findUnique({ where: { sku: 'STARTUP-KEEP' } })
    assert.equal(product.price, 4321); assert.equal(product.stockQty, 7); assert.equal(product.reservedQty, 2)
    assert.equal((await inspect.user.findUnique({ where: { email: 'existing@test.local' } })).passwordHash, 'do-not-reset')
    await inspect.$disconnect()
  } finally {
    await stopSession(root).catch(() => false)
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGTERM')
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
    Object.assign(process.env, oldEnv)
    if (oldCache === undefined) delete process.env.TEXHORU_CACHE_DIR; else process.env.TEXHORU_CACHE_DIR = oldCache
    if (oldDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldDatabase
    rmSync(temp, { recursive: true, force: true })
  }
})
