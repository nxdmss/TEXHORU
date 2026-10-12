import { existsSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pidFile = join(root, '.texhoru', 'pids.json')
if (!existsSync(pidFile)) {
  console.log('TEXHORU уже остановлен.')
  process.exit(0)
}

const pids = JSON.parse(readFileSync(pidFile, 'utf8'))
for (const pid of [pids.frontend, pids.backend]) {
  if (!pid) continue
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-pid, 'SIGTERM')
  } catch {}
}
rmSync(pidFile, { force: true })
console.log('TEXHORU остановлен.')
