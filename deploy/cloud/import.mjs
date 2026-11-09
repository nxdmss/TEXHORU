import { existsSync, copyFileSync, cpSync, readFileSync, readdirSync, renameSync, rmSync, chmodSync, chownSync, mkdirSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileSha256 } from './data-files.mjs'
import { DatabaseSync } from 'node:sqlite'

export function importCloudData(sourceDirectory, targetDirectory, uploadsDirectory) {
  const sourcePath = join(sourceDirectory, 'database.db')
  const targetPath = join(targetDirectory, 'texhoru.db')
  const manifest = JSON.parse(readFileSync(join(sourceDirectory, 'manifest.json'), 'utf8'))
  const hash = fileSha256(sourcePath)
  if (manifest.version !== 1 || manifest.sha256 !== hash) throw Error('Transfer checksum mismatch')
  if (existsSync(sourcePath + '-wal')) throw Error('Expected a standalone exported database, not a live WAL database')
  function validateUploads(path) {
    if (!existsSync(path)) return
    const entry = lstatSync(path)
    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw Error('Unsupported file in transfer uploads')
    if (entry.isDirectory()) for (const name of readdirSync(path)) validateUploads(join(path, name))
  }
  validateUploads(join(sourceDirectory, 'uploads'))
  if (existsSync(join(sourceDirectory, 'uploads')) && readdirSync(join(sourceDirectory, 'uploads')).some(name => !['products', 'promos'].includes(name))) {
    throw Error('Unexpected folder in transfer uploads')
  }
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    if (Object.values(source.prepare('PRAGMA quick_check').get())[0] !== 'ok') throw Error('Source SQLite integrity check failed')
    if (source.prepare('PRAGMA foreign_key_check').get()) throw Error('Source SQLite foreign keys are inconsistent')
    for (const name of ['User', 'Product', 'Category', 'Order', 'OneCPriceChange', 'MonitorJob']) {
      if (!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw Error('Not a TEXHORU database: missing ' + name)
    }
    if (!source.prepare("SELECT COUNT(*) n FROM User WHERE role IN ('ADMIN','DIRECTOR') AND isActive=1").get().n) throw Error('Source has no active administrator')
    if (source.prepare("SELECT COUNT(*) n FROM OneCPriceChange WHERE status='PENDING'").get().n) throw Error('Source still has pending 1C writes')
    if (source.prepare("SELECT COUNT(*) n FROM MonitorJob WHERE status IN ('QUEUED','RUNNING','CHECKING','QUEUING','WAITING')").get().n) throw Error('Source still has active monitoring jobs')
  } finally { source.close() }
  // Refuse to overwrite an already used cloud site. Its bootstrap admin can be replaced.
  if (existsSync(targetPath)) {
    const target = new DatabaseSync(targetPath, { readOnly: true })
    try {
      for (const table of ['Product', 'Order', 'OneCPriceChange']) {
        if (target.prepare(`SELECT COUNT(*) n FROM "${table}"`).get().n) throw Error('Cloud site is not empty; import refused')
      }
      if (target.prepare('SELECT COUNT(*) n FROM User').get().n > 1) throw Error('Cloud site already has additional accounts')
    } finally { target.close() }
  }
  if (existsSync(uploadsDirectory) && readdirSync(uploadsDirectory).some(name => {
    const path = join(uploadsDirectory, name)
    return !['products', 'promos'].includes(name) || readdirSync(path).length > 0
  })) throw Error('Cloud uploads are not empty; import refused')
  const temporary = targetPath + '.import-tmp'
  let committed = false
  try {
    mkdirSync(targetDirectory, { recursive: true })
    copyFileSync(sourcePath, temporary)
    chmodSync(temporary, 0o600)
    if (process.getuid?.() === 0) chownSync(temporary, 1000, 1000)
    mkdirSync(uploadsDirectory, { recursive: true })
    if (existsSync(join(sourceDirectory, 'uploads'))) cpSync(join(sourceDirectory, 'uploads'), uploadsDirectory, { recursive: true })
    // The old app is stopped. Remove its sidecars before replacing its empty DB.
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(targetPath + suffix, { force: true })
    renameSync(temporary, targetPath)
    committed = true
    console.log('Site data imported. Use the administrator login from the OLD site. 1C was not accessed.')
  } finally {
    rmSync(temporary, { force: true })
    if (!committed) {
      // These destinations were verified empty, and the application is stopped.
      // Remove only partial photos copied by this unsuccessful import.
      for (const name of ['products', 'promos']) rmSync(join(uploadsDirectory, name), { recursive: true, force: true })
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { importCloudData('/transfer', '/data', '/uploads') }
  catch (error) { console.error('Import stopped:', error.message); process.exitCode = 1 }
}
