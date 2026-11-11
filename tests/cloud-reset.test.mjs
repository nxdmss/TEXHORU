import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { resetDatabase } = createRequire(import.meta.url)('../deploy/cloud/reset-database.cjs')
function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'texhoru-reset-test-')), file = join(dir, 'test.db')
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE User(id TEXT PRIMARY KEY,email TEXT,role TEXT,isActive INTEGER,passwordHash TEXT,sessionVersion INTEGER);
    CREATE TABLE Product(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE Purchase(id INTEGER PRIMARY KEY,userId TEXT REFERENCES User(id));
    CREATE TABLE Item(id INTEGER PRIMARY KEY,orderId INTEGER REFERENCES Purchase(id),productId INTEGER REFERENCES Product(id));
    CREATE TABLE EmailToken(userId TEXT REFERENCES User(id),tokenHash TEXT);
    CREATE TABLE _prisma_migrations(id TEXT);
    INSERT INTO User VALUES('admin','admin@example.test','DIRECTOR',1,'unchanged-hash',9),('customer','customer@example.test','CUSTOMER',1,'customer-hash',0),('manager','manager@example.test','MANAGER',1,'manager-hash',0);
    INSERT INTO Product VALUES(1,'Phone'); INSERT INTO Purchase VALUES(1,'customer'); INSERT INTO Item VALUES(1,1,1);
    INSERT INTO EmailToken VALUES('admin','old-token'); INSERT INTO _prisma_migrations VALUES('schema-history');`)
  try { run(file, db) } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
}
test('clear all application data but preserve the administrator and schema history', () => fixture((file, db) => {
  const before = db.prepare('SELECT * FROM User WHERE id=?').get('admin')
  const result = resetDatabase(file)
  assert.equal(result.administrator, 'admin@example.test')
  assert.deepEqual(db.prepare('SELECT * FROM User').all(), [before])
  for (const table of ['Product','Purchase','Item','EmailToken']) assert.equal(db.prepare(`SELECT count(*) n FROM "${table}"`).get().n, 0)
  assert.equal(db.prepare('SELECT count(*) n FROM _prisma_migrations').get().n, 1)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
}))
test('zero or multiple active administrators abort without deleting any data', () => {
  for (const role of ['CUSTOMER','ADMIN']) fixture((file, db) => {
    if (role === 'CUSTOMER') db.exec("UPDATE User SET role='CUSTOMER' WHERE id='admin'")
    else db.exec("UPDATE User SET role='ADMIN' WHERE id='manager'")
    const before = db.prepare('SELECT * FROM User ORDER BY id').all()
    assert.throws(() => resetDatabase(file), /exactly one/)
    assert.deepEqual(db.prepare('SELECT * FROM User ORDER BY id').all(), before)
    assert.equal(db.prepare('SELECT count(*) n FROM Item').get().n, 1)
  })
})
test('a failure midway through deletion rolls back every previous deletion', () => fixture((file, db) => {
  db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON Item BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
  assert.throws(() => resetDatabase(file), /fixture failure/)
  assert.equal(db.prepare('SELECT count(*) n FROM User').get().n, 3)
  assert.equal(db.prepare('SELECT count(*) n FROM Product').get().n, 1)
  assert.equal(db.prepare('SELECT count(*) n FROM Purchase').get().n, 1)
}))
test('a missing file is not created by a reset attempt', () => {
  const file = join(tmpdir(), 'texhoru-missing-' + Date.now() + '.db')
  assert.throws(() => resetDatabase(file))
  assert(!existsSync(file))
})
