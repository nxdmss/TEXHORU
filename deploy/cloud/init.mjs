import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
const require = createRequire(new URL('../../server/package.json', import.meta.url))
const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

export async function initialize() {
  if (process.env.DATABASE_URL !== 'file:/data/texhoru.db') throw Error('Cloud initializer requires the persistent /data database')
  mkdirSync('/uploads/products', { recursive: true })
  mkdirSync('/uploads/promos', { recursive: true })
  // Refuse destructive schema changes: no reset/force/accept-data-loss flags.
  const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push',
    '--schema=/app/server/prisma/schema.local.prisma', '--skip-generate'], { stdio: 'inherit' })
  if (result.status !== 0) throw Error('Schema preparation failed; existing data was not reset')
  const db = new PrismaClient()
  try {
    const admins = await db.user.count({ where: { role: { in: ['ADMIN', 'DIRECTOR'] }, isActive: true } })
    if (admins) return // Never reset an existing administrator or password on restart.
    const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase()
    const password = process.env.ADMIN_PASSWORD || ''
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 16) throw Error('First start requires ADMIN_EMAIL and ADMIN_PASSWORD (at least 16 characters)')
    if (await db.user.findUnique({ where: { email } })) throw Error('ADMIN_EMAIL already belongs to a non-admin user; refusing to overwrite it')
    await db.user.create({ data: { email, name: 'Директор TEXHORU', role: 'DIRECTOR', passwordHash: await bcrypt.hash(password, 12) } })
    console.log('Cloud administrator created. No demo products or categories were added.')
  } finally { await db.$disconnect() }
}

initialize().catch(error => { console.error('Cloud initialization stopped:', error.message); process.exitCode = 1 })
