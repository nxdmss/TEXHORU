import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = join(root, 'server')

function npmInvocation(args) {
  if (process.platform === 'win32') {
    // Node 24 no longer reliably spawns .cmd files directly on Windows.
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `npm ${args.join(' ')}`],
    }
  }
  return { command: 'npm', args }
}

function run(args, cwd, extraEnv = {}) {
  const invocation = npmInvocation(args)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  if (result.error) {
    console.error(`Не удалось запустить npm: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const envExample = join(server, '.env.example')
const envLocal = join(server, '.env.local')
if (!existsSync(envLocal)) {
  cpSync(envExample, envLocal)
  console.log('Создан server/.env.local из безопасного шаблона.')
}

mkdirSync(join(server, 'uploads', 'products'), { recursive: true })
mkdirSync(join(server, 'uploads', 'promos'), { recursive: true })

console.log('\n[1/6] Frontend dependencies')
run(['install'], root)
console.log('\n[2/6] Backend dependencies')
run(['install'], server)
console.log('\n[3/6] Chromium for price monitor')
run(['exec', '--', 'playwright', 'install', 'chromium'], server)
console.log('\n[4/6] Prisma client')
run(['run', 'prisma:local:generate'], server, { DATABASE_URL: 'file:./dev-local.db' })
console.log('\n[5/6] SQLite schema')
run(['run', 'prisma:local:push'], server, { DATABASE_URL: 'file:./dev-local.db' })
console.log('\n[6/6] Admin + base content')
run(['run', 'prisma:seed'], server, {
  DATABASE_URL: 'file:./dev-local.db',
  TEXHORU_ENV_FILE: '.env.local',
})

console.log('\nTEXHORU готов. Запуск: npm run dev')
