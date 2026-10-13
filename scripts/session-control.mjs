import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { projectId } from './runtime-preparation.mjs'

export async function session(root) {
  const file = join(root, '.texhoru', 'session.json')
  if (!existsSync(file)) return null
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (saved.root !== root || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535 || typeof saved.token !== 'string') return null
    const response = await fetch(`http://127.0.0.1:${saved.port}/texhoru/status`, { headers: { authorization: `Bearer ${saved.token}` }, signal: AbortSignal.timeout(1500) })
    const status = await response.json()
    if (!response.ok || status.projectId !== projectId(root)) return null
    return { ...saved, status }
  } catch { return null }
}
export async function stopSession(root) {
  const own = await session(root)
  if (!own) return false
  const response = await fetch(`http://127.0.0.1:${own.port}/texhoru/stop`, { method: 'POST', headers: { authorization: `Bearer ${own.token}` }, signal: AbortSignal.timeout(12000) })
  if (!response.ok) throw new Error('Не удалось остановить предыдущий запуск TEXHORU')
  return true
}
export function removeSession(root, token) {
  const file = join(root, '.texhoru', 'session.json')
  try { if (JSON.parse(readFileSync(file, 'utf8')).token === token) unlinkSync(file) } catch {}
}
