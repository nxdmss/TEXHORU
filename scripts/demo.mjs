import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { prepareRuntime, npmCommand, run, projectId } from './runtime-preparation.mjs'
import { session, removeSession } from './session-control.mjs'
import { demoDomain, waitReady } from './demo-config.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = join(root, '.texhoru')
const children = []
const abort = new AbortController()
const localOnly = process.argv.includes('--local')
let controller, token, closing = false, ready = false, ownedLock = false, domain, publicUrl
const lockFile = join(state, 'startup.lock')
async function stop() {
  if (closing) return
  closing = true; abort.abort()
  await Promise.all(children.map(child => new Promise(done => {
    if (child.exitCode !== null || child.signalCode !== null) return done()
    child.once('exit', done)
    child.kill('SIGTERM')
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); done() }, 5000)
    timer.unref()
  })))
  if (token) removeSession(root, token)
  if (ownedLock) { try { unlinkSync(lockFile) } catch {} }
}
function child(command, args, cwd, env, log) {
  const fd = openSync(log, 'a')
  let processChild
  try { processChild = spawn(command, args, { cwd, env, stdio: ['ignore', fd, fd], windowsHide: true }) }
  finally { closeSync(fd) }
  children.push(processChild)
  processChild.once('error', () => void fail(new Error(`Не удалось запустить ${command}. Проверь установку и ${log}`)))
  processChild.once('exit', code => { if (!closing) void fail(new Error(`Процесс завершился (${code}). Журнал: ${log}`)) })
  return processChild
}
async function fail(error) {
  if (closing) return
  console.error(error.message)
  process.exitCode = 1
  await stop(); controller?.close()
}
async function main() {
  mkdirSync(state, { recursive: true })
  const existing = await session(root)
  if (existing) {
    if (existing.status.mode !== 'demo') throw new Error('Уже запущен обычный TEXHORU. Сначала останови его через TEXHORU-STOP-WINDOWS.cmd.')
    console.log(existing.status.ready ? `Демонстрация уже работает: ${existing.status.url}` : 'Демонстрация уже готовится. Дождись готовности в первом окне.')
    return
  }
  try {
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
    let alive = false
    try { process.kill(lock.pid, 0); alive = true } catch {}
    if (alive) throw new Error('TEXHORU уже запускается. Дождись первого окна.')
    unlinkSync(lockFile)
  } catch (error) { if (error.message.includes('уже запускается')) throw error }
  if (localOnly) {
    publicUrl = 'http://127.0.0.1:3000'
  } else {
    const configFile = join(state, 'demo.json')
    let config = {}
    if (existsSync(configFile)) config = JSON.parse(readFileSync(configFile, 'utf8'))
    if (!config.domain) {
      const input = createInterface({ input: process.stdin, output: process.stdout })
      try { config.domain = demoDomain(await input.question('Постоянный HTTPS-адрес из панели ngrok: ')) }
      finally { input.close() }
      writeFileSync(configFile, JSON.stringify(config, null, 2))
    }
    domain = demoDomain(config.domain)
    publicUrl = `https://${domain}`
  }
  const fd = openSync(lockFile, 'wx'); writeFileSync(fd, JSON.stringify({ pid: process.pid })); closeSync(fd); ownedLock = true
  token = randomBytes(32).toString('hex')
  controller = createServer(async (req, res) => {
    const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(401); res.end(); return }
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET' && req.url === '/texhoru/status') {
      res.end(JSON.stringify({ projectId: projectId(root), mode: 'demo', ready, url: publicUrl })); return
    }
    if (req.method === 'POST' && req.url === '/texhoru/stop') { await stop(); res.end('{"ok":true}'); controller.close(); return }
    res.writeHead(404); res.end()
  })
  await new Promise((done, reject) => { controller.once('error', reject); controller.listen(0, '127.0.0.1', done) })
  writeFileSync(join(state, 'session.json'), JSON.stringify({ root, port: controller.address().port, token }))
  // Avoid a successful public check against a different local copy.
  const busy = await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false)
  if (busy) throw new Error('Порт 3000 занят. Останови предыдущий сервер перед запуском демонстрации.')
  const prepared = await prepareRuntime(root, join(state, 'demo-setup.log'), console.log, abort.signal)
  if (closing) return
  let buildFingerprint
  try { buildFingerprint = JSON.parse(readFileSync(join(prepared.runtime, 'demo-build.json'), 'utf8')).fingerprint } catch {}
  if (buildFingerprint !== prepared.fingerprint || !existsSync(join(prepared.runtime, 'dist', 'index.html'))) {
    console.log('Собираю интерфейс для демонстрации…')
    const npm = npmCommand(['run', 'build'])
    await run(npm.command, npm.args, prepared.runtime, { ...prepared.env, NODE_ENV: 'production' }, join(state, 'demo-setup.log'), abort.signal)
    writeFileSync(join(prepared.runtime, 'demo-build.json'), JSON.stringify({ fingerprint: prepared.fingerprint }))
  }
  if (closing) return
  const env = { ...prepared.env, SERVE_STOREFRONT: 'true', FRONTEND_ORIGIN: publicUrl, FRONTEND_PUBLIC_URL: publicUrl }
  child(process.execPath, [join(prepared.runtime, 'server', 'dist', 'main.js')], join(prepared.runtime, 'server'), env, join(state, 'demo-api.log'))
  const validate = async r => { const data = await r.json(); return data.ok === true && data.service === 'texhoru-api' && data.projectId === prepared.projectId }
  await waitReady('http://127.0.0.1:3000/api/health', validate, { stopped: () => closing })
  if (closing) return
  if (!localOnly) {
    child('ngrok', ['http', '--url', publicUrl, 'http://127.0.0.1:3000', '--log', join(state, 'demo-ngrok.log'), '--log-format', 'json'], root, process.env, join(state, 'demo-ngrok-console.log'))
    await waitReady(`${publicUrl}/api/health`, validate, { stopped: () => closing })
    if (closing) return
  }
  await waitReady(`${publicUrl}/`, async r => (await r.text()).includes('id="root"'), { attempts: 5, stopped: () => closing })
  if (closing) return
  ready = true
  if (process.platform === 'win32' && process.env.TEXHORU_NO_BROWSER !== '1') {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', `${publicUrl}/admin`], { stdio: 'ignore', windowsHide: true })
      .once('error', () => console.log('Открой адрес демонстрации в браузере.'))
  }
  console.log(`\nДемонстрация готова: ${publicUrl}/admin\n${localOnly ? 'Локальная проверка без ngrok.' : 'Этот же домен должен быть указан у агента 1С.'}\nОставь окно открытым. Для остановки: TEXHORU-STOP-WINDOWS.cmd.`)
}
process.on('SIGINT', () => void stop().then(() => controller?.close()))
process.on('SIGTERM', () => void stop().then(() => controller?.close()))
main().catch(fail)
