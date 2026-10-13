import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest, prepareRuntime, projectId, sourceFingerprint, cacheBase, npmCommand, run } from './runtime-preparation.mjs'
import { removeSession, session, stopSession } from './session-control.mjs'
import { syncUpdate, watchUpdates } from './live-updates.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const initialEnvironment = { ...process.env }
const state = join(root, '.texhoru'); mkdirSync(state, { recursive: true })
const logFile = join(state, 'startup.log')
let launchToken, server, lockOwned = false, closing = false
let stopUpdates
const plannedStops = new WeakSet()
const children = []
const preparation = new AbortController()
const lockFile = join(state, 'startup.lock')
const lockAlive = () => { try { const pid = JSON.parse(readFileSync(lockFile, 'utf8')).pid; process.kill(pid, 0); return true } catch { return false } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const envFile = join(root, 'server', '.env.local')
const expectedLaunch = () => digest(sourceFingerprint(root) + (existsSync(envFile) ? digest(readFileSync(envFile)) : ''))
async function health() {
  try { const response = await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(1200) }); return response.ok ? await response.json() : null } catch { return null }
}
function openBrowser() {
  if (process.env.TEXHORU_NO_BROWSER === '1') return
  if (process.platform === 'win32') spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'start "" "http://127.0.0.1:5173/"'], { stdio: 'ignore', windowsHide: true, detached: true }).unref()
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', ['http://127.0.0.1:5173/'], { stdio: 'ignore', detached: true }).unref()
}
async function stopChild(child, ipc) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(done => child.once('exit', done))
  if (ipc && child.connected) child.send({ type: 'TEXHORU_SHUTDOWN' }, () => {})
  else { try { child.kill('SIGTERM') } catch {} }
  const stopped = await Promise.race([exited.then(() => true), sleep(4000).then(() => false)])
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else { try { child.kill('SIGKILL') } catch {} }
    await Promise.race([exited, sleep(2000)])
  }
}
async function closeApplication() {
  if (closing) return
  closing = true
  stopUpdates?.()
  preparation.abort()
  await Promise.all(children.map(({ child, ipc }) => stopChild(child, ipc)))
  if (launchToken) removeSession(root, launchToken)
  if (lockOwned) { try { if (JSON.parse(readFileSync(lockFile, 'utf8')).pid === process.pid) unlinkSync(lockFile) } catch {} }
  if (launchToken) { try { unlinkSync(join(state, 'pids.json')) } catch {} }
}
function startChild(file, args, cwd, env, ipc = false) {
  const fd = openSync(logFile, 'a')
  let child
  try { child = spawn(process.execPath, [file, ...args], { cwd, env, stdio: ['ignore', fd, fd, ...(ipc ? ['ipc'] : [])], windowsHide: true }) }
  finally { closeSync(fd) }
  children.push({ child, ipc })
  child.on('error', error => { if (!closing) void fail(error) })
  child.on('exit', () => { if (!closing && !plannedStops.has(child)) void fail(new Error(`Приложение остановилось. Подробности: ${logFile}`)) })
  return child
}
async function fail(error) {
  console.error(error.message)
  try { appendFileSync(logFile, `\n${new Date().toISOString()} ${error.message}\n`) } catch {}
  await closeApplication()
  server?.close()
  process.exitCode = 1
}
async function main() {
  console.log('TEXHORU — запуск одной кнопкой')
  const existing = await session(root)
  if (existing) {
    if (!existing.status.ready) { console.log('TEXHORU уже готовится к запуску. Подожди первое окно.'); return }
    if (existing.status.launchFingerprint === expectedLaunch()) { openBrowser(); console.log('TEXHORU уже запущен.'); return }
    console.log('Применяю обновление…')
    await stopSession(root)
  }
  if (lockAlive()) { console.log('TEXHORU уже запускается. Подожди первое окно.'); return }
  try { unlinkSync(lockFile) } catch {}
  const lock = openSync(lockFile, 'wx'); writeFileSync(lock, JSON.stringify({ pid: process.pid })); closeSync(lock); lockOwned = true
  if (await health()) throw new Error('На порту 3000 уже работает другая или старая копия. Закрой её окно и снова нажми TEXHORU.exe.')
  writeFileSync(logFile, `TEXHORU automatic start ${new Date().toISOString()}\n`)
  launchToken = randomBytes(32).toString('hex')
  let ready = false, launchFingerprint = ''
  const identifier = projectId(root)
  server = createServer(async (req, res) => {
    const actual = Buffer.from(req.headers.authorization || '')
    const expected = Buffer.from(`Bearer ${launchToken}`)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(401); res.end(); return }
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET' && req.url === '/texhoru/status') { res.end(JSON.stringify({ projectId: identifier, ready, launchFingerprint })); return }
    if (req.method === 'POST' && req.url === '/texhoru/stop') {
      await closeApplication(); res.end(JSON.stringify({ ok: true })); server.close(); return
    }
    res.writeHead(404); res.end()
  })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  writeFileSync(join(state, 'session.json'), JSON.stringify({ root, port: server.address().port, token: launchToken }))
  const prepared = await prepareRuntime(root, logFile, console.log, preparation.signal)
  if (closing) return
  launchFingerprint = prepared.launchFingerprint
  console.log('Запускаю TEXHORU…')
  let backend = startChild(join(prepared.runtime, 'server', 'dist', 'main.js'), [], join(prepared.runtime, 'server'), prepared.env, true)
  const frontend = startChild(join(prepared.runtime, 'node_modules', 'vite', 'bin', 'vite.js'), ['--host', '127.0.0.1', '--port', '5173', '--strictPort'], prepared.runtime, prepared.env)
  writeFileSync(join(state, 'pids.json'), JSON.stringify({ root, frontend: frontend.pid, backend: backend.pid }))
  for (let n = 0; n < 120 && !closing; n++) {
    const api = await health()
    const web = await fetch('http://127.0.0.1:5173/', { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false)
    if (api?.projectId === prepared.projectId && web) { ready = true; break }
    await sleep(500)
  }
  if (!ready) throw new Error(`Не удалось запустить TEXHORU. Подробности: ${logFile}`)
  console.log('Готово. Открываю TEXHORU. Для остановки — TEXHORU STOP.exe.')
  stopUpdates = watchUpdates(root, async (kind, before, after) => {
    if (closing) return
    if (kind === 'restart') {
      console.log('Обновление запуска или зависимостей: перезапускаю TEXHORU автоматически…')
      await closeApplication()
      await new Promise(done => server.close(done))
      const successor = spawn(process.execPath, [join(root, 'scripts', 'auto-start.mjs')], { cwd: root, env: { ...initialEnvironment, TEXHORU_NO_BROWSER: '1' }, stdio: 'inherit', windowsHide: true })
      await new Promise(done => {
        successor.once('error', error => { console.error(error.message); process.exitCode = 1; done() })
        successor.once('exit', code => { process.exitCode = code || 0; done() })
      })
      return
    }
    syncUpdate(root, prepared.runtime, before, after)
    if (kind === 'backend') {
      console.log('Обновляю сервер. Сайт остаётся открытым…')
      const build = npmCommand(['run', 'build'])
      await run(build.command, build.args, join(prepared.runtime, 'server'), prepared.env, logFile, preparation.signal)
      if (closing) return
      ready = false
      plannedStops.add(backend)
      await stopChild(backend, true)
      backend = startChild(join(prepared.runtime, 'server', 'dist', 'main.js'), [], join(prepared.runtime, 'server'), prepared.env, true)
      for (let n = 0; n < 60 && !closing; n++) {
        if ((await health())?.projectId === identifier) { ready = true; break }
        await sleep(500)
      }
      if (!ready) throw new Error('Обновлённый сервер не запустился. Подробности в startup.log.')
      writeFileSync(join(state, 'pids.json'), JSON.stringify({ root, frontend: frontend.pid, backend: backend.pid }))
    }
    const nextFingerprint = sourceFingerprint(root)
    // Retire the old cache key: its files now contain the new version.
    try { unlinkSync(join(cacheBase(root), `${prepared.fingerprint}.json`)) } catch {}
    prepared.fingerprint = nextFingerprint
    writeFileSync(join(prepared.runtime, 'complete.json'), JSON.stringify({ fingerprint: nextFingerprint }))
    writeFileSync(join(cacheBase(root), `${nextFingerprint}.json`), JSON.stringify({ directory: prepared.runtime.split(/[\\/]/).at(-1), fingerprint: nextFingerprint }))
    launchFingerprint = expectedLaunch()
    console.log('Обновление применено. Продолжай работу в браузере.')
  }, error => {
    if (closing) return
    console.error(`Не удалось применить обновление: ${error.message}`)
    appendFileSync(logFile, `\nLive update: ${error.message}\n`)
  })
  console.log('Автообновление включено: замени файлы — изменения подхватятся сами.')
  openBrowser()
}
process.on('SIGINT', () => { void closeApplication().then(() => server?.close()) })
process.on('SIGTERM', () => { void closeApplication().then(() => server?.close()) })
main().catch(error => { if (closing) return; return fail(error) })
