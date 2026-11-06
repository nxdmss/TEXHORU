import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const docs = [
  'README.md',
  'CONTRIBUTING.md',
  'docs/README.md',
  'docs/как-работать-с-ценами.md',
  'docs/передача-разработчику.md',
]
const read = (path) => readFileSync(resolve(root, path), 'utf8')

test('Главные инструкции существуют и ссылки между ними работают', () => {
  for (const path of docs) {
    const text = read(path)
    assert.match(text, /^# /, path + ': нужен понятный заголовок')
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0]
      if (!target || /^https?:\/\//.test(target)) continue
      const destination = resolve(root, dirname(path), decodeURIComponent(target))
      assert.ok(existsSync(destination), path + ': ссылка ведёт в отсутствующий файл ' + target)
    }
  }
})

test('У карточек цен нет обходной кнопки массового изменения', () => {
  const links = read('src/PriceMonitorPanel.tsx')
  assert.doesNotMatch(links, /monitorBulkApply|updateAllPrices/)
  assert.doesNotMatch(links, /Применить цены 05\.ru к товарам/)
})

test('Цены отправляются из экрана выбора, с подтверждением и списком товаров', () => {
  const approval = read('src/PriceApprovalDashboard.tsx')
  assert.match(approval, /async function sendSelected\(\)/)
  assert.match(approval, /window\.confirm/)
  assert.match(approval, /ids:\s*chosen\.map\(item => item\.id\)/)
  assert.match(approval, /await api\.monitorBulkApply\(/)
})

test('В интерфейсе понятно, что данные 05.ru не отправляются сами', () => {
  const approval = read('src/PriceApprovalDashboard.tsx')
  assert.match(approval, /Отправить выбранные в 1С/)
  assert.match(approval, /после ответа 1С/)
  assert.match(approval, /Связи с 05\.ru/)
})
