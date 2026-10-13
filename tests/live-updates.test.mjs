import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { updateSnapshot, updateKind, syncUpdate, watchUpdates } from '../scripts/live-updates.mjs'
const delay = ms => new Promise(done => setTimeout(done, ms))
test('syncs interface files and removals, ignores database, distinguishes backend and full updates', () => {
  const temp = mkdtempSync(join(process.env.TMPDIR || process.cwd(), 'live-update-'))
  try {
    const root = join(temp, 'original'), runtime = join(temp, 'cache')
    for (const p of ['src', 'server/src', 'server/prisma', 'scripts']) mkdirSync(join(root, p), { recursive: true })
    mkdirSync(join(runtime, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'ui.tsx'), 'old')
    writeFileSync(join(runtime, 'src', 'ui.tsx'), 'old')
    const before = updateSnapshot(root)
    writeFileSync(join(root, 'server/prisma/dev-local.db'), 'database bytes')
    assert.equal(updateKind(before, updateSnapshot(root)), '')
    writeFileSync(join(root, 'src', 'ui.tsx'), 'new')
    const next = updateSnapshot(root)
    assert.equal(updateKind(before, next), 'frontend')
    syncUpdate(root, runtime, before, next)
    assert.equal(readFileSync(join(runtime, 'src/ui.tsx'), 'utf8'), 'new')
    assert.equal(existsSync(join(runtime, 'server/prisma/dev-local.db')), false)
    unlinkSync(join(root, 'src/ui.tsx'))
    syncUpdate(root, runtime, next, updateSnapshot(root))
    assert.equal(existsSync(join(runtime, 'src/ui.tsx')), false)
    writeFileSync(join(root, 'server/src/main.ts'), 'server')
    assert.equal(updateKind(before, updateSnapshot(root)), 'backend')
    writeFileSync(join(root, 'package-lock.json'), '{}')
    assert.equal(updateKind(before, updateSnapshot(root)), 'restart')
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
test('waits for stable files, applies once and stops watching; failed versions do not retry forever', async () => {
  const root = mkdtempSync(join(process.env.TMPDIR || process.cwd(), 'live-watch-'))
  let stop
  try {
    mkdirSync(join(root, 'src')); const file = join(root, 'src/ui.tsx'); writeFileSync(file, 'old')
    let count = 0, errors = 0
    stop = watchUpdates(root, async () => { count++; throw new Error('invalid source') }, () => errors++, 20)
    writeFileSync(file, 'new')
    await delay(180)
    assert.equal(count, 1); assert.equal(errors, 1)
    writeFileSync(file, 'fixed'); await delay(180)
    assert.equal(count, 2)
    stop(); writeFileSync(file, 'later'); await delay(80)
    assert.equal(count, 2)
  } finally { stop?.(); rmSync(root, { recursive: true, force: true }) }
})
