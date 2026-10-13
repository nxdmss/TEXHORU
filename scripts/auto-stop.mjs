import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopSession } from './session-control.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
try { console.log(await stopSession(root) ? 'TEXHORU остановлен.' : 'Нового запуска TEXHORU нет. Если открыто старое окно запуска — закрой его.') }
catch (error) { console.error(error.message); process.exitCode = 1 }
