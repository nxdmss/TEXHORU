import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = join(root, 'server')
const state = join(root, '.texhoru')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
mkdirSync(state, { recursive: true })

function runSetupIfNeeded() {
  const missing = !existsSync(join(root, 'node_modules')) || !existsSync(join(server, 'node_modules')) || !existsSync(join(server, '.env.local'))
  if (!missing) return
  console.log('Первый запуск: подготавливаю TEXHORU...')
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'setup.mjs')], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

async function waitFor(url, seconds = 90) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

function openBrowser(url) {
  if (process.env.TEXHORU_NO_BROWSER === '1') return
  if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

function spawnService(args, cwd, env = {}) {
  const child = spawn(npm, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    detached: process.platform !== 'win32',
  })
  return child
}

function killTree(child) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGTERM')
  } catch {}
}

runSetupIfNeeded()

const backend = spawnService(['run', 'start:dev'], server, {
  TEXHORU_ENV_FILE: '.env.local',
  DATABASE_URL: 'file:./dev-local.db',
})
const frontend = spawnService(['run', 'dev:frontend'], root)

writeFileSync(join(state, 'pids.json'), JSON.stringify({ backend: backend.pid, frontend: frontend.pid }, null, 2))

let closing = false
function shutdown(code = 0) {
  if (closing) return
  closing = true
  killTree(frontend)
  killTree(backend)
  rmSync(join(state, 'pids.json'), { force: true })
  setTimeout(() => process.exit(code), 150)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
backend.on('exit', (code) => { if (!closing && code) shutdown(code) })
frontend.on('exit', (code) => { if (!closing && code) shutdown(code) })

const [apiReady, webReady] = await Promise.all([
  waitFor('http://127.0.0.1:3000/api/health'),
  waitFor('http://127.0.0.1:5173/'),
])
if (!apiReady || !webReady) {
  console.error('TEXHORU не успел запуститься. Проверь сообщения выше.')
  shutdown(1)
} else {
  console.log('\nTEXHORU запущен: http://127.0.0.1:5173/')
  console.log('Админка:         http://127.0.0.1:5173/admin')
  console.log('Остановить: Ctrl+C или TEXHORU STOP.command\n')
  openBrowser('http://127.0.0.1:5173/')
}
