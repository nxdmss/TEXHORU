import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = join(root, 'server')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(args, cwd, extraEnv = {}) {
  const result = spawnSync(npm, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
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

console.log('\n[1/5] Frontend dependencies')
run(['install'], root)
console.log('\n[2/5] Backend dependencies')
run(['install'], server)
console.log('\n[3/5] Prisma client')
run(['run', 'prisma:local:generate'], server, { DATABASE_URL: 'file:./dev-local.db' })
console.log('\n[4/5] SQLite schema')
run(['run', 'prisma:local:push'], server, { DATABASE_URL: 'file:./dev-local.db' })
console.log('\n[5/5] Admin + base content')
run(['run', 'prisma:seed'], server, {
  DATABASE_URL: 'file:./dev-local.db',
  TEXHORU_ENV_FILE: '.env.local',
})

console.log('\nTEXHORU готов. Запуск: npm run dev')
