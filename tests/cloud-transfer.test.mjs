import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { exportCloudData } from '../scripts/export-cloud-data.mjs'
import { importCloudData } from '../deploy/cloud/import.mjs'

function fixture(file, products = 1) {
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE User(id TEXT,role TEXT,isActive INTEGER); INSERT INTO User VALUES ('admin','DIRECTOR',1);
    CREATE TABLE Product(id INTEGER); CREATE TABLE Category(id INTEGER); CREATE TABLE "Order"(id INTEGER);
    CREATE TABLE OneCPriceChange(id TEXT,status TEXT); CREATE TABLE MonitorJob(id TEXT,status TEXT);`)
  if (products) db.exec('INSERT INTO Product VALUES(1)')
  return db
}

test('offline export includes WAL data and photos; imports only into empty cloud storage and checks integrity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texhoru-transfer-'))
  const previous = process.env.DATABASE_URL
  let source
  try {
    mkdirSync(join(root, 'server', 'prisma'), { recursive: true })
    mkdirSync(join(root, 'server', 'uploads', 'products'), { recursive: true })
    writeFileSync(join(root, 'server', 'uploads', 'products', 'test.png'), 'photo')
    writeFileSync(join(root, 'server', '.env.local'), 'DATABASE_URL=file:./dev-local.db\n')
    process.env.DATABASE_URL = 'file:./dev-local.db'
    source = fixture(join(root, 'server', 'prisma', 'dev-local.db'))
    source.exec("PRAGMA journal_mode=WAL; INSERT INTO OneCPriceChange VALUES('pending','PENDING')")
    await assert.rejects(() => exportCloudData(root), /заверши очередь/)
    assert.equal(existsSync(join(root, '.texhoru', 'cloud-transfer')), false)
    source.exec("DELETE FROM OneCPriceChange; INSERT INTO Product VALUES(2)")
    const transfer = await exportCloudData(root)
    await assert.rejects(() => exportCloudData(root), /уже существует/)
    const original = source.prepare('SELECT COUNT(*) n FROM Product').get().n
    assert.equal(original, 2, 'source is never emptied')
    const destination = join(root, 'cloud-db'), uploads = join(root, 'cloud-uploads')
    mkdirSync(destination)
    const empty = fixture(join(destination, 'texhoru.db'), 0); empty.close()
    importCloudData(transfer, destination, uploads)
    const imported = new DatabaseSync(join(destination, 'texhoru.db'), { readOnly: true })
    assert.equal(imported.prepare('SELECT COUNT(*) n FROM Product').get().n, 2)
    imported.close()
    assert.equal(readFileSync(join(uploads, 'products', 'test.png'), 'utf8'), 'photo')
    assert.throws(() => importCloudData(transfer, destination, uploads), /not empty/)
    const bytes = readFileSync(join(transfer, 'database.db'))
    writeFileSync(join(transfer, 'database.db'), Buffer.concat([bytes, Buffer.from('tamper')]))
    assert.throws(() => importCloudData(transfer, destination, uploads), /checksum/)
    assert.notEqual(createHash('sha256').update(readFileSync(join(transfer, 'database.db'))).digest('hex'), JSON.parse(readFileSync(join(transfer, 'manifest.json'))).sha256)
  } finally {
    source?.close()
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous
    rmSync(root, { recursive: true, force: true })
  }
})
