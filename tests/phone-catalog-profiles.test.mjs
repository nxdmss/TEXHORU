import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/phone-catalog-profiles.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const module = { exports: {} }
vm.runInNewContext(js, { module, exports: module.exports })
const { phoneCatalogProfile } = module.exports

const currentPhones = [
  'Смартфон Apple iPhone 15 128 Гб черный', 'Apple iPhone 11 64Gb Black АКБ 75%',
  'Смартфон Apple iPhone 16 128 Гб белый', 'Смартфон Honor 600 5G 8/256Gb черный',
  'Смартфон HONOR X9d 8/256Gb RU, Мятный', 'Смартфон Honor 600 Pro 12+512 ГБ золотой',
  'Смартфон Honor X7e 6+256 ГБ голубой', 'Смартфон HONOR X5eS 4/64 ГБ черный',
  'Смартфон Huawei Nova 15 Max 256Gb 8Gb розовый', 'Смартфон Samsung Galaxy S25 Ultra 12/256 Гб Titanium Black',
  'Смартфон Samsung Galaxy S25 12/256 Гб Серый', 'Смартфон Samsung Galaxy A17 6/128 Гб черный',
  'Смартфон Samsung Galaxy S26 Ultra 12 Гб/256 Гб черный', 'Смартфон Samsung Galaxy S26 12/512 Гб черный',
  'Смартфон POCO F8 Pro 12/512 Гб черный', 'Смартфон POCO M8 5G 8/256 ГБ, зеленый',
  'Смартфон POCO X8 Pro Max 12/256 ГБ, черный', 'Смартфон Xiaomi 15T Pro 12/256 ГБ черный',
  'Смартфон Xiaomi 17T 12/512Gb черный', 'Смартфон POCO X8 Pro 12/512 ГБ, белый',
  'Смартфон POCO F8 Ultra 12/256 Гб черный', 'Смартфон Xiaomi 17T Pro 12/256Gb черный',
  'Смартфон Realme 16 Pro 12 Гб/512 Гб графитовый', 'Смартфон Realme C100x 4/256GB Синий',
  'Смартфон Tecno CAMON 50 Ultra 256 ГБ черный', 'Смартфон Google Pixel 11 Pro 12/256Gb CA, Obsidian (черный)',
]

test('every current smartphone model receives useful sourced characteristics', () => {
  for (const name of currentPhones) {
    const profile = phoneCatalogProfile(name)
    assert(profile, name)
    assert(profile.shortSpec.length > 20, name)
    assert(profile.description.length > 40, name)
    assert(profile.specs.length >= 6, name)
    assert(profile.specs.some(spec => spec.label === 'Экран'), name)
    assert(profile.specs.some(spec => spec.label === 'Процессор'), name)
    assert(profile.specs.some(spec => spec.label === 'Аккумулятор'), name)
  }
})

test('variant memory comes from the exact 1C product name', () => {
  assert.equal(phoneCatalogProfile('Смартфон POCO F8 Ultra 12/256 Гб черный').specs.find(x => x.label === 'Память').value, '12 ГБ ОЗУ / 256 ГБ')
  assert.equal(phoneCatalogProfile('Смартфон Samsung Galaxy S26 Ultra 12 Гб/512 Гб черный').specs.find(x => x.label === 'Память').value, '12 ГБ ОЗУ / 512 ГБ')
  assert.equal(phoneCatalogProfile('Смартфон Apple iPhone 15 128 Гб черный').specs.find(x => x.label === 'Память').value, '128 ГБ')
})
