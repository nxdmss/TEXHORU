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
  'onec/agent/README.md',
  'onec/monitoring/UT103-PILOT-README.md',
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

// All/selected price-update behaviour is exercised by tests/price-demo.browser.mjs
// and the backend workflow suite, rather than assertions about function names.

test('Windows agent is scheduled, skips an empty queue and accepts TEST only', () => {
  const installer = read('onec/agent/Install-TEXHORUAgent.ps1')
  const runner = read('onec/agent/Run-TEXHORUAgent.ps1')
  const bsl = read('onec/monitoring/UT103-PilotRetailPrices-FormModule.bsl')
  const controller = read('server/src/integrations/integrations.controller.ts')
  const policy = read('server/src/integrations/test-catalog-policy.ts')
  const env = read('server/.env.example')

  assert.match(installer, /ПОДТВЕРЖДАЮ ТЕСТ/)
  assert.match(installer, /New-TimeSpan -Minutes 2/)
  assert.match(installer, /LogonType Interactive/)
  assert.match(runner, /Local\\TEXHORU_TEST_1C_AGENT/)
  assert.match(runner, /if \(\$items\.Count -eq 0\)/)
  assert.match(runner, /BaseKind -ne 'TEST'/)
  assert.match(runner, /agent-runtime-/)
  assert.match(bsl, /ПараметрЗапуска/)
  assert.match(bsl, /ПилотТЕХОРУПрименитьОднуЦену\(/)
  assert.match(bsl, /Функция ПилотТЕХОРУПолучитьЦеныДляАгента\(/)
  assert.match(bsl, /Результат = ПилотТЕХОРУПолучитьЦеныДляАгента\(/)
  assert.doesNotMatch(bsl, /Функция ПилотТЕХОРУПолучитьЦены\(/)
  assert.doesNotMatch(bsl, /^\s*&На/m)
  assert.match(bsl, /ЗавершитьРаботуСистемы\(Ложь\)/)
  assert.match(bsl, /НазваниеБазы/)
  assert.match(controller, /if \(!priceSyncEnabled\(\)\)/)
  assert.match(policy, /ONE_C_TEST_PRICE_SYNC_ENABLED/)
  assert.match(policy, /ONE_C_PRODUCTION_PRICE_SYNC_ENABLED/)
  assert.match(policy, /ONE_C_PRODUCTION_BASE_ID/)
  assert.match(env, /ONE_C_TEST_PRICE_SYNC_ENABLED=false/)
  assert.match(env, /ONE_C_PRODUCTION_PRICE_SYNC_ENABLED=false/)
})
