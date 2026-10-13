import { existsSync, readdirSync, readFileSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { createHash } from 'node:crypto'

const frontend = ['src', 'public', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json']
const backend = ['server/src', 'server/tsconfig.json', 'server/tsconfig.build.json', 'server/nest-cli.json']
const restart = ['package.json', 'package-lock.json', 'server/package.json', 'server/package-lock.json', 'server/prisma', 'server/.env.local', 'scripts']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function updateSnapshot(root) {
  const entries = new Map()
  function walk(path, kind) {
    if (!existsSync(path)) return
    const entry = readdirSync(dirname(path), { withFileTypes: true }).find(e => e.name === path.split(/[\\/]/).at(-1))
    if (entry?.isDirectory()) { for (const name of readdirSync(path).sort()) walk(join(path, name), kind); return }
    const name = relative(root, path).replace(/\\/g, '/')
    // Local database files must never trigger updates or be copied into the runtime.
    if (/\.(db|sqlite|sqlite3)(-|$)/i.test(name)) return
    entries.set(name, { kind, hash: hash(readFileSync(path)) })
  }
  for (const path of frontend) walk(join(root, path), 'frontend')
  for (const path of backend) walk(join(root, path), 'backend')
  for (const path of restart) walk(join(root, path), 'restart')
  return entries
}
export function snapshotKey(snapshot) { return hash(JSON.stringify([...snapshot])) }
export function updateKind(before, after) {
  let kind = ''
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(name)?.hash === after.get(name)?.hash) continue
    const next = after.get(name)?.kind || before.get(name)?.kind
    if (next === 'restart') return 'restart'
    if (next === 'backend') kind = 'backend'
    else if (!kind) kind = 'frontend'
  }
  return kind
}
export function syncUpdate(root, runtime, before, after) {
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(name)?.hash === after.get(name)?.hash) continue
    const entry = after.get(name) || before.get(name)
    if (!['frontend', 'backend'].includes(entry.kind)) continue
    const destination = join(runtime, name)
    if (!after.has(name)) { if (existsSync(destination)) unlinkSync(destination); continue }
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(root, name), destination)
  }
}
export function watchUpdates(root, apply, onError, period = 2000) {
  let baseline = updateSnapshot(root), pending = '', running = false, closed = false, failedKey = ''
  const timer = setInterval(async () => {
    if (closed || running) return
    try {
      const latest = updateSnapshot(root), key = snapshotKey(latest)
      if (key === snapshotKey(baseline)) { pending = ''; return }
      if (key === failedKey) return
      // Wait for two identical snapshots so partial archive extraction is not applied.
      if (key !== pending) { pending = key; return }
      running = true
      try { await apply(updateKind(baseline, latest), baseline, latest) }
      catch (error) { failedKey = key; throw error }
      baseline = latest; pending = ''
    } catch (error) { onError(error); pending = '' }
    finally { running = false }
  }, period)
  return () => { closed = true; clearInterval(timer) }
}
