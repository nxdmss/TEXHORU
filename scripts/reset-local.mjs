// Offline-only clean installation preparation. Never reset a running app.
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backupData, databasePath } from './runtime-preparation.mjs'
import { session } from './session-control.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = join(root, '.texhoru')
const envPath = join(root, 'server', '.env.local')
const uploads = join(root, 'server', 'uploads')
const confirmation = process.argv.at(-1)
const active = process.argv.includes('--confirm') && confirmation === 'RESET-TEXHORU'

function guardLocked() {
  const lock = join(state, 'startup.lock')
  if (!existsSync(lock)) return
  try {
    const pid = JSON.parse(readFileSync(lock, 'utf8')).pid
    if (!Number.isInteger(pid) || pid < 1) return
    process.kill(pid, 0)
    throw Error('TEXHORU ещё запускается. Сначала закрой TEXHORU.exe или TEXHORU STOP.exe.')
  } catch (error) {
    if (error?.code === 'ESRCH') return
    if (error?.code === 'EPERM') throw Error('TEXHORU может ещё работать. Закрой приложение перед сбросом.')
    if (error?.message?.includes('ещё запускается')) throw error
  }
}

async function main() {
  if (!active) {
    console.log('Чистая установка TEXHORU (локальная тестовая база).')
    console.log('Сначала закрой TEXHORU.exe и TEXHORU STOP.exe.')
    console.log('Для подтверждения: npm run reset:local -- --confirm RESET-TEXHORU')
    console.log('Сброс сохраняет резервную копию базы, настроек и фотографий.')
    return
  }
  if (process.env.NODE_ENV === 'production') throw Error('Сброс недоступен в режиме production.')
  guardLocked()
  if (await session(root)) throw Error('TEXHORU работает. Закрой его перед сбросом.')
  // Fail closed when a different/older process still serves the local backend.
  try {
    const response = await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(800) })
    if (response.ok) throw Error('На порту 3000 работает сервер. Сначала останови TEXHORU.')
  } catch (error) {
    if (error?.message?.includes('порту 3000')) throw error
  }

  if (existsSync(envPath)) process.loadEnvFile(envPath)
  const db = databasePath(root, process.env.DATABASE_URL)
  const allowed = resolve(root, 'server', 'prisma') + sep
  if (!db.startsWith(allowed) || !db.endsWith('.db')) {
    throw Error('Безопасный сброс разрешён только для локальной SQLite-базы в server/prisma/*.db.')
  }
  const databaseFiles = [db, db + '-wal', db + '-shm', db + '-journal']
  const stamp = 'clean-reset-' + new Date().toISOString().replace(/[:.]/g, '-')
  const archive = backupData(root, db, stamp)
  for (const file of databaseFiles) {
    if (existsSync(file) && statSync(file).size > 0 && !existsSync(join(archive, 'database.db' + file.slice(db.length)))) {
      throw Error('Резервная копия базы не создана: ' + file + '. Сброс отменён.')
    }
  }
  for (const file of databaseFiles) if (existsSync(file)) unlinkSync(file)
  if (existsSync(uploads)) rmSync(uploads, { recursive: true, force: true })
  mkdirSync(join(uploads, 'products'), { recursive: true })
  mkdirSync(join(uploads, 'promos'), { recursive: true })
  const prepared = join(state, 'database-prepared.json')
  if (existsSync(prepared)) unlinkSync(prepared)
  console.log('Готово. Локальные данные очищены. Резервная копия: ' + archive)
  console.log('Запусти TEXHORU.exe: он создаст пустую базу. После этого импортируй реальные группы и товары из 1С.')
}

main().catch(error => { console.error('Сброс отменён:', error.message); process.exitCode = 1 })
