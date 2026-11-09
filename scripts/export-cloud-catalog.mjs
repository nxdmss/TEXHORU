// Explicit one-time catalog transfer. Does not change the old site's database.
import { existsSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { databasePath } from './runtime-preparation.mjs'
import { session } from './session-control.mjs'
import catalog from '../deploy/cloud/catalog-transfer.cjs'

export async function exportCloudCatalog(root) {
  if (await session(root)) throw Error('Сначала останови старый сайт: TEXHORU-STOP-WINDOWS.cmd')
  if (await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false)) {
    throw Error('Старый сервер ещё работает на порту 3000. Останови его перед переносом.')
  }
  process.loadEnvFile(join(root, 'server', '.env.local'))
  const file = databasePath(root, process.env.DATABASE_URL)
  if (!file.startsWith(resolve(root, 'server', 'prisma') + sep) || !existsSync(file)) throw Error('Локальная база сайта не найдена')
  const destination = join(root, '.texhoru', 'catalog-transfer')
  if (existsSync(destination)) throw Error('Папка .texhoru/catalog-transfer уже существует; она не будет перезаписана')
  const db = new DatabaseSync(file, { readOnly: true })
  let created = false
  try {
    const payload = catalog.exportCatalogRows(db)
    if (!payload.tables.Product.rows.length) throw Error('Старый каталог пуст; переносить нечего')
    catalog.validatePhotos(join(root, 'server', 'uploads'))
    mkdirSync(destination, { recursive: true, mode: 0o700 }); created = true
    writeFileSync(join(destination, 'catalog.json'), JSON.stringify(payload), { mode: 0o600 })
    if (existsSync(join(root, 'server', 'uploads'))) cpSync(join(root, 'server', 'uploads'), join(destination, 'uploads'), { recursive: true })
    else mkdirSync(join(destination, 'uploads'))
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ format: payload.format,
      sha256: catalog.sha256(join(destination, 'catalog.json')) }), { mode: 0o600 })
    console.log(`Подготовлено: товаров ${payload.tables.Product.rows.length}, привязок ${payload.tables.CompetitorProduct.rows.length}. Пользователи и очередь не включены.`)
    return destination
  } catch (error) {
    if (created) rmSync(destination, { recursive: true, force: true })
    throw error
  } finally { db.close() }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  exportCloudCatalog(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
    .then(directory => console.log('Папка переноса:', directory))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
