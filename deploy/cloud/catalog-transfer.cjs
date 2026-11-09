// Catalog-only migration. No users, passwords, orders or queued operations.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const TABLES = ['Category', 'Product', 'PromoBanner', 'CompetitorSource', 'CompetitorProduct',
  'ProductMatchOutcome', 'CompetitorCatalogEntry', 'CompetitorPriceHistory', 'MonitorSettings']
function sha256(file) {
  const fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536)
  try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); return hash.digest('hex') }
  finally { fs.closeSync(fd) }
}
function validatePhotos(directory) {
  if (!fs.existsSync(directory)) return
  for (const name of fs.readdirSync(directory)) if (!['products', 'promos'].includes(name)) throw Error('Unexpected upload folder')
  function walk(file) {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw Error('Unsupported upload file')
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) walk(path.join(file, name))
  }
  walk(directory)
}
function exportCatalogRows(db) {
  const tables = {}
  db.exec('BEGIN')
  try {
    for (const name of TABLES) {
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map(row => row.name)
      if (!columns.length) throw Error('Source catalog table missing: ' + name)
      // Two observations per card are enough to retain the verified baseline.
      const rows = name === 'CompetitorPriceHistory'
        ? db.prepare(`SELECT h.* FROM "CompetitorPriceHistory" h WHERE
            (SELECT COUNT(*) FROM "CompetitorPriceHistory" n WHERE n."competitorProductId"=h."competitorProductId"
              AND (n."checkedAt">h."checkedAt" OR (n."checkedAt"=h."checkedAt" AND n.id>h.id))) < 2`).all()
        : db.prepare(`SELECT * FROM "${name}"`).all()
      tables[name] = { columns, rows: rows.map(row => columns.map(column => name === 'Product' && column === 'reservedQty' ? 0 : row[column])) }
    }
    db.exec('COMMIT')
    return { format: 'texhoru-cloud-catalog-v1', exportedAt: new Date().toISOString(), tables }
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
function importCatalog(directory, database, uploads) {
  if (!fs.existsSync(database)) throw Error('Cloud database not found; initialize the site first')
  const file = path.join(directory, 'catalog.json')
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  if (manifest.format !== 'texhoru-cloud-catalog-v1' || manifest.sha256 !== sha256(file)) throw Error('Catalog transfer checksum/format mismatch')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (data.format !== manifest.format || Object.keys(data.tables || {}).length !== TABLES.length) throw Error('Unexpected catalog format')
  if (!data.tables.Product?.rows?.length) throw Error('Source catalog is empty')
  validatePhotos(path.join(directory, 'uploads'))
  if (fs.existsSync(uploads) && fs.readdirSync(uploads).some(name => !['products', 'promos'].includes(name)
    || !fs.lstatSync(path.join(uploads, name)).isDirectory() || fs.readdirSync(path.join(uploads, name)).length)) throw Error('Cloud uploads are not empty')
  const db = new DatabaseSync(database)
  let transaction = false, copied = false
  try {
    for (const name of ['Product', 'Order', 'OneCPriceChange', 'MonitorDelivery']) {
      if (db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n) throw Error('Cloud catalog is not empty; import refused')
    }
    if (!db.prepare("SELECT COUNT(*) n FROM User WHERE role IN ('ADMIN','DIRECTOR') AND isActive=1").get().n) throw Error('Cloud administrator is missing')
    if (db.prepare("SELECT COUNT(*) n FROM MonitorJob WHERE status IN ('QUEUED','RUNNING','CHECKING','QUEUING','WAITING')").get().n) throw Error('Cloud monitoring is active; stop it before import')
    for (const name of TABLES) {
      const expected = db.prepare(`PRAGMA table_info("${name}")`).all().map(row => row.name)
      const part = data.tables[name]
      if (!part || !Array.isArray(part.columns) || part.columns.length !== expected.length
        || new Set(part.columns).size !== expected.length || !part.columns.every(column => expected.includes(column))
        || !Array.isArray(part.rows) || part.rows.some(row => !Array.isArray(row) || row.length !== expected.length
          || row.some(value => value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))))) {
        throw Error('Incompatible catalog schema or values: ' + name)
      }
    }
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE'); transaction = true
    // Delete only the initial empty catalog's default source/settings rows.
    for (const name of [...TABLES].reverse()) db.exec(`DELETE FROM "${name}"`)
    for (const name of TABLES) {
      const { columns, rows } = data.tables[name]
      const insert = db.prepare(`INSERT INTO "${name}" (${columns.map(column => '"' + column + '"').join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      for (const row of rows) insert.run(...row)
    }
    if (db.prepare('SELECT COUNT(*) n FROM Product WHERE priceSyncEnabled=1').get().n > 30) throw Error('TEST permission count exceeds 30')
    if (db.prepare('PRAGMA foreign_key_check').get()) throw Error('Catalog foreign keys are inconsistent')
    fs.mkdirSync(uploads, { recursive: true }); copied = true
    if (fs.existsSync(path.join(directory, 'uploads'))) fs.cpSync(path.join(directory, 'uploads'), uploads, { recursive: true })
    db.exec('COMMIT'); transaction = false
    return { products: data.tables.Product.rows.length, categories: data.tables.Category.rows.length,
      links: data.tables.CompetitorProduct.rows.length }
  } catch (error) {
    if (transaction) db.exec('ROLLBACK')
    if (copied) for (const name of ['products', 'promos']) fs.rmSync(path.join(uploads, name), { recursive: true, force: true })
    throw error
  } finally { db.close() }
}
module.exports = { TABLES, exportCatalogRows, importCatalog, sha256, validatePhotos }
