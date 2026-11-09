// One-time transfer, never a scheduled backup. Run after stopping the old site.
import { existsSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fileSha256 } from '../deploy/cloud/data-files.mjs'
import { DatabaseSync, backup } from 'node:sqlite'
import { databasePath } from './runtime-preparation.mjs'
import { session } from './session-control.mjs'

export async function exportCloudData(root) {
  if (await session(root)) throw Error('Сначала останови TEXHORU-STOP-WINDOWS.cmd')
  const serving = await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false)
  if (serving) throw Error('На порту 3000 работает сервер. Останови его перед переносом.')
  process.loadEnvFile(join(root, 'server', '.env.local'))
  const file = databasePath(root, process.env.DATABASE_URL)
  if (!file.startsWith(resolve(root, 'server', 'prisma') + sep) || !existsSync(file)) throw Error('Не найдена локальная SQLite-база проекта')
  const destination = join(root, '.texhoru', 'cloud-transfer')
  if (existsSync(destination)) throw Error('Папка .texhoru/cloud-transfer уже существует; она не будет перезаписана')
  const source = new DatabaseSync(file, { readOnly: true })
  let created = false
  try {
    if (source.prepare("SELECT COUNT(*) n FROM OneCPriceChange WHERE status = 'PENDING'").get().n) throw Error('Сначала заверши очередь передачи цен в 1С')
    if (source.prepare("SELECT COUNT(*) n FROM MonitorJob WHERE status IN ('QUEUED','RUNNING','CHECKING','QUEUING','WAITING')").get().n) throw Error('Сначала заверши или останови проверки цен на старом сайте')
    mkdirSync(destination, { recursive: true, mode: 0o700 }); created = true
    await backup(source, join(destination, 'database.db'))
    // Make the transfer self-contained and readable from a read-only mount.
    const exported = new DatabaseSync(join(destination, 'database.db'))
    try { exported.exec('PRAGMA journal_mode=DELETE') } finally { exported.close() }
    if (existsSync(join(root, 'server', 'uploads'))) cpSync(join(root, 'server', 'uploads'), join(destination, 'uploads'), { recursive: true })
    else mkdirSync(join(destination, 'uploads'))
    const sha256 = fileSha256(join(destination, 'database.db'))
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), sha256 }), { mode: 0o600 })
    return destination
  } catch (error) {
    if (created) rmSync(destination, { recursive: true, force: true })
    throw error
  } finally { source.close() }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  exportCloudData(root).then(path => console.log('Папка для переноса через SSH:', path))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
