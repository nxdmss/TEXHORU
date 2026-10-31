import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, openSync, closeSync, renameSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve, relative } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

const sourcePaths = ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'src', 'public', 'server/package.json', 'server/package-lock.json', 'server/nest-cli.json', 'server/tsconfig.json', 'server/tsconfig.build.json', 'server/src', 'server/prisma/schema.prisma', 'server/prisma/schema.local.prisma', 'server/prisma/seed.ts']
const startupPaths = ['scripts/runtime-preparation.mjs', 'scripts/auto-start.mjs', 'scripts/session-control.mjs', 'scripts/live-updates.mjs']
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export function projectId(root) { return digest(process.platform === 'win32' ? realpathSync(root).toLowerCase() : realpathSync(root)).slice(0, 24) }
function files(path) {
  if (!existsSync(path)) throw new Error(`Не найден файл проекта: ${path}. Распакуй обновление полностью.`)
  const entry = readdirSync(dirname(path), { withFileTypes: true }).find(e => e.name === path.split(/[\\/]/).at(-1))
  if (entry?.isDirectory()) return readdirSync(path).sort().flatMap(name => files(join(path, name)))
  return [path]
}
export function sourceFingerprint(root) {
  const hash = createHash('sha256').update(`launcher-v2|${process.platform}|${process.arch}|node-${process.versions.node.split('.')[0]}`)
  for (const path of [...sourcePaths, ...startupPaths].flatMap(name => files(join(root, name))).sort()) {
    hash.update(relative(root, path)); hash.update('\0'); hash.update(readFileSync(path)); hash.update('\0')
  }
  return hash.digest('hex')
}
export function cacheBase(root) {
  const base = process.env.TEXHORU_CACHE_DIR || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'TEXHORU', 'cache') : join(homedir(), '.cache', 'TEXHORU'))
  return join(base, projectId(root))
}
export function databasePath(root, value) {
  const raw = value || 'file:./dev-local.db'
  if (!raw.startsWith('file:') || raw.includes('?')) throw new Error('Этот запуск рассчитан на локальную SQLite-базу. Для другой базы нужна отдельная настройка.')
  const path = raw.slice(5)
  if (!path) throw new Error('Пустой путь базы данных')
  return resolve(root, 'server', 'prisma', path)
}
export function copyApplication(root, target) {
  mkdirSync(target, { recursive: true })
  for (const item of sourcePaths) {
    const dst = join(target, item); mkdirSync(dirname(dst), { recursive: true })
    cpSync(join(root, item), dst, { recursive: true })
  }
}
export function backupData(root, db, stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
  const destination = join(root, 'backups', `automatic-${stamp}`)
  mkdirSync(destination, { recursive: true })
  for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(db + suffix)) cpSync(db + suffix, join(destination, 'database.db' + suffix))
  const env = join(root, 'server', '.env.local')
  if (existsSync(env)) cpSync(env, join(destination, '.env.local'))
  const uploads = join(root, 'server', 'uploads')
  if (existsSync(uploads)) cpSync(uploads, join(destination, 'uploads'), { recursive: true })
  return destination
}
export function npmCommand(args) {
  const bin = dirname(process.execPath)
  const candidates = [process.env.TEXHORU_NPM_CLI, join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), resolve(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), resolve(bin, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')].filter(Boolean)
  for (const file of candidates) if (existsSync(file)) return { command: process.execPath, args: [file, ...args] }
  if (process.platform === 'win32') return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `npm ${args.join(' ')}`] }
  return { command: 'npm', args }
}
export async function run(command, args, cwd, env, logFile, signal) {
  const fd = openSync(logFile, 'a')
  try {
    await new Promise((done, fail) => {
      const child = spawn(command, args, { cwd, env, signal, stdio: ['ignore', fd, fd], windowsHide: true })
      child.once('error', fail)
      child.once('exit', (code, signal) => code === 0 ? done() : fail(new Error(`Подготовка остановилась (${signal || code}). Подробности: ${logFile}`)))
    })
  } finally { closeSync(fd) }
}
export async function prepareRuntime(root, logFile, report = console.log, signal) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Нужен Node.js 22 или новее. Запускай TEXHORU.exe: он подготовит Node.js автоматически.')
  const state = join(root, '.texhoru'); mkdirSync(state, { recursive: true })
  const envFile = join(root, 'server', '.env.local')
  if (!existsSync(envFile)) cpSync(join(root, 'server', '.env.example'), envFile)
  process.loadEnvFile(envFile)
  const db = databasePath(root, process.env.DATABASE_URL)
  const originalUploads = resolve(root, 'server', 'uploads')
  mkdirSync(join(originalUploads, 'products'), { recursive: true }); mkdirSync(join(originalUploads, 'promos'), { recursive: true })
  const fingerprint = sourceFingerprint(root)
  const base = cacheBase(root); mkdirSync(base, { recursive: true })
  const pointer = join(base, `${fingerprint}.json`)
  let runtime
  if (existsSync(pointer)) {
    try {
      const saved = JSON.parse(readFileSync(pointer, 'utf8'))
      const candidate = resolve(base, saved.directory)
      if (dirname(candidate) === base && saved.fingerprint === fingerprint && existsSync(join(candidate, 'complete.json')) && existsSync(join(candidate, 'server', 'dist', 'main.js')) && existsSync(join(candidate, 'node_modules', 'vite', 'bin', 'vite.js'))) runtime = candidate
    } catch {}
  }
  const childEnv = { ...process.env, NODE_ENV: 'development', DATABASE_URL: `file:${db.replace(/\\/g, '/')}`, TEXHORU_ENV_FILE: envFile, TEXHORU_UPLOADS_DIR: originalUploads,
    HOST: '127.0.0.1', PORT: '3000', SERVE_STOREFRONT: 'false', FRONTEND_ORIGIN: 'http://127.0.0.1:5173', FRONTEND_PUBLIC_URL: 'http://127.0.0.1:5173', TEXHORU_PROJECT_ID: projectId(root), TEXHORU_APP_FINGERPRINT: fingerprint }
  const npm = async (args, cwd, env = childEnv) => { signal?.throwIfAborted(); const call = npmCommand(args); await run(call.command, call.args, cwd, env, logFile, signal) }
  if (!runtime) {
    // npm ci only sees a freshly created directory outside OneDrive. Never erase the user's node_modules.
    runtime = join(base, `app-${fingerprint.slice(0, 12)}-${randomUUID()}`)
    report('Первый запуск этой версии: готовлю приложение. Это может занять несколько минут…')
    copyApplication(root, runtime)
    await npm(['ci', '--no-audit', '--no-fund'], runtime)
    await npm(['ci', '--no-audit', '--no-fund'], join(runtime, 'server'))
    await npm(['run', 'prisma:local:generate'], join(runtime, 'server'))
    await npm(['run', 'build'], join(runtime, 'server'))
    writeFileSync(join(runtime, 'complete.json'), JSON.stringify({ fingerprint }))
    writeFileSync(pointer + '.tmp', JSON.stringify({ directory: relative(base, runtime), fingerprint }))
    renameSync(pointer + '.tmp', pointer)
  }
  const schemaHash = digest(readFileSync(join(root, 'server', 'prisma', 'schema.local.prisma')))
  const dbState = join(state, 'database-prepared.json')
  let prepared
  try { prepared = JSON.parse(readFileSync(dbState, 'utf8')) } catch {}
  const fresh = !existsSync(db) || readFileSync(db).length === 0
  const needsSeed = fresh || prepared?.needsSeed === true
  if (fresh || prepared?.schemaHash !== schemaHash || prepared?.database !== db) {
    if (!fresh) { report('Сохраняю резервную копию базы и фотографий…'); backupData(root, db) }
    report('Подготавливаю базу данных…')
    mkdirSync(dirname(db), { recursive: true })
    if (!existsSync(db)) writeFileSync(db, '')
    // Data-loss warnings stop preparation. No reset, force or accept-data-loss flag is permitted.
    writeFileSync(dbState, JSON.stringify({ database: db, needsSeed }))
    await npm(['run', 'prisma:local:push', '--', '--skip-generate'], join(runtime, 'server'))
    if (needsSeed) await npm(['run', 'prisma:seed'], join(runtime, 'server'))
    writeFileSync(dbState, JSON.stringify({ schemaHash, database: db }))
  }
  // Prefer the Microsoft Edge already installed on Windows. Playwright launches
  // it headlessly with a temporary isolated profile; the employee's normal
  // Edge profile is never opened. Do not download a second browser at startup.
  const hasBrowser = () => new Promise(done => {
    const script = [
      "const {chromium}=require('playwright');",
      "(async()=>{",
      "const candidates=process.platform==='win32'?[{channel:'msedge'},{}]:[{}];",
      "for(const options of candidates){let browser;try{browser=await chromium.launch({headless:true,...options});await browser.close();process.exit(0);return}catch{}finally{if(browser)await browser.close().catch(()=>{})}}",
      "process.exit(1)",
      "})()",
    ].join('')
    const check = spawn(process.execPath, ['-e', script], { cwd: join(runtime, 'server'), env: childEnv, stdio: 'ignore', windowsHide: true })
    check.once('error', () => done(false)); check.once('exit', code => done(code === 0))
  })
  const browserCheck = await hasBrowser()
  if (!browserCheck) report(process.platform === 'win32'
    ? 'Парсер 05.ru отключён: не найден Microsoft Edge. Установи Edge, затем перезапусти TEXHORU.'
    : 'Парсер 05.ru отключён: не найден установленный браузер Playwright Chromium. Сам магазин продолжит работу.')
  return { runtime, env: childEnv, fingerprint, projectId: projectId(root), launchFingerprint: digest(fingerprint + digest(readFileSync(envFile))) }
}
