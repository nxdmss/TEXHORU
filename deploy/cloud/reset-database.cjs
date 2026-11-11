// Offline maintenance only: caller stops the application and backs up the DB first.
const { DatabaseSync } = require('node:sqlite')
const { statSync } = require('node:fs')
const quote = name => '"' + name.replaceAll('"', '""') + '"'
function resetDatabase(file) {
  if (!statSync(file).isFile()) throw Error('Database file not found')
  const db = new DatabaseSync(file, { open: false })
  db.open()
  let transaction = false
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;')
    transaction = true
    const admins = db.prepare(`SELECT id,email FROM User WHERE role IN ('ADMIN','DIRECTOR') AND isActive=1`).all()
    if (admins.length !== 1) throw Error('Expected exactly one active administrator; database was not cleared')
    const admin = admins[0]
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'").all()
    const removed = {}
    for (const { name } of tables) {
      const result = name === 'User'
        ? db.prepare('DELETE FROM User WHERE id != ?').run(admin.id)
        : db.prepare(`DELETE FROM ${quote(name)}`).run()
      removed[name] = Number(result.changes)
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw Error('Foreign key validation failed; reset rolled back')
    db.exec('COMMIT')
    transaction = false
    return { administrator: admin.email, removed }
  } catch (error) {
    if (transaction) db.exec('ROLLBACK')
    throw error
  } finally { db.close() }
}
module.exports = { resetDatabase }
