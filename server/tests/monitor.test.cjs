const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { writeFileSync, unlinkSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { PrismaClient } = require('@prisma/client')
const { chromium } = require('playwright')
const { compareItems, identity, fingerprint, validGtin, recommendation, reviewCandidate, manualConfirmationBlockers, canonicalModel, canonicalStorageCapacity } = require('../dist/price-monitor/product-matching')
const { extractFiveRu, fiveRuUrl, priceNumber, FiveRuParser } = require('../dist/price-monitor/five-ru.parser')
const { PriceMonitorService, oneCSearchQueries, isExpectedReviewOutcome } = require('../dist/price-monitor/price-monitor.service')
const { MatchingEngine } = require('../dist/price-monitor/matching-engine')
const { ProductsService } = require('../dist/products/products.service')
const { MonitorExchangeService } = require('../dist/price-monitor/monitor-exchange.service')
const { IntegrationsService } = require('../dist/integrations/integrations.service')
const { OneCPriceSyncService } = require('../dist/integrations/price-sync.service')
const { rankSearchLinks, rankSearchLinksForInspection } = require('../dist/price-monitor/search-discovery')
const { canDeclareNoMatch } = require('../dist/price-monitor/match-outcome')
const { DnsParser, MvideoParser, storeKeyFromUrl, extractRetailerProduct } = require('../dist/price-monitor/storefront-adapter')
const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/05ru-iphone17pro.json'), 'utf8'))
const name = fixture.snapshot.h1
const product = { name: 'Apple iPhone 17 Pro 12GB/256GB Cosmic Orange eSIM', brand: 'Apple' }
const url = fixture.sourceUrl
let prisma
let database
before(async () => {
  database = resolve(__dirname, `../prisma/monitor-test-${randomUUID()}.db`)
  writeFileSync(database, '')
  const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--schema=prisma/schema.local.prisma', '--skip-generate'], { cwd: resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: `file:${database.replace(/\\/g, '/')}` }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  prisma = new PrismaClient({ datasources: { db: { url: `file:${database.replace(/\\/g, '/')}` } } })
  await prisma.$connect()
})
after(async () => {
  await prisma?.$disconnect()
  for (const suffix of ['', '-wal', '-shm', '-journal']) { try { unlinkSync(database + suffix) } catch {} }
})

test('Identifies Apple variants across Russian/English; flags memory, colour, SIM and condition conflicts', () => {
  const same = compareItems(product, { name })
  assert.equal(same.conflicts.length, 0)
  assert.equal(same.ours.storage, '256')
  assert.equal(same.theirs.ram, '12')
  assert.equal(same.theirs.sim, 'esim')
  assert(same.score >= 20)
  assert(same.reasons.includes("модель") && same.reasons.includes("память") && same.reasons.includes("цвет") && same.reasons.includes("SIM"))
  for (const wrong of [name.replace('256', '512'), name.replace('оранжевый', 'синий'), name.replace('E-Sim', 'nano SIM'), name + ' восстановленный']) assert.equal(compareItems(product, { name: wrong }).score, 0)
  assert.notEqual(identity({ name: 'Samsung Galaxy S25+' }).model, identity({ name: 'Samsung Galaxy S25' }).model)
  assert.equal(identity({ name: 'Айфон 17 ПМ 256 оранж eSIM' }).model, 'iphone 17 pro max')
})

test('iPhone 17 Lavender matches Russian purple and pink aliases only for the base model', () => {
  const ours = { name: 'Смартфон Apple iPhone 17 256 ГБ лавандовый', brand: 'Apple' }
  const purple = { name: 'Смартфон Apple iPhone 17 8 Гб/256 Гб фиолетовый (без RuStore)', brand: 'Apple' }
  const pink = { name: 'Смартфон Apple iPhone 17 8 Гб/256 Гб розовый (E-Sim, без RuStore)', brand: 'Apple' }
  const lavender = { name: 'Apple iPhone 17 Lavender 256GB', brand: 'Apple' }
  for (const candidate of [purple, pink, lavender]) {
    const compared = compareItems(ours, candidate)
    assert.equal(compared.ours.color, 'lavender')
    assert.equal(compared.theirs.color, 'lavender')
    assert.equal(compared.canAutoConfirm, true, JSON.stringify(compared))
    assert.deepEqual(compared.conflicts, [])
  }
  assert.deepEqual(oneCSearchQueries(ours), [
    'apple iphone 17 256 розовый', 'apple iphone 17 256 фиолетовый',
    'iphone 17 256', 'iphone 17',
  ])
  assert.equal(identity({ name: 'Apple iPhone 17 Pro 256 ГБ розовый' }).color, 'pink')
  assert.equal(identity({ name: 'Apple iPhone 17 Pro 256 ГБ фиолетовый' }).color, 'purple')
  assert.equal(identity({ name: 'Apple iPhone 16 256 ГБ розовый' }).color, 'pink')
  assert.equal(identity({ name: 'Apple iPhone 17e 256 ГБ розовый' }).color, 'pink')
  assert.equal(compareItems(ours, { name: 'iPhone 17 256 Гб синий', brand: 'Apple' }).canAutoConfirm, false)
  assert.equal(compareItems(ours, { name: 'iPhone 17 Pro 256 Гб фиолетовый', brand: 'Apple' }).canAutoConfirm, false)
  assert.equal(compareItems(ours, { name: 'iPhone 17 512 Гб фиолетовый', brand: 'Apple' }).canAutoConfirm, false)
  assert.equal(compareItems(ours, { name: 'iPhone 17 256 Гб фиолетовый Б/У', brand: 'Apple' }).canAutoConfirm, false)
  const cardWithAttrs = { name: 'iPhone 17 Lavender 256GB', brand: 'Apple', attributes: { color: 'pink' } }
  assert.equal(compareItems(ours, cardWithAttrs).canAutoConfirm, true)
})

test('Old 05.ru index resolves iPhone 17 Lavender across pink/purple SIM listings', async () => {
  const id = randomUUID(), categoryId = randomUUID()
  const categoryPath = 'LAVENDER INDEX ' + id
  const productName = 'Смартфон Apple iPhone 17 256 ГБ лавандовый'
  const variants = [
    { url: 'https://05.ru/cat/396f7486/p/iphone17-lavender-purple-' + id + '/', title: 'Смартфон Apple iPhone 17 8 Гб/256 Гб фиолетовый', price: 70990 },
    { url: 'https://05.ru/cat/396f7486/p/iphone17-lavender-pink-esim-' + id + '/', title: 'Смартфон Apple iPhone 17 8 Гб/256 Гб розовый (E-Sim)', price: 73990 },
  ]
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: categoryId, name: categoryPath, slug: 'lavender-index-' + categoryId }],
    products: [{ oneCId: id, sku: 'LAVENDER-' + id, slug: 'lavender-' + id,
      name: productName, brand: 'Apple', categoryOneCId: categoryId, price: 84900, stockQty: 1 }],
  })
  // Simulate the pre-fix persisted index: Russian colour synonyms were not
  // canonicalized. The new comparison normalizes TITLES, not old index rows.
  for (const variant of variants) {
    await prisma.competitorCatalogEntry.create({
      data: { externalUrl: variant.url, title: variant.title,
        model: 'iphone 17', storage: '256',
        color: variant.title.includes('фиолетовый') ? 'purple' : 'pink', lastSeenAt: new Date() },
    })
  }
  const opened = []
  const results = new Map(variants.map(variant => [variant.url, {
    url: variant.url, name: variant.title, brand: 'Apple',
    attributes: identity({ name: variant.title, brand: 'Apple' }),
    categoryName: 'Смартфоны', price: variant.price, inStock: true, seller: '05.ru',
  }]))
  const parser = {
    parse: async url => { opened.push(url); return results.get(url) },
    searchProducts: async () => { throw new Error('Index should find the verified variant before live search') },
  }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const job = await monitor.autoFindOneCSection({ categoryPath, maxItems: 1 })
  await monitor.tick()
  const completed = await prisma.monitorJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(completed.status, 'COMPLETED')
  assert.equal(completed.errors, 0, completed.lastError || '')
  assert.equal(completed.processed, 1)
  assert(opened.includes(variants[0].url))
  assert(opened.includes(variants[1].url))
  const product = await prisma.product.findUniqueOrThrow({ where: { oneCId: id } })
  const linked = await prisma.competitorProduct.findMany({
    where: { source: { key: '05ru' }, productId: product.id, matchStatus: 'SUGGESTED' },
  })
  // A source with both unspecified and eSIM variants does not justify
  // selecting one for an unqualified 1C item.
  assert.equal(linked.length, 1)
  assert(variants.some(variant => variant.url === linked[0].externalUrl))
  assert.equal(product.price, 84900)
})

test('iPhone 17 Air in 1C safely matches the officially named iPhone Air on 05.ru', () => {
  const oursWhite = { name: 'Смартфон Apple iPhone 17 Air 256 Гб белый', brand: 'Apple' }
  const oursBlack = { name: 'Смартфон Apple iPhone 17 Air 256 Гб черный', brand: 'Apple' }
  const airWhite = { name: 'Смартфон Apple iPhone Air 12 Гб/256 Гб белый (без RuStore)', brand: 'Apple' }
  const airBlack = { name: 'Смартфон Apple iPhone Air 12 Гб/256 Гб черный (без RuStore)', brand: 'Apple' }
  assert.equal(identity(oursWhite).model, 'iphone 17 air')
  assert.equal(identity(airWhite).model, 'iphone air')
  assert.equal(canonicalModel(identity(oursWhite).model), 'iphone air')
  assert.equal(canonicalModel(identity(airWhite).model), 'iphone air')
  assert.equal(compareItems(oursWhite, airWhite).canAutoConfirm, true)
  assert.equal(compareItems(oursBlack, airBlack).canAutoConfirm, true)
  assert.deepEqual(compareItems(oursBlack, airWhite).conflicts, ['цвет'])
  for (const wrong of [
    'Смартфон Apple iPhone 17 256 Гб белый',
    'Смартфон Apple iPhone 17 Pro 256 Гб белый',
    'Смартфон Apple iPhone 17 Pro Max 256 Гб белый',
    'Смартфон Apple iPhone Air 512 Гб белый',
    'Смартфон Apple iPhone Air 256 Гб белый Б/У',
  ]) {
    const compared = compareItems(oursWhite, { name: wrong, brand: 'Apple' })
    assert.equal(compared.canAutoConfirm, false, wrong)
    assert(compared.conflicts.length > 0, wrong)
  }
  assert.deepEqual(oneCSearchQueries(oursWhite), [
    'apple iphone air 256 белый', 'iphone air 256', 'iphone air', 'iphone 17 air 256',
  ])
  assert.deepEqual(oneCSearchQueries(oursBlack), [
    'apple iphone air 256 черный', 'iphone air 256', 'iphone air', 'iphone 17 air 256',
  ])
  const whiteUrl = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-air-12-gb-256-gb-beliy-bez-rustore-24234/'
  const regular = 'https://05.ru/cat/x/p/smartfon-apple-iphone-17-8-gb-256-gb-chernyy-111/'
  const pro = 'https://05.ru/cat/x/p/smartfon-apple-iphone-17-pro-256-gb-beliy-123/'
  const entries = [
    { url: regular, title: 'Смартфон Apple iPhone 17 256 Гб черный' },
    { url: pro, title: 'Смартфон Apple iPhone 17 Pro 256 Гб белый' },
    { url: whiteUrl, title: airWhite.name },
  ]
  assert.deepEqual(rankSearchLinks(entries, 'iphone air 256', 18), [whiteUrl])
  assert.deepEqual(rankSearchLinksForInspection(entries, 'iphone 17 air 256', 18), [whiteUrl])
})

test('Legacy 05.ru index with missing iPhone Air model still links a verified exact 1C variant', async () => {
  await prisma.monitorJob.updateMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() } })
  const id = randomUUID(), categoryId = randomUUID()
  const categoryPath = 'AIR ALIAS TEST ' + id
  const name = 'Смартфон Apple iPhone 17 Air 256 Гб белый'
  const url = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-air-12-gb-256-gb-beliy-bez-rustore-24234/'
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: categoryId, slug: 'air-test-' + categoryId, name: categoryPath }],
    products: [{ oneCId: id, slug: 'air-' + id, sku: 'AIR-' + id,
      name, brand: 'Apple', categoryOneCId: categoryId, price: 90000, stockQty: 2 }],
  })
  await prisma.competitorCatalogEntry.deleteMany({ where: { externalUrl: url } })
  await prisma.competitorCatalogEntry.create({
    data: { externalUrl: url,
      title: 'Смартфон Apple iPhone Air 12 Гб/256 Гб белый (без RuStore)',
      model: null, storage: '256', color: 'white', lastSeenAt: new Date() },
  })
  let parsedUrls = [], searched = 0
  const result = {
    ...extractFiveRu({
      ...fixture.snapshot,
      h1: 'Смартфон Apple iPhone Air 12 Гб/256 Гб белый (без RuStore)',
      scripts: [JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product',
        name: 'Смартфон Apple iPhone Air 12 Гб/256 Гб белый (без RuStore)',
        brand: { '@type': 'Brand', name: 'Apple' }, offers: { '@type': 'Offer',
          price: '99990', priceCurrency: 'RUB', availability: 'https://schema.org/InStock' } })],
      specs: [{ label: 'Цвет', value: 'белый' }],
    }, url), url,
  }
  const parser = {
    parse: async current => { parsedUrls.push(current); return result },
    searchProducts: async () => { searched++; return [] },
  }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const job = await monitor.autoFindOneCSection({ categoryPath, maxItems: 1 })
  await monitor.tick()
  const finished = await prisma.monitorJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(finished.status, 'COMPLETED')
  assert.equal(finished.processed, 1)
  assert.deepEqual(parsedUrls, [url])
  assert.equal(searched, 0)
  const link = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: url } })
  assert.equal(link.matchStatus, 'CONFIRMED')
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: id } })).price, 90000)
})

test('05.ru structured SIM counts override ambiguous E-Sim titles', () => {
  const baseName = 'Смартфон Apple iPhone 17 Pro 12 Гб/256 Гб синий (E-Sim, без RuStore)'
  const make = (physical, esim, type = 'eSIM') => {
    const snapshot = { ...fixture.snapshot, h1: baseName,
      specs: [
        { label: 'Количество физических SIM-карт', value: physical },
        { label: 'Количество eSIM', value: esim },
        { label: 'Тип SIM-карты', value: type },
      ],
    }
    return extractFiveRu(snapshot, url)
  }
  const esimOnly = make('нет', '1')
  assert.equal(esimOnly.attributes.sim, 'esim')
  assert.equal(esimOnly.attributes.physicalSimCount, '0')
  assert.equal(esimOnly.attributes.esimCount, '1')
  const hybrid = make('1', '1', 'nano-SIM, eSIM')
  assert.equal(hybrid.attributes.sim, 'physical+esim')
  assert.equal(hybrid.attributes.physicalSimCount, '1')
  assert.equal(hybrid.attributes.esimCount, '1')
  const hybridNamedEsim = make('1', '1', 'eSIM')
  assert.equal(hybridNamedEsim.attributes.sim, 'physical+esim')
  // E-Sim in an abbreviated marketing title does not contradict the detailed
  // evidence that this handset also has a nano SIM slot.
  const oursHybrid = { name: 'Смартфон Apple iPhone 17 Pro 256 Гб синий nano-SIM + eSIM' }
  const hybridCheck = compareItems(oursHybrid, hybrid)
  assert(!hybridCheck.conflicts.includes('SIM: название противоречит характеристикам'),
    JSON.stringify(hybridCheck))
  assert.equal(hybridCheck.canAutoConfirm, true)
  const oursEsim = { name: 'Смартфон Apple iPhone 17 Pro 256 Гб синий eSIM' }
  const forbidden = compareItems(oursEsim, hybrid)
  assert(forbidden.conflicts.includes('SIM'), JSON.stringify(forbidden))
  assert.equal(forbidden.canAutoConfirm, false)
  assert(manualConfirmationBlockers(oursEsim, hybrid).includes('SIM: конфигурация отличается'))
  const allowed = compareItems(oursEsim, esimOnly)
  assert.deepEqual(allowed.conflicts, [])
  assert.equal(allowed.canAutoConfirm, true)
  assert.equal(identity({ name: 'Смартфон Apple iPhone 17 Pro 256 синий SIM' }).sim, 'physical')
  assert.equal(identity({ name: 'Смартфон Apple iPhone 17 Pro 256 синий eSIM' }).sim, 'esim')
  assert.equal(identity({ name: 'Смартфон Apple iPhone 17 Pro 256 синий SIM + eSIM' }).sim, 'physical+esim')
  assert.equal(identity({ name: 'iPhone 17 Pro eSIM', specs: [
    { label: 'Количество физических SIM-карт', value: '2' },
    { label: 'Количество eSIM', value: '0' },
  ] }).sim, 'physical')
})

test('A missing SIM label does not block an otherwise exact phone variant; explicit SIM conflicts still block', () => {
  const ours = { name: 'Смартфон Apple iPhone 16 256 Гб черный', brand: 'Apple' }
  const listed = { name: 'Смартфон Apple iPhone 16 8 Гб/256 Гб черный (E-Sim, без RuStore)', brand: 'Apple' }
  assert.equal(identity(ours).storage, '256')
  assert.equal(identity(ours).ram, undefined)
  assert.equal(identity({ name: 'Смартфон Apple iPhone 12 128 Гб синий' }).ram, undefined)
  const same = compareItems(ours, listed)
  assert.deepEqual(same.conflicts, [])
  assert.equal(same.canAutoConfirm, true)

  const physical = compareItems({ ...ours, name: ours.name + ' nano SIM' }, listed)
  assert(physical.conflicts.includes('SIM'))
  assert.equal(physical.canAutoConfirm, false)
})

test('A unique laptop with exact model and complete hardware can be auto-confirmed', () => {
  const ours = { name: 'Ноутбук Apple MacBook Air 13 2025 M4 16/256GB Silver', brand: 'Apple' }
  const listed = { name: 'Ноутбук Apple MacBook Air 13 M4 16GB/256GB SSD Silver', brand: 'Apple' }
  const same = compareItems(ours, listed)
  assert.deepEqual(same.conflicts, [], JSON.stringify(same))
  assert.equal(same.canAutoConfirm, true)

  const wrongCpu = compareItems(ours, {
    name: 'Ноутбук Apple MacBook Air 13 M3 16GB/256GB SSD Silver', brand: 'Apple',
  })
  assert(wrongCpu.conflicts.includes('процессор'))
  assert.equal(wrongCpu.canAutoConfirm, false)
})

test('Xiaomi 1C 15T Pro safely matches identical 05.ru title, not 15T/15 Ultra or a different color', () => {
  const ours = { name: 'Смартфон Xiaomi 15T Pro  (EAC) 12/512 ГБ черный', brand: 'Xiaomi' }
  const fiveRu = { name: 'Смартфон Xiaomi 15T Pro 12 Гб/512 Гб черный', brand: 'Xiaomi',
    specs: [
      { label: 'Количество цветов экрана', value: '68 млрд цветов, голубой оттенок' },
      { label: 'Цветовая температура', value: 'Blue' },
      { label: 'Цвет', value: 'черный' },
    ] }
  assert.equal(identity(ours).model, 'xiaomi 15t pro')
  assert.equal(identity(fiveRu).model, 'xiaomi 15t pro')
  assert.equal(identity(ours).storage, '512')
  assert.equal(identity(ours).ram, '12')
  assert.equal(identity(fiveRu).color, 'black')
  const matched = compareItems(ours, fiveRu)
  assert.deepEqual(matched.conflicts, [])
  assert(matched.score >= 55, JSON.stringify(matched))
  for (const other of ['Xiaomi 15T 12 Гб/512 Гб черный',
    'Xiaomi 15 Ultra 12 Гб/512 Гб черный',
    'Xiaomi 15 12 Гб/512 Гб черный',
    'Xiaomi 15T Pro 12 Гб/512 Гб серый',
    'Xiaomi 15T Pro 12 Гб/256 Гб черный']) {
    const checked = compareItems(ours, { name: other, brand: 'Xiaomi' })
    assert(checked.conflicts.length, other + ': ' + JSON.stringify(checked))
    assert.equal(checked.score, 0)
  }
  // An actual contradiction in a dedicated "Цвет" specification is still blocked.
  assert(compareItems(ours, { ...fiveRu, specs: [{ label: 'Цвет', value: 'серый' }] }).conflicts.length > 0)
  assert.equal(identity({ name: 'Xiaomi 15T Pro (EAC) 12/512' }).storage, '512')
  assert.deepEqual(oneCSearchQueries(ours), [
    'xiaomi 15t pro 512 черный', 'xiaomi 15t pro 512', 'xiaomi 15t pro',
  ])
  assert.deepEqual(oneCSearchQueries({ name: 'Смартфон Apple iPhone 17 Pro 256 Гб' }), ['iphone 17 pro 256', 'iphone 17 pro'])
  assert.equal(identity({ name: 'Смартфон Samsung Galaxy S25 Ultra 12/256 черный' }).storage, '256')
  assert.deepEqual(oneCSearchQueries({ name: 'Смартфон Samsung Galaxy S25 Ultra 12/256 черный' }), [
    'samsung galaxy s25 ultra 256 черный', 'samsung galaxy s25 ultra 256', 'samsung galaxy s25 ultra',
  ])
})


test('Counts only technical failures as errors; ordinary no-match outcomes require review', () => {
  assert.equal(isExpectedReviewOutcome('05.ru: нет подтверждённого совпадения для Смарт-часы Mibro XPAW002'), true)
  assert.equal(isExpectedReviewOutcome('05.ru: несколько близких совпадений для товара'), true)
  assert.equal(isExpectedReviewOutcome('Карточка 05.ru уже связана с другим товаром'), true)
  assert.equal(isExpectedReviewOutcome('Автопоиск 05.ru: Прямой поиск открылся, но не отдал ссылки'), false)
  assert.equal(isExpectedReviewOutcome('Поиск 05.ru нашёл 12 ссылок, но карточки не прочитаны'), false)
})

test('Recognizes smartwatch model codes and keeps accessory searches separate from phones', () => {
  const mibro = { name: 'Смарт-часы Mibro XPAW002', brand: 'Mibro', category: 'Смарт-часы' }
  const tecno = { name: 'Смарт-часы TECNO Watch 3 Active', brand: 'TECNO', category: 'Смарт-часы' }
  const amazfit = { name: 'Умные часы Amazfit Active 2R', brand: 'Amazfit', category: 'Умные часы' }
  const generic = { name: 'Умные часы C60 Gold Frame White Silicone Strap', category: 'Смарт-часы' }
  assert.equal(identity(mibro).model, 'xpaw002')
  assert.equal(identity(mibro).brand, 'mibro')
  assert.equal(identity(mibro).kind, 'smartwatch')
  assert.equal(identity(tecno).model, 'watch 3 active')
  assert.equal(identity(amazfit).model, 'active 2r')
  assert.equal(identity(generic).model, 'c60')
  assert.deepEqual(oneCSearchQueries(mibro), ['mibro xpaw002', 'Смарт-часы Mibro XPAW002'])

  const caseItem = { name: 'Накладка силиконовая Green Lion Case for iPhone 15 Pro Max', brand: 'Green Lion', category: 'Аксессуары / Чехлы' }
  const phoneItem = { name: 'Смартфон Apple iPhone 15 Pro Max 256 Гб', brand: 'Apple', category: 'Смартфоны' }
  assert.equal(identity(caseItem).kind, 'case')
  assert.equal(identity(caseItem).brand, 'green lion')
  assert(compareItems(caseItem, phoneItem).conflicts.includes('тип товара'))
  assert.deepEqual(oneCSearchQueries(caseItem), [
    'green lion чехол iphone 15 pro max',
    'чехол iphone 15 pro max',
    'Накладка силиконовая Green Lion Case for iPhone 15 Pro Max',
  ])
  const caseUrl = 'https://05.ru/cat/x/p/chehol-green-lion-iphone-15-pro-max-123/'
  const phoneUrl = 'https://05.ru/cat/x/p/smartfon-apple-iphone-15-pro-max-256-456/'
  assert.deepEqual(rankSearchLinks([
    { url: phoneUrl, title: 'Смартфон Apple iPhone 15 Pro Max 256 Гб' },
    { url: caseUrl, title: 'Чехол Green Lion для iPhone 15 Pro Max' },
  ], 'green lion чехол iphone 15 pro max', 10), [caseUrl])
  assert.equal(fingerprint({ name: 'Xiaomi 15T Pro' }), fingerprint({ name: 'Xiaomi 15T Pro', category: 'Смартфоны' }))
  const partialTitleUrl = 'https://05.ru/cat/x/p/smart-watch-mibro-123/'
  assert.deepEqual(rankSearchLinks([
    { url: partialTitleUrl, title: 'Смарт-часы Mibro' },
  ], 'mibro xpaw002', 12), [partialTitleUrl])
  assert.deepEqual(oneCSearchQueries({ name: 'Смартфон Xiaomi 15T Pro 12/512' }), [
    'xiaomi 15t pro 512', 'xiaomi 15t pro',
  ])
  assert.deepEqual(oneCSearchQueries({ name: 'Смартфон Apple iPhone 13 128 Гб синий' }), [
    'apple iphone 13 128 синий', 'iphone 13 128', 'iphone 13',
  ])
  assert.deepEqual(oneCSearchQueries({ name: 'Смартфон Apple iPhone 16e 128 Гб черный' }), [
    'apple iphone 16 e 128 черный', 'apple iphone 16e 128 черный',
    'iphone 16 e 128', 'iphone 16e 128', 'iphone 16 e', 'iphone 16e',
  ])
})

test('Accessory compatibility is separate from manufacturer and watch housings are not misclassified as cases', () => {
  const samsungCase = { name: 'Чехол Samsung A55 Карбон', brand: 'Samsung', category: 'Аксессуары / Чехлы' }
  const uniqCase = { name: 'Чехол Uniq для Samsung Galaxy A55 Carbon', brand: 'Uniq', category: 'Чехлы' }
  assert.equal(identity(samsungCase).brand, 'samsung')
  assert.equal(identity(samsungCase).compatibleBrand, 'samsung')
  assert.equal(identity(uniqCase).brand, 'uniq')
  assert.equal(identity(uniqCase).compatibleBrand, 'samsung')
  const comparison = compareItems(samsungCase, uniqCase)
  assert.deepEqual(comparison.conflicts, [], JSON.stringify(comparison))
  assert(comparison.reasons.includes('совместимость'))
  assert.deepEqual(oneCSearchQueries(samsungCase), [
    'samsung чехол a55',
    'чехол a55',
    'Чехол Samsung A55 Карбон',
  ])
  const caseUrl = 'https://05.ru/cat/cases/p/uniq-samsung-a55-carbon-123/'
  assert.deepEqual(rankSearchLinks([
    { url: caseUrl, title: uniqCase.name },
  ], 'samsung чехол a55'), [caseUrl])

  const watch = {
    name: 'Смарт-часы Xiaomi Watch 2 Black Case With Black TPU Strap M2320W1 (BHR8035GL)',
    brand: 'Xiaomi', category: 'Смарт-часы',
  }
  assert.equal(identity(watch).kind, 'smartwatch')
  assert.equal(identity(watch).model, 'watch 2')
  assert.deepEqual(oneCSearchQueries(watch), [
    'xiaomi watch 2',
    watch.name,
  ])
  assert.equal(identity({ name: 'Чехол P09 чёрный', category: 'Чехлы' }).model, undefined)
  assert.equal(identity({ name: 'Зарядное устройство P09' }).model, 'p09')
  assert.equal(identity({ name: 'Чехол для iPhone 12 прозрачный' }).color, 'transparent')
})

test('Soft matching suggests plausible non-phone variants without accepting wrong models', () => {
  const ours = { name: 'СЗУ Breaking P09 USB-C GaN 25W белый', brand: 'Breaking' }
  const missingColor = { name: 'Зарядное устройство Breaking P09 USB-C GaN 25W', brand: 'Breaking' }
  const wrongModel = { name: 'Зарядное устройство Breaking P10 USB-C GaN 25W', brand: 'Breaking' }
  const wrongKind = { name: 'Кабель Breaking P09 USB-C GaN 25W', brand: 'Breaking' }
  assert.equal(identity(ours).kind, 'charger')
  assert.equal(identity(missingColor).kind, 'charger')
  assert(reviewCandidate(ours, missingColor)?.score >= 20)
  assert.equal(compareItems(ours, missingColor).canAutoConfirm, false)
  assert.equal(reviewCandidate(ours, wrongModel), null)
  assert.equal(reviewCandidate(ours, wrongKind), null)
  const charger25 = { name: 'Зарядное устройство Breaking P09 USB-C GaN 25W', brand: 'Breaking' }
  const charger45 = { name: 'Зарядное устройство Breaking P09 USB-C GaN 45W', brand: 'Breaking' }
  assert.equal(identity(charger25).wattage, '25')
  assert(reviewCandidate(charger25, charger45)?.reasons.includes('мощность отличается'))
  const caseName = 'Чехол iPhone 16 Pro прозрачный'
  const blackCase = 'Чехол iPhone 16 Pro черный'
  assert(reviewCandidate({ name: caseName }, { name: blackCase }))
  assert.equal(reviewCandidate({ name: caseName }, { name: 'Чехол iPhone 15 Pro прозрачный' }), null)
  assert.equal(reviewCandidate({ name: 'Nokia 110 TA1567' }, { name: 'Nokia 108 TA1627' }), null)
  assert.equal(reviewCandidate({ name: 'iPhone 17 Pro 256GB' }, { name: 'iPhone 17 Pro 256GB' }), null)
  assert.equal(isExpectedReviewOutcome('05.ru: найдены варианты для ручной проверки для СЗУ'), true)
})

test('Smartphone variant differences are retained for manual review, not discarded', () => {
  const ours = { name: 'Смартфон Apple iPhone 16 128 ГБ белый', brand: 'Apple' }
  const blackUsed = { name: 'Смартфон Apple iPhone 16 128 ГБ черный Б/У', brand: 'Apple' }
  const wrongStorage = { name: 'Смартфон Apple iPhone 16 256 ГБ белый', brand: 'Apple' }
  const wrongModel = { name: 'Смартфон Apple iPhone 15 128 ГБ белый', brand: 'Apple' }
  assert(reviewCandidate(ours, blackUsed)?.reasons.includes('цвет отличается'))
  assert(reviewCandidate(ours, blackUsed)?.reasons.includes('состояние отличается'))
  assert(reviewCandidate(ours, wrongStorage)?.reasons.includes('память отличается'))
  assert.equal(reviewCandidate(ours, wrongModel), null)
  assert.deepEqual(manualConfirmationBlockers(ours, blackUsed), [])
  assert(manualConfirmationBlockers(ours, wrongModel).includes('модель'))
  assert(manualConfirmationBlockers(ours, { name: 'Чехол Apple iPhone 16 128 ГБ белый', brand: 'Apple' }).includes('тип товара'))
})

test('MacBook Air model family ignores year/chip wording but keeps screen size as a variant', () => {
  const ours = {
    name: 'Ноутбук Apple MacBook Air 13 2025 16/256GB M4 Silver',
    brand: 'Apple',
    attributes: { model: 'MacBook Air 13 2025 M4' },
  }
  const fiveRu = {
    name: 'Ноутбук Apple MacBook Air 13 M4 16GB/256GB Silver',
    brand: 'Apple',
    attributes: { model: 'MacBook Air 13 M4' },
  }
  assert.equal(canonicalModel(identity(ours).model), 'macbook air')
  assert.equal(canonicalModel(identity(fiveRu).model), 'macbook air')
  assert.equal(identity(ours).screenSize, '13')
  assert.equal(identity(ours).cpu, 'm4')
  assert.equal(identity(ours).ram, '16')
  assert.equal(identity(ours).storage, '256')
  assert.deepEqual(compareItems(ours, fiveRu).conflicts, [])
  assert.deepEqual(manualConfirmationBlockers(ours, fiveRu), [])
})

test('HONOR MagicBook X14 Plus is recognized as a laptop model and exact hardware match', () => {
  const ours = {
    name: 'Ноутбук HONOR MagicBook X14 Plus 2025 14" Intel Core 5 220H ОЗУ/16 ГБ, SSD/512 ГБ Windows 11 Home',
    brand: 'HONOR',
  }
  const listed = {
    name: 'Ноутбук HONOR MagicBook X14 Plus 14" Intel Core 5 220H 16GB/512GB SSD',
    brand: 'HONOR',
  }
  assert.equal(identity(ours).model, 'magicbook x14')
  assert.equal(identity(listed).model, 'magicbook x14')
  const same = compareItems(ours, listed)
  assert.deepEqual(same.conflicts, [], JSON.stringify(same))
  assert.equal(same.canAutoConfirm, true)
})

test('Laptop SSD capacities recognize all terabyte aliases without equating 512GB', () => {
  for (const token of [
    '1TB', '1 Tb', '1T', '1 ТБ', '1 Тб', '1 Т', '1 Терабайт', '1 терабайта',
    '1 терабайтов', '1000GB', '1000 ГБ', '1000 гигабайт', '1024GB',
    '1024 Гб', 'SSD 1TB', 'SSD/1000GB',
  ]) {
    assert.equal(canonicalStorageCapacity(token), '1024', token)
  }
  assert.equal(canonicalStorageCapacity('2 терабайта'), '2048')
  assert.equal(canonicalStorageCapacity('2000 ГБ'), '2048')
  assert.equal(canonicalStorageCapacity('0,5 TB'), '512')
  assert.equal(canonicalStorageCapacity('512GB'), '512')
  assert.equal(canonicalStorageCapacity('500GB'), '500')
  assert.notEqual(canonicalStorageCapacity('500GB'), canonicalStorageCapacity('512GB'))

  const ours = {
    name: 'Ноутбук Apple MacBook Air 13 M4 16GB SSD 1 ТБ Silver',
    brand: 'Apple',
  }
  const yours = identity(ours)
  assert.equal(yours.kind, 'laptop')
  assert.equal(yours.ram, '16')
  assert.equal(yours.storage, '1024')
  for (const title of [
    'Ноутбук Apple MacBook Air 13 M4 16GB 1TB SSD Silver',
    'Ноутбук Apple MacBook Air 13 M4 16GB SSD 1000ГБ Silver',
    'Ноутбук Apple MacBook Air 13 M4 16GB/1024GB SSD Silver',
    'Ноутбук Apple MacBook Air 13 M4 16GB SSD 1 терабайт Silver',
    'Ноутбук Apple MacBook Air 13 M4 16GB 1T SSD Silver',
    'Ноутбук Apple MacBook Air 13 M4 SSD 1024 16GB RAM Silver',
  ]) {
    const matched = compareItems(ours, { name: title, brand: 'Apple' })
    assert.equal(matched.theirs.storage, '1024', title)
    assert.equal(matched.theirs.ram, '16', title)
    assert.deepEqual(matched.conflicts, [], title + ' ' + JSON.stringify(matched))
    assert.equal(matched.canAutoConfirm, true, title)
  }
  // Capacity role labels beat input order. 16GB RAM at the end is not an SSD.
  const reversed = identity({ name: 'Ноутбук MacBook Air 13 M4 1TB SSD 16GB RAM Silver' })
  assert.equal(reversed.storage, '1024')
  assert.equal(reversed.ram, '16')
  const specs = identity({
    name: 'Ноутбук MacBook Air 13 M4 16GB Silver',
    specs: [{ label: 'Объем SSD', value: '1000 ГБ' }, { label: 'Оперативная память', value: '16 ГБ' }],
  })
  assert.equal(specs.storage, '1024')

  const wrong = compareItems(ours, {
    name: 'Ноутбук Apple MacBook Air 13 M4 16GB SSD 512GB Silver', brand: 'Apple',
  })
  assert(wrong.conflicts.includes('память'), JSON.stringify(wrong))
  assert.equal(wrong.canAutoConfirm, false)
  assert.equal(new MatchingEngine().strongVariant(wrong), false)
  assert(manualConfirmationBlockers(ours, { name: 'MacBook Air 13 M4 16GB SSD 512GB' })
    .includes('объем SSD отличается'))
  const missing = compareItems(ours, {
    name: 'Ноутбук Apple MacBook Air 13 M4 16GB Silver', brand: 'Apple',
  })
  assert.equal(missing.theirs.storage, undefined)
  assert.equal(missing.canAutoConfirm, false)
  assert(manualConfirmationBlockers(ours, { name: 'Ноутбук Apple MacBook Air 13 M4 16GB Silver' })
    .includes('объем SSD не определен'))
})

test('Exact laptop article or barcode never overrides a different/unknown SSD', () => {
  const ours = {
    name: 'Ноутбук Acer Aspire AL15-31P-C1CS N4500/8GB/1TB SSD',
    brand: 'Acer', gtin: '4006381333931',
  }
  const wrong = {
    name: 'Ноутбук Acer Aspire AL15-31P-C1CS N4500/8GB/512GB SSD',
    brand: 'Acer', gtin: '4006381333931',
  }
  const exactIdWrongStorage = compareItems(ours, wrong)
  assert.equal(exactIdWrongStorage.exactId, true)
  assert.equal(exactIdWrongStorage.canAutoConfirm, false)
  assert.equal(new MatchingEngine().strongVariant(exactIdWrongStorage), false)
  assert(manualConfirmationBlockers(ours, wrong).includes('объем SSD отличается'))
  const unknown = compareItems(ours, {
    name: 'Ноутбук Acer Aspire AL15-31P-C1CS N4500/8GB',
    brand: 'Acer', gtin: '4006381333931',
  })
  assert.equal(unknown.exactId, true)
  assert.equal(unknown.canAutoConfirm, false)
  assert.equal(new MatchingEngine().strongVariant(unknown), false)
  assert.deepEqual(
    rankSearchLinks([
      { url: 'https://05.ru/cat/laptops/p/macbook-air-m4-16-gb-512-gb-1/', title: 'Ноутбук Apple MacBook Air 13 M4 16GB 512GB SSD Silver' },
      { url: 'https://05.ru/cat/laptops/p/macbook-air-m4-16-gb-1-tb-2/', title: 'Ноутбук Apple MacBook Air 13 M4 16GB 1TB SSD Silver' },
    ], 'Ноутбук Apple MacBook Air 13 M4 16GB 1ТБ SSD Silver'),
    ['https://05.ru/cat/laptops/p/macbook-air-m4-16-gb-1-tb-2/'],
  )
  const queries = oneCSearchQueries({
    name: 'Ноутбук Apple MacBook Air 13 M4 16GB SSD 1TB Silver', brand: 'Apple',
  })
  assert(queries.some(q => q.includes('1024gb')), JSON.stringify(queries))
  assert(queries.some(q => q.includes('1tb')), JSON.stringify(queries))
  assert(queries.some(q => q.includes('1000gb')), JSON.stringify(queries))
})

test('Six-hour recheck demotes an old confirmed 1TB-to-512GB notebook link', async () => {
  await prisma.monitorJob.updateMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date(), leaseUntil: null },
  })
  const uuid = randomUUID(), cat = randomUUID()
  const oneCName = 'Ноутбук Apple MacBook Air 13 M4 16GB SSD 1ТБ Silver'
  const candidateName = 'Ноутбук Apple MacBook Air 13 M4 16GB SSD 512GB Silver'
  const competitorUrl = 'https://05.ru/cat/laptops/p/macbook-air-13-m4-16-512-' + uuid + '/'
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: cat, name: 'NOTEBOOK SSD GUARD ' + uuid, slug: 'ssd-guard-' + cat }],
    products: [{ oneCId: uuid, categoryOneCId: cat, name: oneCName,
      sku: 'SSD-GUARD-' + uuid, slug: 'ssd-guard-' + uuid, brand: 'Apple',
      price: 150000, stockQty: 2 }],
  })
  const product = await prisma.product.findUniqueOrThrow({ where: { oneCId: uuid } })
  const source = await prisma.competitorSource.upsert({
    where: { key: '05ru' },
    update: {}, create: { key: '05ru', name: '05.ru', baseUrl: 'https://05.ru' },
  })
  const theirAttributes = identity({ name: candidateName, brand: 'Apple' })
  const existing = await prisma.competitorProduct.create({
    data: { sourceId: source.id, productId: product.id, externalUrl: competitorUrl,
      externalName: candidateName, attributes: theirAttributes, latestPrice: 99000,
      inStock: true, matchStatus: 'CONFIRMED', lastSuccessAt: new Date(),
      confirmedFingerprint: fingerprint({ name: candidateName, attributes: theirAttributes }),
      confirmedProductFingerprint: fingerprint(product) },
  })
  const parser = { parse: async url => ({
    url, name: candidateName, brand: 'Apple', attributes: theirAttributes,
    categoryName: 'Ноутбуки', seller: '05.ru', price: 98900, inStock: true,
    priceSource: 'JSON-LD Offer',
  }) }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const job = await prisma.monitorJob.create({
    data: { kind: 'RECHECK', sourceKey: '05ru', perPage: 1, status: 'RUNNING',
      pendingUrls: [competitorUrl] },
  })
  await monitor.recheckBatch(job.id, [competitorUrl], '05ru')
  const now = await prisma.competitorProduct.findUniqueOrThrow({ where: { id: existing.id } })
  assert.equal(now.matchStatus, 'REVIEW_REQUIRED')
  assert.equal(now.latestPrice, 98900)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).price, 150000)
  assert.equal((await prisma.monitorJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'COMPLETED')
  assert.equal(await prisma.monitorDelivery.count({ where: { linkId: existing.id, status: 'PENDING' } }), 0)
})

test('Laptop matching uses manufacturer part numbers and hardware configuration', () => {
  const acer = {
    name: 'Ноутбук 15.6" FHD Acer Aspire AL15-31P-C1CS silver (Cel N4500/8Gb/256Gb SSD/VGA int/noOS)',
    brand: 'Acer', category: 'НОУТБУКИ',
  }
  const fiveRu = {
    name: 'Ноутбук Acer Aspire AL15-31P-C1CS 15.6" FHD Intel Celeron N4500 8GB RAM 256GB SSD Silver',
    brand: 'Acer', category: 'Ноутбуки',
  }
  const parsed = identity(acer)
  assert.equal(parsed.kind, 'laptop')
  assert.equal(parsed.brand, 'acer')
  assert.equal(parsed.model, 'aspire')
  assert.equal(parsed.productCode, 'al15-31p-c1cs')
  assert.equal(parsed.cpu, 'celeron n4500')
  assert.equal(parsed.ram, '8')
  assert.equal(parsed.storage, '256')
  assert.equal(parsed.screenSize, '15.6')

  const same = compareItems(acer, fiveRu)
  assert.deepEqual(same.conflicts, [], JSON.stringify(same))
  assert.equal(same.theirs.productCode, parsed.productCode)
  assert.equal(same.theirs.cpu, parsed.cpu)

  // An exact manufacturer part number wins over a harmless family-name
  // difference between the 1C title and the storefront title.
  const sameCodeDifferentFamily = compareItems(acer, {
    name: 'Ноутбук Acer Aspire 3 AL15-31P-C1CS 15.6" FHD Intel Celeron N4500 8GB RAM 256GB SSD Silver',
    brand: 'Acer',
  })
  assert.deepEqual(sameCodeDifferentFamily.conflicts, [], JSON.stringify(sameCodeDifferentFamily))

  const wrongCode = compareItems(acer, {
    name: 'Ноутбук Acer Aspire AL15-31P-C2CS 15.6" Celeron N4500 8GB 256GB SSD',
    brand: 'Acer',
  })
  assert(wrongCode.conflicts.length)
  assert(reviewCandidate(acer, { name: 'Ноутбук Acer Aspire AL15-31P-C2CS 15.6" Celeron N4500 8GB 256GB SSD', brand: 'Acer' })?.reasons.includes('код производителя отличается'))

  const wrongCpu = compareItems(acer, {
    name: 'Ноутбук Acer Aspire AL15-31P-C1CS 15.6" Core i3-1215U 8GB 256GB SSD',
    brand: 'Acer',
  })
  assert(wrongCpu.conflicts.includes('процессор'))

  const wrongRam = compareItems(acer, {
    name: 'Ноутбук Acer Aspire AL15-31P-C1CS 15.6" Celeron N4500 16GB 256GB SSD',
    brand: 'Acer',
  })
  assert(wrongRam.conflicts.includes('ОЗУ'))

  assert.deepEqual(oneCSearchQueries(acer), [
    'acer al15-31p-c1cs',
    'acer celeron n4500 8gb 256gb 15.6"',
    'Ноутбук 15.6" FHD Acer Aspire AL15-31P-C1CS silver (Cel N4500/8Gb/256Gb SSD/VGA int/noOS)',
  ])

  const target = 'https://05.ru/cat/laptops/p/acer-aspire-al15-31p-c1cs-123/'
  const other = 'https://05.ru/cat/laptops/p/acer-aspire-al15-31p-c2cs-456/'
  const laptopRanked = rankSearchLinks([
    { url: other, title: 'Ноутбук Acer Aspire AL15-31P-C2CS 15.6" Celeron N4500 8GB 256GB SSD' },
    { url: target, title: fiveRu.name },
  ], 'acer al15-31p-c1cs')
  assert.equal(laptopRanked[0], target)
  assert(laptopRanked.includes(other)) // Same family, different SKU: keep for human review.
})

test('Laptop part number parser recognizes ASUS, Lenovo, MSI, Huawei and Apple model codes', () => {
  const cases = [
    ['Ноутбук Asus Vivobook 15 X1504ZA-BQ1144 Core i3-1215U', 'x1504za-bq1144', 'core i3 1215u'],
    ['Ноутбук Lenovo IdeaPad 1 15AMN7 82VG00Q8 Ryzen 5 7520U', '82vg00q8', 'ryzen 5 7520u'],
    ['Ноутбук MSI Thin 15 B13VE-3200XRU Core i7-13620H RTX 4050', 'b13ve-3200xru', 'core i7 13620h'],
    ['Ноутбук Huawei MateBook D 14 53013XET Core i5-12450H', '53013xet', 'core i5 12450h'],
    ['Apple MacBook Air A3241 15.3 2025 M4', 'a3241', 'm4'],
  ]
  for (const [name, code, cpu] of cases) {
    const parsed = identity({ name, brand: name.includes('Apple') ? 'Apple' : undefined })
    assert.equal(parsed.kind, 'laptop', name)
    assert.equal(parsed.productCode, code, name)
    assert.equal(parsed.cpu, cpu, name)
  }
})

test('Search ranking promotes Xiaomi 15T Pro beyond the first 12 unrelated links', () => {
  const target = 'https://05.ru/cat/396f7486/p/smartfon-xiaomi-15t-pro-12-gb-512-gb-cherniy-25708/'
  const noise = Array.from({ length: 15 }, (_, i) => ({
    url: 'https://05.ru/cat/396f7486/p/smartfon-xiaomi-15t-12-gb-512-gb-seriy-' + i + '/',
    title: 'Смартфон Xiaomi 15T 12 Гб/512 Гб серый',
  }))
  const candidates = [...noise, { url: target, title: 'Смартфон Xiaomi 15T Pro 12 Гб/512 Гб черный' }]
  assert.equal(rankSearchLinks(candidates, 'xiaomi 15t pro 512', 8)[0], target)
  assert.equal(rankSearchLinks([...candidates, candidates.at(-1)], 'xiaomi 15t pro', 20).length, 1)
  assert.deepEqual(rankSearchLinks([
    { url: 'https://05.ru/cat/x/p/chehol-dlya-iphone-17-pro-256-123/', title: 'Чехол iPhone 17 Pro 256' },
    { url: 'https://05.ru/cat/x/p/smartfon-iphone-17-pro-256-456/', title: 'Смартфон Apple iPhone 17 Pro 256 Гб оранжевый' },
  ], 'iphone 17 pro 256', 10), ['https://05.ru/cat/x/p/smartfon-iphone-17-pro-256-456/'])
  const phoneVariants = rankSearchLinks([
    { url: 'https://05.ru/cat/x/p/smartfon-apple-iphone-17-pro-1-tb-oranzheviy-1/', title: 'iPhone 17 Pro 1 ТБ' },
    { url: 'https://05.ru/cat/x/p/smartfon-apple-iphone-17-pro-256-gb-oranzheviy-2/', title: 'iPhone 17 Pro 256 GB' },
    { url: 'https://05.ru/cat/x/p/smartfon-apple-iphone-17-pro-512-gb-oranzheviy-3/', title: 'iPhone 17 Pro 512 GB' },
  ], 'iphone 17 pro 256', 12)
  assert.equal(phoneVariants[0], 'https://05.ru/cat/x/p/smartfon-apple-iphone-17-pro-256-gb-oranzheviy-2/')
  assert.equal(phoneVariants.length, 3) // Other capacities stay visible for manual review.

  const broadPhoneUrl = 'https://05.ru/cat/x/p/smartfon-apple-128-gb-123/'
  assert.deepEqual(rankSearchLinks([
    { url: broadPhoneUrl, title: 'Смартфон Apple 128 ГБ' },
  ], 'iphone 13 128', 10), []) // A brand/capacity-only card cannot prove the requested model.
  const unparsedPhoneUrl = 'https://05.ru/cat/x/p/smartfon-apple-13-128-gb-chernyy-125/'
  assert.deepEqual(rankSearchLinks([
    { url: unparsedPhoneUrl, title: 'Смартфон Apple 13 128 ГБ черный' },
  ], 'apple iphone 13 128 черный', 10), [unparsedPhoneUrl]) // Keep a model-number anchor for page-level review.
  const partialBrandedPhone = 'https://05.ru/cat/x/p/apple-13-128-gb-black-126/'
  assert.deepEqual(rankSearchLinks([
    { url: partialBrandedPhone, title: 'Apple 13 128 GB black' },
  ], 'apple iphone 13 128 черный', 10), [partialBrandedPhone]) // Some tiles omit the product type and the word iPhone.
  const liveIphone13Black = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-13-4-gb-128-gb-chernyy-bez-rustore-11211/'
  assert.deepEqual(rankSearchLinks([
    { url: liveIphone13Black, title: 'Смартфон Apple iPhone 13 4 Гб/128 Гб черный (без RuStore)' },
  ], 'apple iphone 13 128 черный', 10), [liveIphone13Black])
  const wrongModelFallback = 'https://05.ru/cat/x/p/smartfon-apple-iphone-14-128-gb-124/'
  assert.deepEqual(rankSearchLinks([
    { url: wrongModelFallback, title: 'Смартфон Apple iPhone 14 128 ГБ' },
  ], 'iphone 13 128', 10), []) // A different iPhone model is never a fallback.
  const airFallback = 'https://05.ru/cat/x/p/smartfon-apple-iphone-air-12-gb-256-gb-123/'
  const iphone17Fallback = 'https://05.ru/cat/x/p/smartfon-apple-iphone-17-pro-12-gb-256-gb-456/'
  const iphone13Exact = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-13-128-gb-siniy-bez-rustore-11197/'
  assert.deepEqual(rankSearchLinks([
    { url: airFallback, title: 'Смартфон Apple iPhone Air 12 Гб/256 Гб голубой' },
    { url: iphone17Fallback, title: 'Смартфон Apple iPhone 17 Pro 12 Гб/256 Гб оранжевый' },
    { url: iphone13Exact, title: 'Смартфон Apple iPhone 13 128 Гб синий' },
  ], 'iphone 13 128', 10), [iphone13Exact])

  // The URL slug is the identity of the linked product. Surrounding card text
  // can contain a sibling/recommendation and must not overwrite the slug.
  const iphone14Slug = 'https://05.ru/cat/6a303413/p/smartfon-apple-iphone-14-512-gb-chernyy-bez-rustore-42671/'
  assert.deepEqual(rankSearchLinks([
    { url: iphone14Slug, title: 'Смартфон Apple iPhone 17 Pro 12 Гб/256 Гб оранжевый' },
  ], 'apple iphone 14 256 черный', 10), [iphone14Slug])
  assert.deepEqual(rankSearchLinks([
    { url: iphone17Fallback, title: 'Смартфон Apple iPhone 14 256 Гб черный' },
  ], 'apple iphone 14 256 черный', 10), [])
  const greenLion = 'https://05.ru/cat/cases/p/green-lion-tough-guard-iphone-15-pro-blue-777/'
  const accessoryLinks = [
    { url: 'https://05.ru/cat/cases/p/borasco-iphone-15-pro-black-1/', title: 'Чехол накладка Borasco Silicone Case для Apple iPhone 15 Pro черный' },
    { url: 'https://05.ru/cat/cases/p/uniq-iphone-15-pro-smoke-2/', title: 'Чехол Uniq Lifepro Xtreme для Apple iPhone 15 Pro серый' },
    { url: greenLion, title: 'Накладка Green Lion Tough Guard Case для iPhone 15 Pro Deep Blue' },
  ]
  assert.equal(rankSearchLinks(accessoryLinks, 'green lion чехол iphone 15 pro', 1)[0], greenLion)
})

test('Normalizes storage units and paired RAM/ROM labels across retailer wording', () => {
  const pair = identity({
    name: 'POCO X7 512GB Silver',
    specs: [{ label: 'Память (ОЗУ/ПЗУ)', value: '12 ГБ / 512 ГБ' }],
  })
  assert.equal(pair.ram, '12')
  assert.equal(pair.storage, '512')
  const match = compareItems(
    { name: 'Apple iPhone 16 256 ГБ черный' },
    { name: 'Apple iPhone 16 256GB Black' },
  )
  assert.equal(match.ours.storage, '256')
  assert.equal(match.theirs.storage, '256')
  assert.equal(match.canAutoConfirm, true)
})

test('Temporary 05.ru-only mode resolves legacy all-store search without scheduling other retailers', async () => {
  const created = []
  const product = {
    id: 901, oneCId: 'onec-901', name: 'Apple iPhone 16 128GB Black',
    status: 'ACTIVE', price: 70000, stockQty: 2, reservedQty: 0,
    category: { name: 'Смартфоны' },
  }
  const zeroStock = {
    id: 902, oneCId: 'onec-902', name: 'Apple iPhone 16 256GB Black',
    status: 'ACTIVE', price: 75000, stockQty: 0, reservedQty: 0,
    category: { name: 'Смартфоны' },
  }
  const prismaStub = {
    monitorJob: {
      count: async () => 0,
      create: async ({ data }) => {
        created.push(data)
        return { id: 'job-' + data.sourceKey, ...data }
      },
    },
    product: { findMany: async () => [product, zeroStock] },
    monitorSettings: {
      upsert: async ({ where }) => ({ id: where.id, region: 'Махачкала' }),
    },
    competitorProduct: {
      findMany: async ({ where }) => where.source.key === 'dns' ? [{ productId: product.id }] : [],
    },
  }
  const monitor = new PriceMonitorService(prismaStub, {}, {})
  const result = await monitor.autoFindOneCSection({
    sourceKey: 'all', categoryPath: 'Смартфоны', maxItems: 10, onlyUnlinked: true,
  })
  assert.equal(result.sourceKey, '05ru')
  assert.equal(result.queued, 1)
  assert.equal(result.eligible, 1)
  assert.deepEqual(created.map(job => job.sourceKey), ['05ru'])
  assert(created.every(job => job.kind === 'MATCH_1C' && job.pendingUrls.length === 1))
})

test('Temporary 05.ru-only mode rejects DNS and M.Video requests before browsers open', async () => {
  const monitor = new PriceMonitorService({ monitorJob: { count: async () => 0 } }, {}, {})
  await assert.rejects(() => monitor.check({ url: 'https://www.mvideo.ru/products/4253150/' }), /только 05.ru/)
  await assert.rejects(() => monitor.check({ url: 'https://www.dns-shop.ru/product/91f112efa89cd21a/phone/' }), /только 05.ru/)
  await assert.rejects(() => monitor.autoFindOneCSection({
    sourceKey: 'mvideo', categoryPath: 'Смартфоны', maxItems: 10,
  }), /только 05.ru/)
  await assert.rejects(() => monitor.checkAll({ sourceKey: 'dns' }), /только 05.ru/)
  await assert.rejects(() => monitor.settings('dns'), /только 05.ru/)
})


test('Retailer adapters start at their public search URL instead of blocking on homepage hydration', async () => {
  const cases = [
    {
      parser: new MvideoParser(),
      searchUrl: 'https://www.mvideo.ru/search?query=iPhone%2017%20Air%20256',
      productUrl: 'https://www.mvideo.ru/products/403508161/',
      title: 'Apple iPhone 17 Air 256GB Black eSIM',
    },
    {
      parser: new DnsParser(),
      searchUrl: 'https://www.dns-shop.ru/search/?q=iPhone%2017%20Air%20256',
      productUrl: 'https://www.dns-shop.ru/product/d3b534358dd3d0a4/65-smartfon-apple-iphone-air-256-gb-cernyj/',
      title: 'Смартфон Apple iPhone Air 256 ГБ черный',
    },
  ]
  for (const item of cases) {
    let currentUrl = ''
    const navigations = []
    const page = {
      goto: async (url, options) => {
        currentUrl = url
        navigations.push(url)
        assert.equal(options.waitUntil, 'commit')
        assert(options.timeout <= 15_000)
        return { status: () => 200 }
      },
      url: () => currentUrl,
      locator: () => ({
        first: () => ({ waitFor: async () => {} }),
        evaluateAll: async () => [{ url: item.productUrl, title: item.title }],
      }),
      close: async () => {},
    }
    const context = { newPage: async () => page }
    const found = await item.parser.searchPage(context, 'iPhone 17 Air 256')
    assert.deepEqual(navigations, [item.searchUrl])
    assert.equal(found.links.length, 1)
    assert.equal(found.links[0].url, item.productUrl)
    await found.page.close()
    await item.parser.onModuleDestroy()
  }
})

test('Retailer HTTP 401 is surfaced immediately and does not retry the homepage or next query', async () => {
  const parser = new DnsParser()
  let navigations = 0
  const page = {
    goto: async (url, options) => {
      navigations++
      assert.equal(options.waitUntil, 'commit')
      return { status: () => 401 }
    },
    url: () => 'https://www.dns-shop.ru/search/?q=iphone',
    close: async () => {},
  }
  await assert.rejects(
    () => parser.searchPage({ newPage: async () => page }, 'iphone 17 pro 256'),
    /DNS ответил HTTP 401/,
  )
  assert.equal(navigations, 1)
  await parser.onModuleDestroy()
})

test('DNS and M.Video adapters normalize official URLs and read the retailer offer, not marketplace offers', () => {
  const dns = new DnsParser()
  const mvideo = new MvideoParser()
  const dnsUrl = 'https://www.dns-shop.ru/product/91f112efa89cd21a/667-smartfon-poco-x7-512-gb-serebristyj/'
  const mvideoUrl = 'https://www.mvideo.ru/products/4253150'
  assert.equal(storeKeyFromUrl(dnsUrl), 'dns')
  assert.equal(storeKeyFromUrl(mvideoUrl), 'mvideo')
  assert.equal(dns.normalizeProductUrl(dnsUrl), dnsUrl)
  assert.equal(mvideo.normalizeProductUrl(mvideoUrl), 'https://www.mvideo.ru/products/4253150/')
  assert.throws(() => dns.normalizeProductUrl('https://evil.example/product/91f112efa89cd21a/phone/'))

  const dnsConfig = {
    key: 'dns', name: 'DNS', baseUrl: 'https://www.dns-shop.ru', allowedHosts: ['dns-shop.ru'],
    productLinkSelector: 'a[href*="/product/"]', productPath: /^\/product\/[a-f0-9]+\/[a-z0-9-]+\/?$/i,
    priceSelectors: [], oldPriceSelectors: [], regionSelectors: [], searchFallback: q => q,
    officialSellerPattern: /\bdns\b|днс/i,
  }
  const dnsSnapshot = {
    h1: '6.67" Смартфон POCO X7 512 ГБ серебристый',
    scripts: [JSON.stringify({
      '@type': 'Product', name: '6.67" Смартфон POCO X7 512 ГБ серебристый',
      brand: { name: 'POCO' }, sku: '5606820',
      offers: { '@type': 'Offer', price: '24990', priceCurrency: 'RUB', availability: 'https://schema.org/InStock', seller: { name: 'DNS' } },
    })],
    metaPrice: null, metaCurrency: null, domPrice: '24 990 ₽', oldPrice: null,
    availability: 'В наличии', specs: [{ label: 'Память (ОЗУ/ПЗУ)', value: '12 ГБ / 512 ГБ' }],
    seller: 'DNS', region: 'Махачкала', category: 'Смартфоны',
  }
  const dnsResult = extractRetailerProduct(dnsSnapshot, dnsUrl, dnsConfig)
  assert.equal(dnsResult.price, 24990)
  assert.equal(dnsResult.attributes.ram, '12')
  assert.equal(dnsResult.attributes.storage, '512')
  assert.equal(dnsResult.region, 'Махачкала')

  const mvideoConfig = {
    key: 'mvideo', name: 'М.Видео', baseUrl: 'https://www.mvideo.ru', allowedHosts: ['mvideo.ru'],
    productLinkSelector: 'a[href*="/products/"]', productPath: /^\/products\/\d+\/?$/,
    priceSelectors: [], oldPriceSelectors: [], regionSelectors: [], searchFallback: q => q,
    officialSellerPattern: /м\.?\s*видео|mvideo/i,
  }
  const mvideoSnapshot = {
    h1: 'Смартфон Apple iPhone 16 128GB Black',
    scripts: [JSON.stringify({
      '@type': 'Product', name: 'Смартфон Apple iPhone 16 128GB Black', brand: { name: 'Apple' },
      offers: [
        { '@type': 'Offer', price: '79990', priceCurrency: 'RUB', seller: { name: 'М.Видео' }, availability: 'https://schema.org/InStock' },
        { '@type': 'Offer', price: '64990', priceCurrency: 'RUB', seller: { name: 'Сторонний продавец' }, availability: 'https://schema.org/InStock' },
      ],
    })],
    metaPrice: null, metaCurrency: null, domPrice: '79 990 ₽', oldPrice: '99 990 ₽',
    availability: 'В наличии', specs: [{ label: 'Встроенная память (ROM)', value: '128 ГБ' }],
    seller: 'М.Видео', region: 'Москва', category: 'Смартфоны',
  }
  const mvideoResult = extractRetailerProduct(mvideoSnapshot, 'https://www.mvideo.ru/products/4253150/', mvideoConfig)
  assert.equal(mvideoResult.price, 79990)
  assert.equal(mvideoResult.seller, 'М.Видео')
  assert.throws(() => extractRetailerProduct({
    ...mvideoSnapshot, seller: 'Сторонний продавец',
    scripts: [JSON.stringify({ '@type': 'Product', name: mvideoSnapshot.h1,
      offers: [{ '@type': 'Offer', price: '64990', priceCurrency: 'RUB', seller: { name: 'Сторонний продавец' } }] })],
  }, 'https://www.mvideo.ru/products/4253150/', mvideoConfig), /стороннего продавца/)
  assert.throws(() => extractRetailerProduct({
    ...mvideoSnapshot, seller: null,
    scripts: [JSON.stringify({ '@type': 'Product', name: mvideoSnapshot.h1,
      offers: [
        { '@type': 'Offer', price: '79990', priceCurrency: 'RUB', seller: { name: 'Неизвестный продавец' } },
        { '@type': 'Offer', price: '64990', priceCurrency: 'RUB', seller: { name: 'Другой продавец' } },
      ] })],
  }, 'https://www.mvideo.ru/products/4253150/', mvideoConfig), /не подтверждён официальный продавец/)
})

test('POCO/Redmi identity aliases work and recall ranking opens close phone candidates for inspection', () => {
  const pocoName = 'Смартфон POCO X7 12/512 Гб серебристый'
  const poco = identity({ name: pocoName, brand: 'Xiaomi' })
  assert.equal(poco.brand, 'xiaomi')
  assert.equal(poco.model, 'poco x7')
  const pocoUrl = 'https://05.ru/cat/396f7486/p/smartfon-poco-x7-12-gb-512-gb-serebristyy-20505/'
  assert.deepEqual(rankSearchLinks([
    { url: pocoUrl, title: 'Смартфон POCO X7 12 Гб/512 Гб серебристый' },
  ], 'xiaomi poco x7 512 серебристый'), [pocoUrl])
  assert.equal(compareItems(
    { name: pocoName, brand: 'Xiaomi' },
    { name: 'Смартфон POCO X7 12 Гб/512 Гб серебристый' },
  ).canAutoConfirm, true)

  const redmi = identity({ name: 'Смартфон Xiaomi Redmi Note 14S 8/256 Гб черный' })
  assert.equal(redmi.model, 'redmi note 14s')

  const a26 = 'https://05.ru/cat/396f7486/p/smartfon-samsung-galaxy-a26-8-256-gb-beliy-21147/'
  const a36 = 'https://05.ru/cat/396f7486/p/smartfon-samsung-galaxy-a36-8-256-gb-beliy-21148/'
  const misleadingTile = [
    { url: a26, title: 'Смартфон POCO A26 8 Гб/256 Гб белый' },
    { url: a36, title: 'Смартфон Samsung Galaxy A36 8 Гб/256 Гб белый' },
    { url: 'https://05.ru/cat/x/p/chehol-samsung-galaxy-a26-123/', title: 'Чехол Samsung Galaxy A26' },
  ]
  // Strict ranking can distrust a noisy tile brand. The recall pass still opens
  // the URL whose own slug identifies A26; the real product page decides later.
  assert.deepEqual(rankSearchLinks(misleadingTile, 'samsung galaxy a26 128 черный'), [])
  assert.deepEqual(rankSearchLinksForInspection(misleadingTile, 'samsung galaxy a26 128 черный'), [a26])

  const nearRedmi = 'https://05.ru/cat/396f7486/p/smartfon-xiaomi-redmi-note-14-8-256-gb-cherniy-12345/'
  assert.deepEqual(rankSearchLinksForInspection([
    { url: nearRedmi, title: 'Смартфон Xiaomi Redmi Note 14 8/256 Гб черный' },
  ], 'xiaomi redmi note 14s 256 черный'), [nearRedmi])
})

test('Validates GTIN and never accepts a conflicting variant just because its identifier is equal', () => {
  assert(validGtin('4006381333931'))
  assert.equal(validGtin('4006381333932'), undefined)
  assert.equal(compareItems({ ...product, attributes: { storage: '512' } }, { name }).score, 0)
  assert.equal(compareItems({ ...product, gtin: '4006381333931' }, { name: name.replace('256', '512'), gtin: '4006381333931' }).score, 0)
})

test('Parses recorded live product data; ignores instalment and unrelated Product offers', () => {
  const result = extractFiveRu(fixture.snapshot, url)
  assert.equal(result.price, 96990)
  assert.equal(result.inStock, true)
  assert.equal(result.attributes.storage, '256')
  assert.equal(result.seller, '05.ru')
  assert.equal(result.region, 'Махачкала')
  const used = extractFiveRu({ ...fixture.snapshot, scripts: fixture.snapshot.scripts.map(s => s.replace('NewCondition', 'UsedCondition')) }, url)
  assert.equal(used.attributes.condition, 'used')
  assert.equal(compareItems(product, { name: used.name, attributes: used.attributes }).score, 0)
  assert.equal(priceNumber('25 141 ₽ × 3'), null)
  const unrelated = JSON.stringify({ '@type': 'Product', name: 'Чужой товар', offers: { price: 5000 } })
  assert.throws(() => extractFiveRu({ ...fixture.snapshot, scripts: [unrelated], metaPrice: null, domPrice: null }, url))
  assert.throws(() => extractFiveRu({ ...fixture.snapshot, scripts: [], metaPrice: '900', metaCurrency: 'USD', domPrice: null }, url))
  const unknown = extractFiveRu({ ...fixture.snapshot, scripts: [], availability: null }, url)
  assert.equal(unknown.inStock, null)
  assert.throws(() => fiveRuUrl('https://05.ru:8080/cat/a/p/b/', 'product'))
  assert.throws(() => fiveRuUrl('https://05.ru.attacker.test/cat/a/p/b/', 'product'))
  assert.equal(fiveRuUrl(url + '?utm_source=x#foo', 'product'), url)
})

test('Recommendations require confirmed stock, fresh data, cost floor and a <=10% change', () => {
  const input = { latestPrice: 96990, inStock: true, lastSuccessAt: new Date() }
  assert.equal(recommendation(input, { price: 99990, costPrice: 80000 }).recommendedPrice, 96490)
  for (const bad of [{ ...input, inStock: null }, { ...input, lastError: '403' }, { ...input, lastSuccessAt: new Date(0) }]) assert.equal(recommendation(bad, { price: 99990, costPrice: 80000 }).recommendedPrice, null)
  for (const ours of [{ price: 99990 }, { price: 150000, costPrice: 80000 }, { price: 99990, costPrice: 98000 }]) assert.equal(recommendation(input, ours).recommendedPrice, null)
})

test('Full persistence: 1C import, candidate confirmation, durable delivery, failed ack/retry, changed variant and import rollback', async () => {
  const exchange = new MonitorExchangeService(prisma)
  let parsed = extractFiveRu(fixture.snapshot, url)
  let failure = null
  const parser = { parse: async () => { if (failure) throw new Error(failure); return parsed }, discover: async () => ({ urls: [url], next: null, truncated: false, discovered: 1 }) }
  const monitor = new PriceMonitorService(prisma, parser, exchange)
  const integration = new IntegrationsService(prisma, {}, {})
  const oneCId = randomUUID()
  const catalog = { categories: [{ oneCId: 'cat-test', name: 'Смартфоны', slug: 'phones-test' }], products: [{ oneCId, sku: 'TEST-IP17', slug: 'test-ip17', name: product.name, brand: 'Apple', categoryOneCId: 'cat-test', price: 99990, stockQty: 5, costPrice: 80000 }] }
  await integration.importCatalog(catalog)
  const firstCategory = await prisma.category.findUnique({ where: { oneCId: 'cat-test' } })
  await integration.importCatalog({ categories: [{ oneCId: 'cat-test', name: 'Электроника / Смартфоны', slug: 'phones-test' }], products: [] })
  const nestedCategory = await prisma.category.findUnique({ where: { oneCId: 'cat-test' } })
  assert.equal(nestedCategory.id, firstCategory.id)
  assert.equal(nestedCategory.name, 'Электроника / Смартфоны')
  const ours = await prisma.product.findUnique({ where: { oneCId } })
  let link = await monitor.check({ url })
  assert.equal(link.matchStatus, 'SUGGESTED')
  assert.equal((await exchange.pending()).items.length, 0)
  assert.equal((await monitor.candidates(link.id))[0].product.id, ours.id)
  await monitor.confirm(link.id, ours.id)
  await monitor.confirm(link.id, ours.id)
  await exchange.queueConfirmed()
  assert.equal((await exchange.pending()).items.length, 0) // Initial mapping is a baseline.
  const baselineCount = await prisma.competitorPriceHistory.count({ where: { competitorProductId: link.id } })
  await monitor.check({ url }) // Same price: no proposal and no duplicate history row.
  assert.equal((await exchange.pending()).items.length, 0)
  assert.equal(await prisma.competitorPriceHistory.count({ where: { competitorProductId: link.id } }), baselineCount)
  parsed = { ...parsed, price: 95990 }
  await monitor.check({ url }) // Only a real price change enters the 1C queue.
  const pending = (await exchange.pending()).items
  assert.equal(pending.length, 1)
  assert.equal(pending[0].oneCId, oneCId)
  assert.equal(pending[0].price, 95990)
  assert.equal(pending[0].previousPrice, 96990)
  assert.equal(pending[0].priceChange, -1000)
  assert.equal(pending[0].recommendedPrice, 95490)
  assert.equal((await exchange.pending()).items[0].id, pending[0].id)
  await exchange.ack(pending[0].id, 'Тест: сеть недоступна')
  assert.equal((await exchange.pending()).items.length, 1)
  await exchange.ack(pending[0].id)
  await exchange.ack(pending[0].id)
  assert.equal((await exchange.pending()).items.length, 0)
  assert.equal(await prisma.syncLog.count({ where: { entity: 'PRICE_MONITOR', status: 'SUCCESS' } }), 1)
  assert.equal((await prisma.product.findUnique({ where: { id: ours.id } })).price, 99990)
  const applyDto = { expectedCurrentPrice: 99990, expectedCompetitorPrice: 95990,
    targetPrice: 95490, acceptUnknownCost: false, acceptLargeChange: false }
  await assert.rejects(() => monitor.applyRecommended(link.id, { ...applyDto, expectedCurrentPrice: 90000 }))
  await assert.rejects(() => monitor.applyRecommended(link.id, applyDto), /не включён в разрешённую область/)
  assert.equal((await prisma.product.findUnique({ where: { id: ours.id } })).price, 99990)
  assert.equal(await prisma.auditLog.count({ where: { action: 'QUEUE_MONITOR_PRICE_TO_1C', entityId: String(ours.id) } }), 0)

  failure = 'HTTP 403'
  await assert.rejects(() => monitor.check({ url }))
  link = (await monitor.list())[0]
  assert.equal(link.latestPrice, 95990)
  assert.equal(link.recommendedPrice, null)
  failure = null
  parsed = { ...parsed, name: name.replace('256', '512'), attributes: { ...parsed.attributes, storage: '512' } }
  link = await monitor.check({ url })
  assert.equal(link.matchStatus, 'REVIEW_REQUIRED')
  assert.equal((await exchange.pending()).items.length, 0)
  const manualVariantOverride = await monitor.confirm(link.id, ours.id)
  assert.equal(manualVariantOverride.matchStatus, 'CONFIRMED') // Human approval may override a variant mismatch.
  parsed = { ...parsed, name: name.replace('iPhone 17 Pro', 'iPhone 16 Pro'), attributes: { ...parsed.attributes, model: 'iphone 16 pro' } }
  await monitor.check({ url })
  await assert.rejects(() => monitor.confirm(link.id, ours.id), /Нельзя подтвердить карточку: модель/)
  parsed = extractFiveRu(fixture.snapshot, url)
  await monitor.check({ url }); await monitor.confirm(link.id, ours.id)
  await exchange.queueConfirmed()
  assert.equal((await exchange.pending()).items.length, 0) // Re-confirmation resets baseline; old deltas are not replayed.
  await integration.importCatalog({ ...catalog, products: [{ ...catalog.products[0], name: product.name.replace('256', '512') }] })
  assert.equal((await monitor.list())[0].matchStatus, 'REVIEW_REQUIRED')
  assert.equal((await exchange.pending()).items.length, 0)
  const beforeCount = await prisma.product.count()
  await assert.rejects(() => integration.importCatalog({ categories: catalog.categories, products: [
    { ...catalog.products[0], oneCId: randomUUID(), sku: 'ROLLBACK-FIRST', slug: 'rollback-first' },
    { ...catalog.products[0], oneCId: randomUUID(), sku: 'ROLLBACK-SECOND', slug: 'rollback-second', categoryOneCId: 'missing' },
  ] }))
  assert.equal(await prisma.product.count(), beforeCount)
})

test('Persistent job keeps cursor on 403 and resumes through the observed next page', async () => {
  const exchange = new MonitorExchangeService(prisma)
  const url2 = url.replace('24007/', '24008/')
  let blocked = true
  const parser = {
    discover: async raw => ({ urls: raw.includes('page=2') ? [url2] : [url], next: raw.includes('page=2') ? null : 'https://05.ru/cat/c/02e38f8a/telefony_i_gadzety/?page=2', discovered: 1, truncated: false }),
    parse: async raw => { if (blocked) throw new Error('HTTP 403'); return { ...extractFiveRu(fixture.snapshot, raw), url: raw } },
  }
  const monitor = new PriceMonitorService(prisma, parser, exchange)
  const task = await monitor.scan({ url: 'https://05.ru/cat/c/02e38f8a/telefony_i_gadzety/', maxPages: 2 })
  await monitor.tick() // page one discoveries saved
  await monitor.tick() // 403 retains the card cursor
  let saved = await prisma.monitorJob.findUnique({ where: { id: task.id } })
  assert.equal(saved.status, 'FAILED')
  assert.equal(saved.pendingUrls[0], url)
  blocked = false
  await monitor.retryJob(task.id)
  for (let i = 0; i < 4; i++) await monitor.tick()
  saved = await prisma.monitorJob.findUnique({ where: { id: task.id } })
  assert.equal(saved.status, 'COMPLETED')
  assert.equal(saved.page, 2)
  assert.equal(saved.processed, 2)
  assert.equal((await prisma.product.findFirst({ where: { sku: 'TEST-IP17' } })).price, 99990)
})

test('HTTP routes reject missing credentials and invalid input; admin and 1C routes accept their own authentication', async () => {
  const { spawn } = require('node:child_process')
  const { once } = require('node:events')
  const net = require('node:net')
  const bcrypt = require('bcryptjs')
  await prisma.user.create({ data: { email: 'monitor-http@test.local', name: 'HTTP test', role: 'ADMIN', passwordHash: await bcrypt.hash('LocalTestPassword123!', 8) } })
  const socket = net.createServer()
  await new Promise((r,j) => { socket.once('error',j); socket.listen(0,'127.0.0.1',r) })
  const port = socket.address().port
  await new Promise(r => socket.close(r))
  const key = randomUUID()
  const child = spawn(process.execPath, ['dist/main.js'], { cwd: resolve(__dirname, '..'), env: { ...process.env,
    DATABASE_URL: `file:${database.replace(/\\/g, '/')}`, JWT_SECRET: randomUUID(), ONE_C_API_KEY: key,
    PORT: String(port), NODE_ENV: 'test', TEXHORU_ENV_FILE: 'tests/nonexistent.env', MONITOR_WORKER_DISABLED: 'true', SERVE_STOREFRONT: 'false',
  }, stdio: ['ignore','pipe','pipe'] })
  let log = ''
  child.stdout.on('data', d => { log += d }); child.stderr.on('data', d => { log += d })
  const base = `http://127.0.0.1:${port}/api`
  try {
    let ready = false
    for (let n = 0; n < 50; n++) { try { if ((await fetch(base+'/health')).ok) { ready = true; break } } catch {} await new Promise(r => setTimeout(r,100)) }
    assert(ready, log.slice(-1500))
    assert.equal((await fetch(base+'/admin/price-monitor')).status,401)
    assert.equal((await fetch(base+'/integrations/1c/price-monitor/pending')).status,401)
    const login = await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'monitor-http@test.local',password:'LocalTestPassword123!'})})
    assert.equal(login.status,201)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    for (const path of ['/admin/price-monitor','/admin/price-monitor/jobs','/admin/price-monitor/deliveries','/admin/price-monitor/settings','/admin/price-monitor/export-1c']) assert.equal((await fetch(base+path,{headers:{cookie}})).status,200,path)
    assert.equal((await fetch(base+'/integrations/1c/price-monitor/pending',{headers:{'x-1c-key':key}})).status,200)
    assert.equal((await fetch(base+'/admin/price-monitor/scan',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({url:'https://05.ru/cat/c/02e38f8a/telefony_i_gadzety/',maxPages:101})})).status,400)
    assert.equal((await fetch(base+'/admin/price-monitor/scan',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({url:'https://05.ru.attacker.test/cat/c/a/',maxPages:1})})).status,400)
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child,'exit') }
  }
})

test('Bidirectional pilot: 10 iPhone 13s, 1C to site, approved monitor price back to 1C with stale-import protection', async () => {
  const sync = new OneCPriceSyncService(prisma)
  const integration = new IntegrationsService(prisma, {})
  const exchange = new MonitorExchangeService(prisma)
  const ids = Array.from({ length: 10 }, () => randomUUID())
  const categoryId = randomUUID()
  const category = { oneCId: categoryId, name: 'Тестовые iPhone 13', slug: 'pilot-iphone13-'+categoryId }
  const products = ids.map((id,i) => ({
    oneCId: id, sku: 'PILOT-'+id, slug: 'pilot-'+id,
    name: 'Apple iPhone 13 128GB Test-'+i, brand: 'Apple',
    categoryOneCId: categoryId, price: 60000+i*100, stockQty: 2, costPrice: 45000,
  }))
  const imported = await integration.importCatalog({ categories: [category], products })
  assert.equal(imported.products, 10)
  await assert.rejects(() => sync.configureScope({ oneCIds: [...ids, randomUUID()] }))
  assert.equal((await sync.configureScope({ oneCIds: ids })).count, 10)
  assert.equal((await sync.scope()).length, 10)

  const changedPrice = 72000
  await integration.importCatalog({ categories: [category], products: [{ ...products[0], price: changedPrice }] })
  let ours = await prisma.product.findUniqueOrThrow({ where: { oneCId: ids[0] } })
  assert.equal(ours.price, changedPrice) // 1C -> site

  const source = await prisma.competitorSource.upsert({
    where: { key: '05ru' }, update: {}, create: { key: '05ru', name: '05.ru', baseUrl: 'https://05.ru' },
  })
  const monitorUrl = 'https://05.ru/cat/synthetic/p/iphone-13-128-test/'
  const { fingerprint } = require('../dist/price-monitor/product-matching')
  const competitorName = 'Apple iPhone 13 128GB Test-0'
  const link = await prisma.competitorProduct.upsert({
    where: { externalUrl: monitorUrl },
    update: {}, create: {
      sourceId: source.id, externalUrl: monitorUrl, productId: ours.id, matchStatus: 'CONFIRMED',
      externalName: competitorName, attributes: {},
      confirmedFingerprint: fingerprint({ name: competitorName, attributes: {} }),
      confirmedProductFingerprint: fingerprint(ours),
      lastSuccessAt: new Date(), lastCheckedAt: new Date(), latestPrice: 70900,
      inStock: true, seller: '05.ru', region: 'Махачкала',
    },
  })
  const monitor = new PriceMonitorService(prisma, { parse: async () => {} }, exchange)
  const priceChange = await monitor.applyRecommended(link.id, {
    expectedCurrentPrice: changedPrice, expectedCompetitorPrice: 70900,
    targetPrice: 70400, acceptUnknownCost: false, acceptLargeChange: false,
  })
  assert.equal(priceChange.newPrice, 70400)
  assert.equal(priceChange.oneCQueued, true)
  assert.equal(priceChange.siteOnly, false)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: ids[0] } })).price, changedPrice)
  const pending = await sync.pending()
  assert.equal(pending.items.length, 1)
  assert.equal(pending.items[0].oneCId, ids[0])
  assert.equal(pending.items[0].expectedPrice, changedPrice)
  assert.equal(pending.items[0].targetPrice, 70400)
  const failureReceipt = await sync.receipts({ items: [{ id: pending.items[0].id, error: '1C TEST temporarily unavailable' }] })
  assert.equal(failureReceipt.results[0].status, 'PENDING')
  assert.equal((await sync.pending()).items.length, 1) // safe retry, no lost update
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: ids[0] } })).price, changedPrice)
  await assert.rejects(() => sync.configureScope({ oneCIds: ids.slice(0,2) }))

  // An old 1C catalog snapshot leaves the current site price unchanged while delivery is pending.
  await integration.importCatalog({ categories: [category], products: [{ ...products[0], price: changedPrice }] })
  ours = await prisma.product.findUniqueOrThrow({ where: { oneCId: ids[0] } })
  assert.equal(ours.price, changedPrice)
  await assert.rejects(() => monitor.applyRecommended(link.id, {
    expectedCurrentPrice: changedPrice, expectedCompetitorPrice: 70900,
    targetPrice: 70400, acceptUnknownCost: false, acceptLargeChange: false,
  }))
  // The site price changes only after 1C confirms the posted retail-price document.
  const acknowledgement = await sync.receipts({ items: [{ id: pending.items[0].id, appliedPrice: 70400 }] })
  assert.equal(acknowledgement.results[0].status, 'DELIVERED')
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: ids[0] } })).price, 70400)
  assert.equal((await sync.pending()).items.length, 0)
  await integration.importCatalog({ categories: [category], products: [{ ...products[0], price: 70400 }] })
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: ids[0] } })).price, 70400)
  // Another independent change in 1C is reflected on the site, no echo.
  await integration.importCatalog({ categories: [category], products: [{ ...products[0], price: 72500 }] })
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: ids[0] } })).price, 72500)
  assert.equal((await sync.pending()).items.length, 0)
})

test('Initial matching caches one verified 05.ru card per URL but price monitoring always reads fresh', async () => {
  const parser = new FiveRuParser()
  let pageReads = 0
  const url = fixture.sourceUrl
  parser.parse = async target => {
    pageReads++
    return { ...extractFiveRu(fixture.snapshot, url), url: target, price: 90000 + pageReads }
  }
  const [first, second] = await Promise.all([parser.parseForMatching(url), parser.parseForMatching(url)])
  assert.equal(pageReads, 1)
  assert.equal(first.price, second.price)
  assert.equal((await parser.parseForMatching(url)).price, first.price)
  assert.equal(pageReads, 1)
  const monitored = await parser.parse(url)
  assert.equal(monitored.price, first.price + 1)
  assert.equal(pageReads, 2)
})

test('Smartphone discovery stops after two clean searches returning the same unique exact URL', async () => {
  await prisma.monitorJob.updateMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  })
  const id = randomUUID(), categoryId = randomUUID()
  const categoryPath = 'FAST MATCH ' + id
  const original = {
    oneCId: id, sku: 'FAST-' + id, slug: 'fast-' + id,
    name: 'Смартфон Apple iPhone 17 Pro 12 Гб/256 Гб оранжевый (E-Sim)',
    brand: 'Apple', categoryOneCId: categoryId, price: 100000, stockQty: 2,
  }
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: categoryId, name: categoryPath, slug: 'fast-' + categoryId }],
    products: [original],
  })
  const url = fixture.sourceUrl.replace('24007/', 'fast-' + id + '/')
  const result = { ...extractFiveRu(fixture.snapshot, fixture.sourceUrl), url }
  let requests = 0
  const parser = {
    searchProducts: async () => { requests++; return [result] },
    parse: async () => result,
  }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const job = await monitor.autoFindOneCSection({ categoryPath, maxItems: 10 })
  await monitor.tick()
  const completed = await prisma.monitorJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(completed.processed, 1)
  assert.equal(completed.status, 'COMPLETED')
  assert.equal(requests, 2)
  const linked = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: url } })
  assert.equal(linked.matchStatus, 'CONFIRMED')
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: id } })).price, 100000)
})

test('Explicit eSIM in 1C selects exact 05.ru iPhone 17 Pro blue from index over a missing-SIM listing', async () => {
  const id = randomUUID(), categoryId = randomUUID()
  const categoryPath = 'BLUE ESIM INDEX ' + id
  const oneCName = 'Смартфон Apple iPhone 17 Pro 256 Гб eSIM синий'
  const exactUrl = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-256-gb-siniy-e-sim-bez-rustore-24126/'
  const unknownUrl = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-256-gb-siniy-' + id + '/'
  const exactName = 'Смартфон Apple iPhone 17 Pro 12 Гб/256 Гб синий (E-Sim, без RuStore)'
  const unknownName = 'Смартфон Apple iPhone 17 Pro 12 Гб/256 Гб синий (без RuStore)'
  assert.equal(compareItems({ name: oneCName }, { name: exactName }).canAutoConfirm, true)
  assert.equal(compareItems({ name: oneCName }, { name: unknownName }).canAutoConfirm, false)
  assert.match(oneCSearchQueries({ name: oneCName })[0], /e sim$/)

  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: categoryId, name: categoryPath, slug: 'blue-esim-' + categoryId }],
    products: [{ oneCId: id, sku: 'BLUE-ESIM-' + id, slug: 'blue-esim-' + id,
      name: oneCName, brand: 'Apple', categoryOneCId: categoryId,
      price: 99900, stockQty: 1 }],
  })
  const links = [
    { url: exactUrl, title: exactName, price: 96990 },
    { url: unknownUrl, title: unknownName, price: 97990 },
  ]
  for (const link of links) {
    await prisma.competitorCatalogEntry.upsert({
      where: { externalUrl: link.url },
      update: { title: link.title, model: 'iphone 17 pro', storage: '256', color: 'blue' },
      create: { externalUrl: link.url, title: link.title, model: 'iphone 17 pro',
        storage: '256', color: 'blue', lastSeenAt: new Date() },
    })
  }
  const parsed = new Map(links.map(link => [link.url, {
    url: link.url, name: link.title, brand: 'Apple',
    attributes: identity({ name: link.title, brand: 'Apple' }),
    price: link.price, inStock: true, categoryName: 'Смартфоны', seller: '05.ru',
  }]))
  let searches = 0
  const monitor = new PriceMonitorService(prisma, {
    parse: async url => {
      const match = parsed.get(url)
      if (!match) throw Error('Foreign fixture, skip this URL')
      return match
    },
    searchProducts: async () => { searches++; return [] },
  }, new MonitorExchangeService(prisma))
  const job = await monitor.autoFindOneCSection({ categoryPath, maxItems: 1 })
  await monitor.tick()

  const status = await prisma.monitorJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(status.status, 'COMPLETED')
  assert.equal(status.errors, 0, status.lastError || '')
  assert.equal(searches, 0, 'A verified exact index match should skip public search')
  const product = await prisma.product.findUniqueOrThrow({ where: { oneCId: id } })
  const exact = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: exactUrl } })
  assert.equal(exact.productId, product.id)
  assert.equal(exact.matchStatus, 'CONFIRMED')
  assert.equal(exact.latestPrice, 96990)
  assert.equal(product.price, 99900, '1C/site price must not change')
})

test('A 1C smartphone with unspecified SIM never auto-picks between different 05.ru SIM variants', async () => {
  const id = randomUUID(), categoryId = randomUUID()
  const categoryPath = 'SIM DECISION ' + id
  const ours = {
    oneCId: id, sku: 'SIM-DECISION-' + id, slug: 'sim-decision-' + id,
    name: 'Смартфон Apple iPhone 17 256 Гб белый',
    brand: 'Apple', categoryOneCId: categoryId, price: 79900, stockQty: 2,
  }
  const plainName = 'Смартфон Apple iPhone 17 8 Гб/256 Гб белый'
  const esimName = 'Смартфон Apple iPhone 17 8 Гб/256 Гб белый (E-Sim)'
  const plainUrl = 'https://05.ru/cat/396f7486/p/iphone-17-256-white-' + id + '/'
  const esimUrl = 'https://05.ru/cat/396f7486/p/iphone-17-256-white-esim-' + id + '/'
  const makeResult = (url, name, price) => ({
    url, name, brand: 'Apple', attributes: identity({ name, brand: 'Apple' }),
    categoryName: 'Смартфоны', price, inStock: true, seller: '05.ru',
  })
  const plain = makeResult(plainUrl, plainName, 74990)
  const esim = makeResult(esimUrl, esimName, 73990)
  const plainCheck = compareItems(ours, plain)
  const esimCheck = compareItems(ours, esim)
  assert.equal(plainCheck.canAutoConfirm, true)
  assert.equal(esimCheck.canAutoConfirm, true)
  assert.equal(plainCheck.ours.sim, undefined)
  assert.equal(esimCheck.theirs.sim, 'esim')
  assert(plainCheck.score > esimCheck.score, 'The exact title without an unspecified SIM suffix should rank first')

  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: categoryId, name: categoryPath, slug: 'sim-decision-group-' + categoryId }],
    products: [ours],
  })
  const parser = { searchProducts: async () => [plain, esim] }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const job = await monitor.autoFindOneCSection({ categoryPath, maxItems: 10 })
  await monitor.tick()

  const completed = await prisma.monitorJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(completed.status, 'COMPLETED')
  assert.equal(completed.errors, 0)
  const product = await prisma.product.findUniqueOrThrow({ where: { oneCId: id } })
  const selected = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: plainUrl } })
  assert.equal(selected.productId, product.id)
  assert.equal(selected.matchStatus, 'SUGGESTED')
  assert.equal(selected.latestPrice, 74990)
  assert.equal(await prisma.competitorProduct.count({ where: { externalUrl: esimUrl } }), 1)
})

test('Universal selection: parent group includes nested 1C category; 05.ru auto-match never changes site prices', async () => {
  const id = randomUUID()
  const catId = randomUUID()
  const uniqueName = 'Apple iPhone 18 Pro 12GB/256GB Cosmic Orange eSIM'
  const uniqueSnapshot = { ...fixture.snapshot,
    h1: fixture.snapshot.h1.replace('iPhone 17 Pro', 'iPhone 18 Pro'),
    scripts: fixture.snapshot.scripts.map(text => text.replaceAll('iPhone 17 Pro', 'iPhone 18 Pro')),
  }
  const ours = { oneCId: id, sku: 'UNIVERSAL-'+id, slug: 'universal-'+id,
    name: uniqueName, brand: 'Apple', categoryOneCId: catId,
    price: 99990, stockQty: 2, costPrice: 80000 }
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: catId, name: 'Мобильная связь / Смартфоны / Apple', slug: 'universal-group-'+catId }],
    products: [ours],
  })
  const sourceUrl = fixture.sourceUrl.replace('24007/', 'universal-'+id+'/')
  let searches = 0
  const parser = { searchProducts: async query => {
    searches++
    if (searches === 1) throw new Error("Search timeout")
    assert(/iphone/i.test(query))
    return [{ ...extractFiveRu(uniqueSnapshot, fixture.sourceUrl), url: sourceUrl }]
  } }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  await assert.rejects(() => monitor.autoFindOneCSection({ categoryPath: 'Несуществующая группа', maxItems: 10 }))
  const job = await monitor.autoFindOneCSection({ categoryPath: 'Мобильная связь / Смартфоны', maxItems: 10 })
  assert.equal(job.eligible, 1)
  assert.equal(job.queued, 1)
  await monitor.tick()
  const finished = await prisma.monitorJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(finished.status, 'COMPLETED')
  assert.equal(finished.processed, 1)
  assert.equal(searches, 3) // All three smartphone search variants are checked.
  const matched = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: sourceUrl } })
  const original = await prisma.product.findUniqueOrThrow({ where: { oneCId: id } })
  assert.equal(matched.productId, original.id)
  assert.equal(original.price, 99990)
  assert.equal(matched.matchStatus, 'CONFIRMED') // One exact full variant is linked automatically.
  await monitor.confirm(matched.id, original.id)
  assert.equal((await prisma.competitorProduct.findUniqueOrThrow({ where: { id: matched.id } })).matchStatus, 'CONFIRMED')
})

test('Auto-matching refreshes an existing 05.ru link even when storefront search returns zero links', async () => {
  const id = randomUUID(), categoryId = randomUUID()
  const integration = new IntegrationsService(prisma, {})
  const categoryPath = 'Изолированная группа для обновления сохранённой карточки ' + id
  await integration.importCatalog({
    categories: [{ oneCId: categoryId, name: categoryPath, slug: 'known-link-' + id }],
    products: [{ oneCId: id, sku: 'KNOWN-'+id, slug: 'known-'+id, categoryOneCId: categoryId,
      name: 'Смартфон Apple iPhone 17 Pro 256 Гб eSIM оранжевый', brand: 'Apple',
      price: 91900, stockQty: 3, costPrice: 80000 }],
  })
  const own = await prisma.product.findUniqueOrThrow({ where: { oneCId: id } })
  const existingUrl = fixture.sourceUrl.replace('24007/', 'saved-' + id + '/')
  const parsed = { ...extractFiveRu(fixture.snapshot, fixture.sourceUrl), url: existingUrl }
  const { fingerprint } = require('../dist/price-monitor/product-matching')
  const source = await prisma.competitorSource.upsert({
    where: { key: '05ru' }, update: {}, create: { key: '05ru', name: '05.ru', baseUrl: 'https://05.ru' },
  })
  await prisma.competitorProduct.create({ data: {
    sourceId: source.id, externalUrl: existingUrl, externalName: parsed.name,
    attributes: parsed.attributes, productId: own.id, matchStatus: 'CONFIRMED',
    confirmedFingerprint: fingerprint({ name: parsed.name, attributes: parsed.attributes }),
    confirmedProductFingerprint: fingerprint(own),
    lastSuccessAt: new Date(Date.now() - 2 * 24 * 3600_000), latestPrice: 95000, inStock: true,
  } })
  let searchCalls = 0, parseCalls = 0
  const parser = {
    searchProducts: async () => { searchCalls++; return [] },
    parse: async url => { parseCalls++; assert.equal(url, existingUrl); return { ...parsed, price: 94990 } },
  }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  await monitor.autoFindOneCSection({ categoryPath, maxItems: 10 })
  await monitor.tick()
  const task = (await monitor.jobs()).find(job => job.kind === 'MATCH_1C' && job.url === categoryPath)
  const row = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: existingUrl } })
  assert.equal(task.status, 'COMPLETED')
  assert.equal(task.errors, 0)
  assert.equal(task.processed, 1)
  assert.equal(parseCalls, 1)
  assert.equal(searchCalls, 0)
  assert.equal(row.productId, own.id)
  assert.equal(row.matchStatus, 'CONFIRMED')
  assert.equal(row.latestPrice, 94990)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: own.id } })).price, 91900)

  // One slow 05.ru product must not cancel the rest of the batch.
  const secondId = randomUUID()
  const secondName = 'Смартфон Apple iPhone 18 Pro 512 Гб eSIM зеленый'
  await integration.importCatalog({ categories: [], products: [{
    oneCId: secondId, sku: 'NEXT-'+secondId, slug: 'next-'+secondId,
    categoryOneCId: categoryId, name: secondName, brand: 'Apple',
    price: 90000, stockQty: 2, costPrice: 65000,
  }] })
  const secondUrl = 'https://05.ru/cat/396f7486/p/test-iphone-18-pro-green-' + secondId + '/'
  const nextSnapshot = { ...fixture.snapshot, h1: 'Смартфон Apple iPhone 18 Pro 12 Гб/512 Гб зеленый (E-Sim)', specs: [{ label: 'Цвет', value: 'зеленый' }] }
  let searchCallsAfterTimeout = 0
  const failing = new PriceMonitorService(prisma, {
    searchProducts: async query => {
      searchCallsAfterTimeout++
      assert(/iphone 18 pro/.test(query))
      return [{ ...extractFiveRu(nextSnapshot, secondUrl), url: secondUrl }]
    },
    parse: async () => { throw new Error('Не удалось проверить 05.ru: page.goto: Timeout 30000ms exceeded') },
  }, new MonitorExchangeService(prisma))
  await failing.autoFindOneCSection({ categoryPath, maxItems: 10 })
  await failing.tick()
  await failing.tick()
  const newest = (await failing.jobs()).find(job => job.kind === 'MATCH_1C' && job.url === categoryPath)
  const last = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: existingUrl } })
  const next = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: secondUrl } })
  assert.equal(newest.status, 'COMPLETED')
  assert.equal(newest.processed, 2)
  assert.equal(newest.errors, 1)
  assert.equal(searchCallsAfterTimeout, 2) // Two clean matching searches converge on one exact URL.
  assert.match(newest.lastError, /повторная проверка не удалась/)
  assert.match(last.lastError, /Timeout 30000ms exceeded/)
  assert.equal(last.latestPrice, 94990)
  assert.equal(next.externalName, nextSnapshot.h1)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: secondId } })).price, 90000)
})

test('Non-phone matching stores incomplete variants as SUGGESTED, without changing 1C price', async () => {
  const seed = randomUUID(), catId = randomUUID(), name = 'СЗУ Breaking P09 USB-C GaN 25W белый'
  const url = 'https://05.ru/cat/a/p/zaryadnoe-ustroystvo-breaking-p09-25w-' + seed + '/'
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: catId, name: 'Зарядные устройства / Тест ' + seed, slug: 'soft-cat-' + seed }],
    products: [{
      oneCId: seed, sku: 'SOFT-'+seed, slug: 'soft-'+seed, name,
      brand: 'Breaking', categoryOneCId: catId, price: 1990, stockQty: 5, costPrice: 900,
    }],
  })
  const externalName = 'Зарядное устройство Breaking P09 USB-C GaN 25W'
  const result = {
    name: externalName, price: 1290, oldPrice: null, inStock: true, externalSku: null,
    categoryName: 'Зарядные устройства', brand: 'Breaking', url,
    attributes: identity({ name: externalName, brand: 'Breaking' }),
    seller: '05.ru', region: null, priceSource: 'JSON-LD Offer',
  }
  let searchCalls = 0
  const parser = { searchProducts: async () => { searchCalls++; return [result] } }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const job = await monitor.autoFindOneCSection({ categoryPath: 'Зарядные устройства / Тест ' + seed, maxItems: 10 })
  await monitor.tick()
  const checked = await prisma.monitorJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(checked.status, 'COMPLETED')
  assert.equal(checked.errors, 0)
  assert(searchCalls >= 1)
  const link = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: url } })
  const product = await prisma.product.findUniqueOrThrow({ where: { oneCId: seed } })
  assert.equal(link.productId, product.id)
  assert.equal(link.matchStatus, 'SUGGESTED')
  assert.equal(product.price, 1990)
  assert.equal(link.latestPrice, 1290)
  assert.equal(await prisma.monitorDelivery.count({ where: { linkId: link.id, status: 'PENDING' } }), 0)
  const candidates = await monitor.candidates(link.id)
  assert.equal(candidates[0].product.id, product.id)
  assert(candidates[0].reviewScore >= 20)
  // Explicit human confirmation is supported when the only missing detail
  // is unspecified on 05.ru; no auto-approval happens during discovery.
  const confirmed = await monitor.confirm(link.id, product.id)
  assert.equal(confirmed.matchStatus, 'CONFIRMED')
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: seed } })).price, 1990)
})

test('Daily price refresh queues only confirmed links and never discovers products', async () => {
  const sourceUrls = [
    'https://05.ru/cat/a/p/test-linked-a-101/',
    'https://05.ru/cat/a/p/test-linked-b-102/',
  ]
  let observedQuery, savedJob
  const prismaStub = {
    monitorJob: {
      count: async () => 0,
      create: async input => { savedJob = input.data; return { id: 'job-recheck', ...input.data } },
    },
    competitorProduct: {
      findMany: async input => { observedQuery = input.where; return sourceUrls.map(externalUrl => ({ externalUrl })) },
    },
  }
  const parser = { searchProducts: async () => { throw Error('Search must not run') } }
  const monitor = new PriceMonitorService(prismaStub, parser, {})
  const job = await monitor.checkAll()
  assert.equal(job.kind, 'RECHECK')
  assert.equal(savedJob.perPage, 2)
  assert.deepEqual(savedJob.pendingUrls, sourceUrls)
  assert.equal(observedQuery.matchStatus, 'CONFIRMED')
  assert.equal(observedQuery.product.is.oneCId.not, null)
})

test('Four direct price reads run concurrently; SQLite snapshots are saved serially', async () => {
  const urls = Array.from({ length: 6 }, (_, i) => 'https://05.ru/cat/a/p/saved-' + i + '/')
  let reads = 0, maxReads = 0, writes = 0, maxWrites = 0, searchCalls = 0
  let savedJob
  const parser = {
    parse: async url => {
      reads++
      maxReads = Math.max(reads, maxReads)
      await new Promise(resolve => setTimeout(resolve, 20))
      reads--
      return { ...extractFiveRu(fixture.snapshot, fixture.sourceUrl), url }
    },
    searchProducts: async () => { searchCalls++; return [] },
  }
  const prismaStub = {
    competitorProduct: {
      findUnique: async () => ({ productId: 1, matchStatus: 'CONFIRMED' }),
      updateMany: async () => ({ count: 1 }),
    },
    monitorJob: { updateMany: async input => { savedJob = input.data; return { count: 1 } } },
  }
  const monitor = new PriceMonitorService(prismaStub, parser, {})
  monitor.source = async () => ({ id: '05ru' })
  monitor.save = async () => {
    writes++
    maxWrites = Math.max(maxWrites, writes)
    await new Promise(resolve => setTimeout(resolve, 3))
    writes--
  }
  await monitor.recheckBatch('job', urls)
  assert.equal(maxReads, 4)
  assert.equal(maxWrites, 1)
  assert.equal(searchCalls, 0)
  assert.deepEqual(savedJob.pendingUrls, urls.slice(4))
  assert.equal(savedJob.processed.increment, 4)
  assert.equal(savedJob.errors.increment, 0)
  assert.equal(savedJob.status, 'QUEUED')
})

test('Site rate limit pauses direct price refresh and retains only blocked URLs', async () => {
  const urls = Array.from({ length: 5 }, (_, i) => 'https://05.ru/cat/a/p/saved-blocked-' + i + '/')
  let savedJob, successes = 0, errors = 0
  const parser = { parse: async url => {
    if (url === urls[1]) throw Error('HTTP 429')
    return { ...extractFiveRu(fixture.snapshot, fixture.sourceUrl), url }
  } }
  const prismaStub = {
    competitorProduct: {
      findUnique: async () => ({ productId: 1, matchStatus: 'CONFIRMED' }),
      updateMany: async () => { errors++; return { count: 1 } },
    },
    monitorJob: { updateMany: async input => { savedJob = input.data; return { count: 1 } } },
  }
  const monitor = new PriceMonitorService(prismaStub, parser, {})
  monitor.source = async () => ({ id: '05ru' })
  monitor.save = async () => { successes++ }
  await monitor.recheckBatch('job', urls)
  assert.equal(successes, 3)
  assert.equal(errors, 0)
  assert.equal(savedJob.status, 'FAILED')
  assert.equal(savedJob.processed.increment, 3)
  assert.equal(savedJob.errors.increment, 0)
  assert.deepEqual(savedJob.pendingUrls, [urls[1], urls[4]])
  assert.match(savedJob.lastError, /ограничил запросы/)
})

test('One failed product retains its previous price and batch finishes other links', async () => {
  const urls = Array.from({ length: 3 }, (_, i) => 'https://05.ru/cat/a/p/saved-timeout-' + i + '/')
  const failed = []
  let savedJob, successes = 0
  const parser = { parse: async url => {
    if (url === urls[1]) throw Error('Timeout 20000ms exceeded')
    return { ...extractFiveRu(fixture.snapshot, fixture.sourceUrl), url }
  } }
  const prismaStub = {
    competitorProduct: {
      findUnique: async () => ({ productId: 1, matchStatus: 'CONFIRMED' }),
      updateMany: async input => { failed.push(input); return { count: 1 } },
    },
    monitorJob: { updateMany: async input => { savedJob = input.data; return { count: 1 } } },
  }
  const monitor = new PriceMonitorService(prismaStub, parser, {})
  monitor.source = async () => ({ id: '05ru' })
  monitor.save = async () => { successes++ }
  await monitor.recheckBatch('job', urls)
  assert.equal(successes, 2)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].where.externalUrl, urls[1])
  assert.equal(Object.hasOwn(failed[0].data, 'latestPrice'), false)
  assert.equal(savedJob.status, 'COMPLETED')
  assert.equal(savedJob.processed.increment, 3)
  assert.equal(savedJob.errors.increment, 1)
  assert.deepEqual(savedJob.pendingUrls, [])
})

test('Manual URL binding rejects a product URL already assigned elsewhere', async () => {
  const monitor = new PriceMonitorService({
    product: { findUnique: async () => ({ id: 1001 }) },
    competitorProduct: { findUnique: async () => ({ productId: 2002 }) },
  }, { parse: async () => { throw Error('Must not parse') } }, {})
  await assert.rejects(
    () => monitor.check({ url: fixture.sourceUrl, productId: 1001 }),
    /уже связана с другим товаром/,
  )
})

test('Confirmed 05.ru mapping is one-to-one: one URL per 1C product and one 1C product per URL', async () => {
  const idA = randomUUID(), idB = randomUUID(), categoryId = randomUUID()
  const integration = new IntegrationsService(prisma, {})
  const nameB = 'Apple iPhone 18 Pro 12GB/256GB Cosmic Orange eSIM'
  const snapshotB = {
    ...fixture.snapshot,
    h1: fixture.snapshot.h1.replace('iPhone 17 Pro', 'iPhone 18 Pro'),
    scripts: fixture.snapshot.scripts.map(text => text.replaceAll('iPhone 17 Pro', 'iPhone 18 Pro')),
  }
  await integration.importCatalog({
    categories: [{ oneCId: categoryId, name: 'Тестовые смартфоны ' + categoryId, slug: 'one-to-one-' + categoryId }],
    products: [
      { oneCId: idA, sku: 'MAP-A-' + idA, slug: 'map-a-' + idA, categoryOneCId: categoryId,
        name: product.name, brand: 'Apple', price: 99990, stockQty: 2 },
      { oneCId: idB, sku: 'MAP-B-' + idB, slug: 'map-b-' + idB, categoryOneCId: categoryId,
        name: nameB, brand: 'Apple', price: 99990, stockQty: 2 },
    ],
  })
  const a = await prisma.product.findUniqueOrThrow({ where: { oneCId: idA } })
  const b = await prisma.product.findUniqueOrThrow({ where: { oneCId: idB } })
  const urlA = fixture.sourceUrl.replace('24007/', 'mapping-a-' + idA + '/')
  const urlB = fixture.sourceUrl.replace('24007/', 'mapping-b-' + idB + '/')
  const parser = { parse: async url => ({
    ...extractFiveRu(url === urlA ? fixture.snapshot : snapshotB, url), url,
  }) }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const linkA = await monitor.check({ url: urlA, productId: a.id })
  await monitor.confirm(linkA.id, a.id)
  const linkB = await monitor.check({ url: urlB, productId: b.id })
  await monitor.confirm(linkB.id, b.id)

  await assert.rejects(() => monitor.confirm(linkA.id, b.id), /уже подтверждена для другого товара/)
  await monitor.unmatch(linkB.id)
  await assert.rejects(() => monitor.confirm(linkB.id, a.id), /У этого товара уже есть подтверждённая ссылка/)
})

test('Six-hour schedule is persisted and can be disabled without changing product prices', async () => {
  let saved
  const monitor = new PriceMonitorService({
    monitorSettings: { upsert: async input => {
      saved = input.update
      return { id: '05ru', ...input.update }
    } },
  }, {}, {})
  const enabled = await monitor.updateSettings({
    catalogUrl: 'https://05.ru/cat/c/02e38f8a/telefony_i_gadzety/',
    intervalMinutes: 360,
  })
  assert.equal(enabled.intervalMinutes, 360)
  assert(saved.nextRunAt instanceof Date)
  const disabled = await monitor.updateSettings({
    catalogUrl: 'https://05.ru/cat/c/02e38f8a/telefony_i_gadzety/',
    intervalMinutes: 0,
  })
  assert.equal(disabled.intervalMinutes, 0)
  assert.equal(disabled.nextRunAt, null)
})

test('Unlinked-only discovery excludes products already mapped to 05.ru', async () => {
  const products = [
    { id: 1, name: 'Apple iPhone 17 Pro 256 Гб', category: { name: 'Смартфоны' }, oneCId: '1', status: 'ACTIVE', price: 99000, stockQty: 1, reservedQty: 0 },
    { id: 2, name: 'Apple iPhone 18 Pro 256 Гб', category: { name: 'Смартфоны' }, oneCId: '2', status: 'ACTIVE', price: 109000, stockQty: 1, reservedQty: 0 },
  ]
  let created
  const monitor = new PriceMonitorService({
    product: { findMany: async () => products },
    competitorProduct: { findMany: async () => [{ productId: 1 }] },
    monitorJob: {
      count: async () => 0,
      create: async input => { created = input.data; return { id: 'discovery', ...input.data } },
    },
  }, {}, {})
  const job = await monitor.autoFindOneCSection({ categoryPath: 'Смартфоны', maxItems: 10, onlyUnlinked: true })
  assert.equal(job.eligible, 1)
  assert.equal(job.queued, 1)
  assert.deepEqual(created.pendingUrls, ['product:2'])
})

test('Direct 05.ru search URL returns unique ranked product links, checks live cards and caches repeat queries', async () => {
  const parser = new FiveRuParser()
  const orange256 = fixture.sourceUrl
  const orange1tb = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-1-tb-oranzheviy-e-sim-bez-rustore-34464/'
  const blue256 = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-256-gb-siniy-e-sim-bez-rustore-24126/'
  const orange512 = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-512-gb-oranzheviy-12345/'
  const white256 = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-256-gb-beliy-12346/'
  const productLinks = [
    { url: orange1tb, title: 'Смартфон Apple iPhone 17 Pro 1 ТБ оранжевый' },
    { url: orange256, title: fixture.snapshot.h1 },
    { url: blue256, title: 'Смартфон Apple iPhone 17 Pro 256 ГБ синий' },
    { url: white256, title: 'Смартфон Apple iPhone 17 Pro 256 ГБ белый' },
    { url: orange512, title: 'Смартфон Apple iPhone 17 Pro 512 ГБ оранжевый' },
    { url: 'https://05.ru/cat/x/p/chehol-iphone-17-pro-256-123/', title: 'Чехол iPhone 17 Pro 256' },
    { url: 'https://05.ru/cat/x/p/iphone-17-pro-max-256-456/', title: 'Смартфон Apple iPhone 17 Pro Max 256' },
    { url: 'https://other.example/cat/x/p/iphone-17-pro-256-789/', title: 'Другой сайт' },
  ]
  // Real search page has 32 anchors, with several anchors per actual product.
  let links = Array.from({ length: 32 }, (_, i) => productLinks[i % productLinks.length])
  let responseStatus = 200
  let launches = 0, closings = 0, contexts = 0, pageCloses = 0, cardOpens = 0, active = 0, maxActive = 0
  const navigations = [], opened = []
  parser.browser = async () => {
    launches++
    return { isConnected: () => true, close: async () => { closings++ } }
  }
  parser.context = async () => {
    contexts++
    let currentUrl = ''
    return {
      newPage: async () => ({
        goto: async (url, options) => {
          currentUrl = url; navigations.push(url)
          assert.equal(options.waitUntil, 'commit')
          assert.equal(options.timeout, 20_000)
          const parsed = new URL(url)
          assert.equal(parsed.origin, 'https://05.ru')
          assert.equal(parsed.pathname, '/search/')
          assert(['1', '2', '3', '4', '5'].includes(parsed.searchParams.get('page')))
          assert(parsed.searchParams.has('q'))
          return { status: () => responseStatus }
        },
        url: () => currentUrl,
        locator: () => ({
          first: () => ({ waitFor: async () => {} }),
          evaluateAll: async () => links,
        }),
        close: async () => { pageCloses++ },
      }),
      close: async () => {},
    }
  }
  parser.open = async (_, url) => {
    cardOpens++; opened.push(url)
    return { close: async () => {} }
  }
  parser.snapshot = async () => {
    active++; maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 10))
    active--
    return fixture.snapshot
  }
  try {
    parser.smartphoneCatalogLinks = async () => []
    const trace = {}
    const found = await parser.searchProducts('iPhone 17 Pro 256', 3, trace)
    assert.equal(found.length, 3)
    assert.equal(trace.linksFound, 7) // valid 05.ru links, deduplicated
    assert.equal(trace.rankedLinks, 3) // candidates selected after title/variant ranking
    assert.equal(trace.searchMode, 'direct-search')
    assert.equal(trace.cardsParsed, 3)
    assert.equal(trace.searchPages, 1) // The mocked second page repeats page one and is ignored.
    assert.equal(opened[0], orange256) // not the first 1TB card in the feed
    assert.equal(cardOpens, 3)
    assert.equal(maxActive, 2)
    assert.equal(launches, 1)
    assert.equal(pageCloses, 1)
    assert.equal(new URL(navigations[0]).searchParams.get('q'), 'iPhone 17 Pro 256')
    assert.deepEqual(navigations.slice(0, 2).map(url => new URL(url).searchParams.get('page')), ['1', '2'])
    const again = await parser.searchProducts('  iPhone 17 Pro 256  ', 3, {})
    assert.equal(again.length, 3)
    assert.equal(cardOpens, 3) // cache avoids extra site requests
    assert.equal(contexts, 1)

    const originalOpen = parser.open
    parser.open = async (context, url) => {
      if (url === orange256) throw new Error('Timeout 20000ms exceeded')
      return originalOpen(context, url)
    }
    const partialTrace = {}
    const partial = await parser.searchProducts('iPhone 17 Pro 256 GB', 3, partialTrace)
    assert.equal(partial.length, 2)
    assert.equal(partialTrace.rejectedCards.length, 1)
    parser.open = originalOpen
    const recovered = await parser.searchProducts('iPhone 17 Pro 256 GB', 3, {})
    assert.equal(recovered.length, 3) // Partial results must not poison the query cache.
    links = []
    const emptyTrace = {}
    await assert.rejects(() => parser.searchProducts('Nonexistent model', 3, emptyTrace), /Поиск 05.ru.*строгий и расширенный подбор/)
    assert.equal(emptyTrace.linksFound, 0)
    assert.equal(emptyTrace.rankedLinks, 0)
    assert.equal(emptyTrace.searchMode, 'direct-search')
    assert.equal(contexts, 4)
    responseStatus = 403
    await assert.rejects(() => parser.searchProducts('Another nonexistent model', 3), /HTTP 403/)
    assert.equal(contexts, 5)
  } finally { await parser.onModuleDestroy() }
  assert.equal(closings, 1)
})

test('Smartphone category crawl starts on page 1 and advances to page 2 when no next link is exposed', async () => {
  const parser = new FiveRuParser()
  const base = 'https://05.ru/cat/mc/396f7486/smartfony/'
  const first = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-13-128-gb-siniy-11197/'
  const second = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-16-256-gb-rozoviy-17743/'
  const navigations = []
  const pages = new Map([
    [base, { links: [{ url: first, title: 'Смартфон Apple iPhone 13 128 Гб синий' }], next: null }],
    [base + '?page=2', { links: [{ url: second, title: 'Смартфон Apple iPhone 16 256 Гб розовый' }], next: null }],
    [base + '?page=3', { links: [], next: null }],
  ])
  parser.browser = async () => ({ isConnected: () => true, close: async () => {} })
  parser.context = async () => ({
    newPage: async () => {
      let currentUrl = ''
      return {
        goto: async url => { currentUrl = url; navigations.push(url); return { status: () => 200 } },
        url: () => currentUrl,
        locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
        evaluate: async fn => fn.toString().includes('scrollTo') ? undefined : pages.get(currentUrl),
        waitForTimeout: async () => {},
        close: async () => {},
      }
    },
    close: async () => {},
  })
  const context = await parser.context({}, true)
  try {
    const links = await parser.smartphoneCatalogLinks(context)
    assert.deepEqual(links.map(link => link.url), [first, second])
    assert.deepEqual(navigations, [base, base + '?page=2', base + '?page=3'])
  } finally {
    await context.close()
    await parser.onModuleDestroy()
  }
})

test('Search discovery reads later result pages when the exact smartphone is not on page one', async () => {
  const parser = new FiveRuParser()
  const wrong = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-256-gb-oranzheviy-90001/'
  const exact = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-13-128-gb-siniy-bez-rustore-11197/'
  let currentUrl = ''
  const opened = []
  parser.browser = async () => ({ isConnected: () => true, close: async () => {} })
  parser.context = async () => ({
    newPage: async () => ({
      goto: async url => { currentUrl = url; return { status: () => 200 } },
      url: () => currentUrl,
      locator: () => ({
        first: () => ({ waitFor: async () => {} }),
        evaluateAll: async () => new URL(currentUrl).searchParams.get('page') === '1'
          ? [{ url: wrong, title: 'Смартфон Apple iPhone 17 Pro 256 ГБ оранжевый' }]
          : new URL(currentUrl).searchParams.get('page') === '2'
            ? [{ url: exact, title: 'Смартфон Apple iPhone 13 128 ГБ синий' }]
            : [],
      }),
      close: async () => {},
    }),
    close: async () => {},
  })
  parser.smartphoneCatalogLinks = async () => []
  parser.open = async (_, url) => { opened.push(url); return { close: async () => {} } }
  parser.snapshot = async () => fixture.snapshot
  try {
    const trace = {}
    const results = await parser.searchProducts('iphone 13 128', 1, trace)
    assert.deepEqual(opened, [exact])
    assert.equal(results.length, 1)
    assert.equal(trace.linksFound, 2)
    assert.equal(trace.rankedLinks, 1)
    assert.equal(trace.searchPages, 2)
  } finally {
    await parser.onModuleDestroy()
  }
})

test('Smartphone search merges the public category crawl when direct search returns the wrong variant', async () => {
  const parser = new FiveRuParser()
  const directWrong = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-1-tb-oranzheviy-34464/'
  const categoryMatch = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-256-gb-oranzheviy-24007/'
  let currentUrl = ''
  const opened = []
  parser.browser = async () => ({ isConnected: () => true, close: async () => {} })
  parser.context = async () => ({
    newPage: async () => ({
      goto: async url => { currentUrl = url; return { status: () => 200 } },
      url: () => currentUrl,
      locator: () => ({
        first: () => ({ waitFor: async () => {} }),
        evaluateAll: async () => [{ url: directWrong, title: 'Смартфон Apple iPhone 17 Pro 1 ТБ оранжевый' }],
      }),
      close: async () => {},
    }),
    close: async () => {},
  })
  parser.smartphoneCatalogLinks = async () => [{
    url: categoryMatch, title: 'Смартфон Apple iPhone 17 Pro 256 ГБ оранжевый',
  }]
  parser.open = async (_, url) => {
    opened.push(url)
    return { close: async () => {} }
  }
  parser.snapshot = async () => fixture.snapshot
  try {
    const trace = {}
    const result = await parser.searchProducts('iPhone 17 Pro 256', 1, trace)
    assert.deepEqual(opened, [categoryMatch])
    assert.equal(result.length, 1)
    assert.equal(trace.linksFound, 2)
    assert.equal(trace.searchMode, 'direct+smartphone-catalog')
  } finally {
    await parser.onModuleDestroy()
  }
})

test('05.ru recall fallback opens smartphone pages when strict title ranking rejects a noisy tile', async () => {
  const parser = new FiveRuParser()
  const a26 = 'https://05.ru/cat/396f7486/p/smartfon-samsung-galaxy-a26-8-256-gb-beliy-21147/'
  let currentUrl = ''
  const opened = []
  parser.browser = async () => ({ isConnected: () => true, close: async () => {} })
  parser.context = async () => ({
    newPage: async () => ({
      goto: async url => { currentUrl = url; return { status: () => 200 } },
      url: () => currentUrl,
      locator: () => ({
        first: () => ({ waitFor: async () => {} }),
        evaluateAll: async () => [],
      }),
      close: async () => {},
    }),
    close: async () => {},
  })
  parser.smartphoneCatalogLinks = async () => [{
    url: a26, title: 'Смартфон POCO A26 8 Гб/256 Гб белый',
  }]
  parser.open = async (_, url) => {
    opened.push(url)
    return { close: async () => {} }
  }
  parser.snapshot = async () => fixture.snapshot
  try {
    const trace = {}
    const results = await parser.searchProducts('samsung galaxy a26 128 черный', 18, trace)
    assert.deepEqual(opened, [a26])
    assert.equal(results.length, 1)
    assert.equal(trace.directLinksFound, 0)
    assert.equal(trace.catalogLinksFound, 1)
    assert.equal(trace.rankingMode, 'recall-inspection')
    assert.equal(trace.searchMode, 'direct+smartphone-catalog+recall')
    assert.equal(trace.cardsParsed, 1)
  } finally {
    await parser.onModuleDestroy()
  }
})

test('Business price-list import links 1C products safely, never claims 05.ru verification and rolls back invalid rows', async () => {
  const categoryId = randomUUID(), id = randomUUID(), secondId = randomUUID()
  const categoryPath = 'Бизнес импорт тест ' + categoryId
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: categoryId, slug: 'business-import-' + categoryId, name: categoryPath }],
    products: [
      { oneCId: id, sku: 'BUS-'+id, slug: 'business-'+id, name: product.name, brand: 'Apple',
        categoryOneCId: categoryId, price: 91000, stockQty: 3, costPrice: 78000 },
      { oneCId: secondId, sku: 'BUS-'+secondId, slug: 'business-'+secondId, name: 'Apple iPhone 17 Pro Max 512GB Blue eSIM', brand: 'Apple',
        categoryOneCId: categoryId, price: 120000, stockQty: 2, costPrice: 94000 },
    ],
  })
  const link = 'https://05.ru/cat/test/p/iphone-17-pro-256-orange-' + id + '/'
  const observedAt = new Date().toISOString()
  const row = { oneCId: id, url: link, name: fixture.snapshot.h1,
    price: 94990, observedAt, inStock: true }
  const monitor = new PriceMonitorService(prisma, { parse: async () => { throw new Error('Live site must not be opened') } }, new MonitorExchangeService(prisma))
  const result = await monitor.importManualPrices({ rows: [row] })
  assert.deepEqual([result.imported, result.created, result.associated, result.verifiedOn05Ru], [1, 1, 1, false])
  let saved = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: link } })
  const ours = await prisma.product.findUniqueOrThrow({ where: { oneCId: id } })
  assert.equal(saved.productId, ours.id)
  assert.equal(saved.matchStatus, 'SUGGESTED')
  assert.equal(saved.priceSource, 'USER_FILE')
  assert.equal(saved.lastSuccessAt, null)
  assert.match(saved.lastError, /не проверена на 05.ru/)
  assert.equal(saved.latestPrice, 94990)
  assert.equal((await monitor.list()).find(p => p.id === saved.id).recommendedPrice, null)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: id } })).price, 91000)
  assert.equal((await prisma.monitorDelivery.count({ where: { linkId: saved.id } })), 0)
  await monitor.importManualPrices({ rows: [row] })
  assert.equal(await prisma.competitorPriceHistory.count({ where: { competitorProductId: saved.id } }), 1)

  const other = 'https://05.ru/cat/test/p/iphone-17-pro-max-512-blue-' + secondId + '/'
  await assert.rejects(() => monitor.importManualPrices({ rows: [
    { ...row, price: 94000 },
    { oneCId: secondId, url: other, name: 'Apple iPhone 17 Pro 256GB Orange eSIM',
      price: 101000, observedAt },
  ] }), /не совпадают/)
  saved = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: link } })
  assert.equal(saved.latestPrice, 94990) // valid first row rolled back
  assert.equal(await prisma.competitorProduct.findUnique({ where: { externalUrl: other } }), null)
  await assert.rejects(() => monitor.importManualPrices({ rows: [
    { ...row, observedAt: new Date(Date.now() - 32 * 86400000).toISOString() },
  ] }), /последние 30 дней/)
  await assert.rejects(() => monitor.importManualPrices({ rows: [
    { ...row, url: 'https://05.ru/cat/test/p/iphone-17-pro-max-512-orange-999999/' },
  ] }), /ссылка 05.ru указывает на другую модель/)
  await assert.rejects(() => monitor.importManualPrices({ rows: [
    { ...row, url: 'https://05.ru.evil.example/cat/test/p/fake/' },
  ] }), /05.ru/)
})

test('05.ru parser uses headless installed Edge on Windows or Playwright Chromium elsewhere', async () => {
  const parser = new FiveRuParser()
  const oldPath = chromium.executablePath
  const oldLaunch = chromium.launch
  let options
  chromium.executablePath = () => process.execPath
  chromium.launch = async launchOptions => {
    options = launchOptions
    return { close: async () => {} }
  }
  try {
    const browser = await parser.browser()
    assert.equal(options.headless, true)
    if (process.platform === 'win32') assert.equal(options.channel, 'msedge')
    else assert.equal(Object.hasOwn(options, 'channel'), false)
    await browser.close()
  } finally {
    chromium.executablePath = oldPath
    chromium.launch = oldLaunch
  }
})

test('Missing browser reports a clear error without downloading Chromium', async () => {
  const parser = new FiveRuParser()
  const oldPath = chromium.executablePath
  const oldLaunch = chromium.launch
  const launches = []
  chromium.executablePath = () => 'Z:\\missing\\playwright\\chromium.exe'
  chromium.launch = async options => { launches.push(options); throw new Error('Browser unavailable') }
  try {
    await assert.rejects(() => parser.browser(), /Не найден браузер для фонового парсера/)
    assert.equal(launches.length, process.platform === 'win32' ? 1 : 0)
    if (process.platform === 'win32') assert.equal(launches[0].channel, 'msedge')
  } finally {
    chromium.executablePath = oldPath
    chromium.launch = oldLaunch
  }
})

test('Catalog discovery reuses the shared browser and closes its page and context', async () => {
  const parser = new FiveRuParser()
  let launches = 0, pageClosed = 0, contextClosed = 0, evaluations = 0
  const page = {
    locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
    evaluate: async () => {
      evaluations++
      if (evaluations <= 4) return
      return {
        links: ['https://05.ru/cat/x/p/smartfon-apple-iphone-17-pro-256-123/'],
        next: null,
        title: 'Тестовый каталог',
      }
    },
    waitForTimeout: async () => {},
    close: async () => { pageClosed++ },
  }
  const context = {
    newPage: async () => page,
    close: async () => { contextClosed++ },
  }
  const browser = {
    isConnected: () => true,
    newContext: async () => context,
    close: async () => {},
  }
  parser.browser = async () => { launches++; return browser }
  parser.context = async () => context
  parser.open = async () => page
  try {
    const result = await parser.discover('https://05.ru/cat/x/test/')
    assert.equal(result.urls.length, 1)
    assert.equal(result.title, 'Тестовый каталог')
    assert.equal(launches, 1)
    assert.equal(pageClosed, 1)
    assert.equal(contextClosed, 1)
  } finally {
    await parser.onModuleDestroy()
  }
})

test('Product page reader retries transient 5xx and accepts Product JSON-LD without a visible h1', async () => {
  const parser = new FiveRuParser()
  const url = fixture.sourceUrl
  let attempts = 0, closed = 0
  const context = {
    newPage: async () => ({
      goto: async (_, options) => {
        assert.equal(options.waitUntil, 'commit')
        attempts++
        return { status: () => attempts === 1 ? 503 : 200 }
      },
      url: () => url,
      locator: selector => selector === 'h1'
        ? { first: () => ({ waitFor: async () => { throw new Error('Timeout waiting for h1') } }) }
        : { evaluateAll: async () => true },
      waitForTimeout: async () => {},
      close: async () => { closed++ },
    }),
  }
  const page = await parser.open(context, url)
  assert.equal(attempts, 2)
  assert.equal(closed, 1)
  await page.close()
})

test('Direct product checks use response commit and reuse Chromium across checks', async () => {
  const parser = new FiveRuParser()
  let launches = 0, pageCloses = 0, contexts = 0, browserCloses = 0
  parser.browser = async () => {
    launches++
    return { isConnected: () => true, close: async () => { browserCloses++ } }
  }
  parser.context = async () => {
    contexts++
    return {
      newPage: async () => ({
        goto: async (_, options) => {
          assert.equal(options.waitUntil, 'commit')
          assert(options.timeout <= 30_000)
          return { status: () => 200 }
        },
        url: () => fixture.sourceUrl,
        locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
        waitForTimeout: async () => {},
        close: async () => { pageCloses++ },
      }),
      close: async () => {},
    }
  }
  parser.snapshot = async () => fixture.snapshot
  try {
    const first = await parser.parse(fixture.sourceUrl)
    const second = await parser.parse(fixture.sourceUrl)
    assert.equal(first.price, 96990)
    assert.equal(second.price, 96990)
    assert.equal(launches, 1)
    assert.equal(contexts, 2)
    assert.equal(pageCloses, 2)
  } finally { await parser.onModuleDestroy() }
  assert.equal(browserCloses, 1)
})


test('05.ru seller index reads distinct product pages using observed ?page=N pagination', async () => {
  const parser = new FiveRuParser()
  let launches = 0
  const navigations = []
  parser.browser = async () => {
    launches++
    return { isConnected: () => true, close: async () => {} }
  }
  parser.context = async () => ({
    newPage: async () => {
      let requestedUrl = ''
      return {
        goto: async (url, options) => {
          requestedUrl = url; navigations.push(url)
          assert.equal(options.waitUntil, 'commit')
          return { status: () => 200 }
        },
        url: () => requestedUrl,
        locator: () => ({ first: () => ({ waitFor: async () => {} }), evaluateAll: async () => {
          const n = new URL(requestedUrl).searchParams.get('page') || '1'
          return [{ url: 'https://05.ru/cat/396f7486/p/test-iphone-' + n + '/',
            title: 'Смартфон Apple iPhone 18 Pro 256 Гб оранжевый' }]
        } }),
        evaluate: async () => {},
        waitForTimeout: async () => {},
        close: async () => {},
      }
    },
    close: async () => {},
  })
  try {
    const first = await parser.indexCatalogPage(1)
    const second = await parser.indexCatalogPage(2)
    assert.equal(first.length, 1)
    assert.equal(second.length, 1)
    assert.notEqual(first[0].url, second[0].url)
    assert.deepEqual(navigations, [
      'https://05.ru/cat/seller/05-ru-133/',
      'https://05.ru/cat/seller/05-ru-133/?page=2',
    ])
    assert.equal(launches, 1)
  } finally { await parser.onModuleDestroy() }
})

test('05.ru smartphone index reads the public smartphone category with observed ?page=N pagination', async () => {
  const parser = new FiveRuParser()
  let launches = 0
  const navigations = []
  parser.browser = async () => {
    launches++
    return { isConnected: () => true, close: async () => {} }
  }
  parser.context = async () => ({
    newPage: async () => {
      let requestedUrl = ''
      return {
        goto: async (url, options) => {
          requestedUrl = url; navigations.push(url)
          assert.equal(options.waitUntil, 'commit')
          return { status: () => 200 }
        },
        url: () => requestedUrl,
        locator: () => ({
          first: () => ({ waitFor: async () => {} }),
          evaluateAll: async () => {
            const n = new URL(requestedUrl).searchParams.get('page') || '1'
            return [{ url: 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-18-pro-' + n + '/',
              title: 'Смартфон Apple iPhone 18 Pro 256 Гб оранжевый' }]
          },
        }),
        evaluate: async () => {},
        waitForTimeout: async () => {},
        close: async () => {},
      }
    },
    close: async () => {},
  })
  try {
    const first = await parser.indexSmartphoneCatalogPage(1)
    const second = await parser.indexSmartphoneCatalogPage(2)
    assert.equal(first.length, 1)
    assert.equal(second.length, 1)
    assert.notEqual(first[0].url, second[0].url)
    assert.deepEqual(navigations, [
      'https://05.ru/cat/mc/396f7486/smartfony/',
      'https://05.ru/cat/mc/396f7486/smartfony/?page=2',
    ])
    assert.equal(launches, 1)
  } finally { await parser.onModuleDestroy() }
})

test('Small 1C batch skips full 50-page crawl and cancels legacy empty index', async () => {
  await prisma.monitorJob.updateMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date(), leaseUntil: null },
  })
  const id = randomUUID(), categoryId = randomUUID()
  const categoryPath = 'FAST SMALL BATCH ' + id
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: categoryId, name: categoryPath, slug: 'fast-small-' + categoryId }],
    products: [{ oneCId: id, sku: 'FAST-SMALL-' + id, slug: 'fast-small-' + id,
      name: 'Смартфон Apple iPhone 99 Pro 256 Гб синий', brand: 'Apple',
      categoryOneCId: categoryId, price: 99900, stockQty: 1 }],
  })
  const searches = [], indexReads = []
  const parser = {
    indexSmartphoneCatalogPage: async page => {
      indexReads.push(page)
      throw new Error('Small batch must not read catalog pages')
    },
    searchProducts: async (...args) => {
      searches.push(args)
      return []
    },
  }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const task = await monitor.autoFindOneCSection({ categoryPath, maxItems: 13, indexCatalog: true })
  assert.equal(task.queued, 1)
  assert.equal(await prisma.monitorJob.count({
    where: { status: 'QUEUED', kind: 'INDEX_05RU_SMARTPHONES' },
  }), 0, 'No full index is created for small batches')
  // Simulate a previous TEXHORU build having left a 0/50 job pending.
  const oldIndex = await prisma.monitorJob.create({
    data: { kind: 'INDEX_05RU_SMARTPHONES', sourceKey: '05ru',
      url: 'https://05.ru/cat/mc/396f7486/smartfony/',
      page: 0, maxPages: 50, perPage: 24, processed: 0 },
  })
  await monitor.tick()
  const skipped = await prisma.monitorJob.findUniqueOrThrow({ where: { id: oldIndex.id } })
  assert.equal(skipped.status, 'CANCELLED')
  assert.deepEqual(indexReads, [])
  assert(searches.length > 0, 'Direct search should start on first tick')
  assert(searches.every(args => args[4] === true), 'No hidden 50-page crawl per query')
  const done = await prisma.monitorJob.findUniqueOrThrow({ where: { id: task.id } })
  assert.equal(done.status, 'COMPLETED')
  assert.equal(done.processed, 1)
  assert.equal(done.errors, 0)
})

test('Bulk 1C matching builds a persistent 05.ru smartphone index before local matching', async () => {
  await prisma.monitorJob.updateMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() } })
  await prisma.competitorCatalogEntry.deleteMany()
  const catId = randomUUID(), base = randomUUID(), size = 125
  const categoryPath = 'BUSINESS 2000 ' + base
  const iphoneName = 'Смартфон Apple iPhone 18 Pro 12 Гб/256 Гб оранжевый (E-Sim)'
  const products = Array.from({ length: size }, (_, i) => ({
    oneCId: base + '-' + i, sku: 'BULK-SKU-' + base + '-' + i,
    slug: 'bulk-' + base + '-' + i,
    name: i === 0 ? iphoneName : 'Тестовая модель Xiaomi ' + i,
    brand: i === 0 ? 'Apple' : 'Xiaomi',
    categoryOneCId: catId, price: 92000, stockQty: 2, costPrice: 75000,
  }))
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: catId, name: categoryPath, slug: 'bulk-' + catId }],
    products,
  })
  const url = 'https://05.ru/cat/396f7486/p/smartfon-apple-iphone-18-pro-12-gb-256-gb-oranzheviy-e-sim-999999/'
  const currentSnapshot = { ...fixture.snapshot,
    h1: fixture.snapshot.h1.replaceAll('iPhone 17 Pro', 'iPhone 18 Pro'),
    scripts: fixture.snapshot.scripts.map(script => script.replaceAll('iPhone 17 Pro', 'iPhone 18 Pro')),
  }
  let searchCalls = 0, parseCalls = 0
  const indexCalls = []
  const parser = {
    indexSmartphoneCatalogPage: async pageNumber => {
      indexCalls.push(pageNumber)
      return pageNumber === 1 ? [{ url, title: currentSnapshot.h1 }] : []
    },
    searchProducts: async () => {
      searchCalls++
      return [{ ...extractFiveRu(currentSnapshot, url), url }]
    },
    parse: async link => {
      parseCalls++
      return { ...extractFiveRu(currentSnapshot, link), url: link }
    },
  }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const enqueued = await monitor.autoFindOneCSection({ categoryPath, maxItems: 2000, indexCatalog: true })
  assert.equal(enqueued.eligible, size)
  assert.equal(enqueued.queued, size)
  const indexJob = await prisma.monitorJob.findFirst({ where: { kind: 'INDEX_05RU_SMARTPHONES', status: 'QUEUED' } })
  assert(indexJob)
  const matchJob = await prisma.monitorJob.findUniqueOrThrow({ where: { id: enqueued.id } })

  // The index was created after MATCH_1C, but the worker must finish it first.
  await monitor.tick()
  assert.deepEqual(indexCalls, [1])
  assert.equal((await prisma.monitorJob.findUniqueOrThrow({ where: { id: matchJob.id } })).processed, 0)
  await monitor.tick() // First empty page is retried, not treated as end-of-catalog.
  await monitor.tick() // The repeated empty page confirms the end of the catalog.
  assert.deepEqual(indexCalls, [1, 2, 2])
  const completedIndex = await prisma.monitorJob.findUniqueOrThrow({ where: { id: indexJob.id } })
  assert.equal(completedIndex.status, 'COMPLETED')
  assert.equal(completedIndex.processed, 1)
  assert.equal(await prisma.competitorCatalogEntry.count(), 1)

  await monitor.tick() // 1C matching now uses the saved local index.
  assert.equal(searchCalls, 0)
  assert.equal(parseCalls, 1)
  const linked = await prisma.competitorProduct.findUniqueOrThrow({ where: { externalUrl: url } })
  const ours = await prisma.product.findUniqueOrThrow({ where: { oneCId: base + '-0' } })
  assert.equal(linked.productId, ours.id)
  assert.equal(linked.matchStatus, 'CONFIRMED')
  assert.equal(ours.price, 92000)
  const savedMatchJob = await prisma.monitorJob.findUniqueOrThrow({ where: { id: matchJob.id } })
  assert.equal(savedMatchJob.processed, 1)
  assert.equal(savedMatchJob.status, 'QUEUED')
  await monitor.cancelJob(matchJob.id)
})

test('Selected price approvals require 1C scope, preserve atomicity and reject stale observations', async () => {
  // Previous test scenarios leave queued jobs; isolate these admin operations.
  await prisma.monitorJob.updateMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() } })
  const catId = randomUUID(), batch = randomUUID()
  const categoryPath = 'МОБИЛЬНАЯ СВЯЗЬ / Смартфоны / Смартфоны Apple ' + batch
  const oneCId = 'BULK-ONEC-' + batch, zeroId = 'EMPTY-ONEC-' + batch, unmatchedId = 'UNMATCHED-ONEC-' + batch
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({
    categories: [{ oneCId: catId, name: categoryPath, slug: 'stock-test-' + batch }],
    products: [
      { oneCId, name: product.name, brand: 'Apple', sku: 'STOCK-' + batch,
        slug: 'stock-' + batch, categoryOneCId: catId, stockQty: 3, price: 91000, costPrice: 70000 },
      { oneCId: zeroId, name: 'Apple iPhone 17 Pro Max 256 Гб синий',
        brand: 'Apple', sku: 'EMPTY-' + batch, slug: 'empty-' + batch,
        categoryOneCId: catId, stockQty: 0, price: 95000, costPrice: 70000 },
      { oneCId: unmatchedId, name: 'Apple iPhone 17 Pro 512 Гб белый',
        brand: 'Apple', sku: 'UNMATCHED-' + batch, slug: 'unmatched-' + batch,
        categoryOneCId: catId, stockQty: 2, price: 96000, costPrice: 70000 },
    ],
  })
  const site = new ProductsService(prisma, { log: async () => {} })
  let storefront = await site.list()
  assert(storefront.some(row => row.oneCId === oneCId))
  assert(!storefront.some(row => row.oneCId === zeroId))
  const before = await prisma.product.findUniqueOrThrow({ where: { oneCId } })
  const link = 'https://05.ru/cat/396f7486/p/smartfon-iphone-17-pro-256-orange-' + batch.replace(/-/g, '') + '/'
  const parser = { parse: async (url) => ({ ...extractFiveRu(fixture.snapshot, fixture.sourceUrl), url }) }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const observation = await monitor.check({ url: link, productId: before.id })
  assert.equal(observation.latestPrice, 96990)
  await monitor.confirm(observation.id, before.id)
  // Allow the selected candidate in the TEST-only 1C scope.
  await prisma.product.update({ where: { id: before.id }, data: { priceSyncEnabled: true } })
  const scope = { categoryPath }
  const preview = await monitor.previewBulkPrices(scope)
  assert.equal(preview.count, 1)
  assert.equal(preview.totalScope, 1)
  assert.equal(preview.skipped, 0)
  assert.equal(preview.items[0].newPrice, 96490)
  assert.equal(preview.items[0].oldPrice, 91000)
  await assert.rejects(
    () => monitor.applyBulkPrices({ ...scope, ids: [observation.id], token: 'incorrect', acceptUnknownCost: false, acceptLargeChange: false }),
    /Обнови предварительный просмотр/
  )
  const applied = await monitor.applyBulkPrices({
    ...scope, ids: [observation.id], token: preview.token, acceptUnknownCost: false, acceptLargeChange: false,
  })
  assert.equal(applied.applied, 1)
  assert.equal(applied.siteOnly, 0)
  assert.equal(applied.oneCQueued, 1)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId } })).price, 91000,
    'the website must not publish a parser proposal before 1C confirms it')
  assert.equal(await prisma.oneCPriceChange.count({ where: { productId: before.id, status: 'PENDING' } }), 1)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: zeroId } })).price, 95000)
  await assert.rejects(() => monitor.applyBulkPrices({
    ...scope, ids: [observation.id], token: preview.token, acceptUnknownCost: false, acceptLargeChange: false,
  }), /Обнови предварительный просмотр/)
  const completedPreview = await monitor.previewBulkPrices(scope)
  assert.equal(completedPreview.count, 0)
  const sync = new OneCPriceSyncService(prisma)
  const queued = await sync.pending()
  assert.equal(queued.items.length, 1)
  const receipt = await sync.receipts({ items: [{ id: queued.items[0].id, appliedPrice: 96490 }] })
  assert.equal(receipt.results[0].status, 'DELIVERED')
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId } })).price, 96490)

  await prisma.product.update({ where: { id: before.id }, data: { price: 91000 } })
  await prisma.competitorProduct.update({ where: { id: observation.id },
    data: { lastSuccessAt: new Date(Date.now() - 48 * 3600_000) } })
  assert.equal((await monitor.previewBulkPrices(scope)).count, 0)
  // 1C stock import updates a product by immutable GUID; stock arriving later
  // activates its existing URL again, without creating duplicates.
  await integration.importCatalog({
    categories: [],
    products: [{ oneCId: zeroId, name: 'Apple iPhone 17 Pro Max 256 Гб синий',
      brand: 'Apple', sku: 'EMPTY-' + batch, slug: 'empty-' + batch,
      categoryOneCId: catId, stockQty: 4, price: 95000, costPrice: 70000 }],
  })
  storefront = await site.list()
  assert(storefront.some(row => row.oneCId === zeroId))
  assert.equal(await prisma.product.count({ where: { oneCId: zeroId } }), 1)
  // Simulate the 1C receipt to leave no PENDING message for subsequent tests.
  await prisma.oneCPriceChange.updateMany({ where: { productId: before.id, status: 'PENDING' },
    data: { status: 'DELIVERED', deliveredAt: new Date() } })
})

test('In-stock smartphone-only auto matching excludes other 1C categories and zero-stock phone SKUs', async () => {
  // Previous test scenarios leave queued jobs; isolate these admin operations.
  await prisma.monitorJob.updateMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() } })
  const base = randomUUID(), catId = randomUUID(), otherId = randomUUID()
  const categoryName = 'МОБИЛЬНАЯ СВЯЗЬ / Смартфоны / iPhone ' + base
  const integration = new IntegrationsService(prisma, {})
  const all = [
    { oneCId: 'ACTIVE-' + base, sku: 'A-' + base, slug: 'a-' + base,
      name: 'iPhone 17 Pro 256 Гб оранжевый', brand: 'Apple', categoryOneCId: catId,
      price: 92000, stockQty: 1 },
    { oneCId: 'ZERO-' + base, sku: 'Z-' + base, slug: 'z-' + base,
      name: 'iPhone 17 Pro 512 Гб синий', brand: 'Apple', categoryOneCId: catId,
      price: 93000, stockQty: 0 },
    { oneCId: 'CASE-' + base, sku: 'C-' + base, slug: 'c-' + base,
      name: 'Чехол iPhone 17 Pro', brand: 'Apple', categoryOneCId: otherId,
      price: 2000, stockQty: 10 },
  ]
  await integration.importCatalog({
    categories: [
      { oneCId: catId, name: categoryName, slug: 'iph-' + base },
      { oneCId: otherId, name: 'Аксессуары ' + base, slug: 'accessories-' + base },
    ], products: all,
  })
  const monitor = new PriceMonitorService(prisma, {
    searchProducts: async () => [], parse: async () => { throw new Error('Not needed') },
  }, new MonitorExchangeService(prisma))
  const job = await monitor.autoFindOneCSection({
    categoryPath: '', maxItems: 5000, onlyInStockSmartphones: true,
  })
  // Older tests may have imported other 1C smartphones. Scope to this one category
  // in a separate invocation after cancelling the all-scope job.
  assert(job.queued >= 1)
  assert(job.visitedUrls.includes('STOCKED_SMARTPHONES'))
  await monitor.cancelJob(job.id)
  const local = await monitor.autoFindOneCSection({
    categoryPath: categoryName, maxItems: 5000, onlyInStockSmartphones: true,
  })
  assert.equal(local.queued, 1)
  const active = await prisma.product.findUniqueOrThrow({ where: { oneCId: 'ACTIVE-' + base } })
  assert.deepEqual(local.pendingUrls, ['product:' + active.id])
  await monitor.cancelJob(local.id)
})


test('1C import skips duplicate iPhone variants with different GUIDs; updates same GUID and keeps real colour/storage/SIM variants', async () => {
  const batch = randomUUID()
  const categoryId = randomUUID()
  const categoryName = 'МОБИЛЬНАЯ СВЯЗЬ / Смартфоны / Смартфоны Apple ' + batch
  const importer = new IntegrationsService(prisma, {})
  const common = { brand: 'Apple', categoryOneCId: categoryId, price: 91900, stockQty: 2 }
  const base = { ...common, name: 'Смартфон Apple iPhone 17 Pro 256 Гб eSIM синий' }
  const rows = [
    { ...base, oneCId: 'ROOT-'+batch, sku:'ROOT-'+batch, slug:'root-'+batch },
    { ...base, oneCId: 'CLONE-'+batch, sku:'CLONE-'+batch, slug:'clone-'+batch },
    { ...base, name:'Смартфон Apple iPhone 17 Pro 512 Гб eSIM синий', oneCId:'MEM-'+batch, sku:'MEM-'+batch, slug:'mem-'+batch },
    { ...base, name:'Смартфон Apple iPhone 17 Pro 256 Гб eSIM белый', oneCId:'WHITE-'+batch, sku:'WHITE-'+batch, slug:'white-'+batch },
    { ...base, name:'Смартфон Apple iPhone 17 Pro 256 Гб nano SIM синий', oneCId:'SIM-'+batch, sku:'SIM-'+batch, slug:'sim-'+batch },
  ]
  const first = await importer.importCatalog({
    categories: [{ oneCId: categoryId, name: categoryName, slug: 'tree-'+batch }],
    products: rows,
  })
  assert.equal(first.products, 4)
  assert.equal(first.skippedDuplicates, 1)
  assert(first.duplicateExamples.includes(base.name))
  assert.equal(await prisma.product.count({ where: { oneCId: 'CLONE-'+batch } }), 0)
  assert.equal(await prisma.product.count({ where: { oneCId: { in: rows.map(p => p.oneCId) } } }), 4)

  // The 1C client may lose the HTTP response after the server commits a batch.
  // Replaying the exact same packet must update the same GUIDs, not duplicate rows.
  const replay = await importer.importCatalog({
    categories: [{ oneCId: categoryId, name: categoryName, slug: 'tree-'+batch }],
    products: rows,
  })
  assert.equal(replay.products, 4)
  assert.equal(replay.skippedDuplicates, 1)
  assert.equal(await prisma.product.count({ where: { oneCId: { in: rows.map(p => p.oneCId) } } }), 4)

  const primary = await prisma.product.findUniqueOrThrow({ where: { oneCId: 'ROOT-'+batch } })
  const next = await importer.importCatalog({
    categories: [],
    products: [{ ...rows[0], price: 88900, stockQty: 5 }],
  })
  assert.equal(next.skippedDuplicates, 0)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: 'ROOT-'+batch } })).id, primary.id)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { oneCId: 'ROOT-'+batch } })).stockQty, 5)

  // A changed SKU may belong to another physical variant: it must NEVER
  // silently take ownership of an existing 1C GUID.
  await assert.rejects(
    () => importer.importCatalog({
      categories: [],
      products: [{ ...rows[0], name: 'Смартфон Apple iPhone 17 Pro 1 Тб eSIM оранжевый',
        oneCId: 'CONFLICT-'+batch, price: 100000 }],
    }), /Конфликт идентификаторов 1С/
  )
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: primary.id } })).oneCId, 'ROOT-'+batch)
})

test('Legacy duplicate 1C records show as one public phone, remain accessible to admin and are never deleted', async () => {
  const batch = randomUUID()
  const categoryId = randomUUID()
  const importer = new IntegrationsService(prisma, {})
  const name = 'Смартфон Apple iPhone 17 Pro Max 512 Гб eSIM белый'
  const path = 'МОБИЛЬНАЯ СВЯЗЬ / Смартфоны / Смартфоны Apple ' + batch
  await importer.importCatalog({
    categories: [{ oneCId: categoryId, name: path, slug:'old-dupes-'+batch }],
    products: [{ oneCId:'KEEP-'+batch, sku:'KEEP-'+batch, slug:'keep-'+batch,
      name, brand:'Apple', categoryOneCId:categoryId, price: 120000, stockQty: 3 }],
  })
  const c = await prisma.category.findFirstOrThrow({ where: { oneCId: categoryId } })
  const legacy = await prisma.product.create({ data: {
    oneCId:'LEGACY-'+batch, sku:'LEGACY-'+batch, slug:'legacy-'+batch,
    name, brand:'Apple', categoryId:c.id, price: 121000, stockQty: 2, status:'ACTIVE',
  } })
  const service = new ProductsService(prisma, { log: async () => {} })
  const site = await service.list()
  assert.equal(site.filter(p => p.category.id === c.id).length, 1)
  const admin = await service.adminList()
  const oldRows = admin.filter(p => p.category.id === c.id)
  assert.equal(oldRows.length, 2)
  assert.equal(oldRows.filter(p => p.duplicateOf !== null).length, 1)
  assert.equal(await prisma.product.count({ where: { id: legacy.id } }), 1)
  const reimport = await importer.importCatalog({ categories: [], products: [{
    oneCId:'LEGACY-'+batch, sku:'LEGACY-'+batch, slug:'legacy-'+batch,
    name, brand:'Apple', categoryOneCId:categoryId, price: 121000, stockQty: 2,
  }] })
  assert.equal(reimport.skippedDuplicates, 1)
  assert.equal(await prisma.product.count({ where: { categoryId: c.id } }), 2)
})


test('Compact iPhone accessory names keep compatibility separate from manufacturer and colour', () => {
  const names = [
    ['Накладка Green Lion Leather Case for iPhone 15Pro Max - Blue', 'iphone 15 pro max', 'blue'],
    ['Накладка Green Lion Leather Case for iPhone 15Pro - Black', 'iphone 15 pro', 'black'],
    ['Накладка Green Lion Case for iP15 ProGray/Blue', 'iphone 15 pro', 'blue'],
  ]
  for (const [name, model, color] of names) {
    const parsed = identity({ name, brand: 'Другие' })
    assert.equal(parsed.model, model)
    assert.equal(parsed.brand, 'green lion')
    assert.equal(parsed.color, color)
    assert(oneCSearchQueries({ name })[0].startsWith('green lion чехол iphone'))
  }
  const glass = identity({ name: 'Защитное стекло Green Lion Screen Protector for iPhone 15Pro - Clear' })
  assert.equal(glass.color, undefined) // Green is part of the manufacturer, not the finish.
  assert.equal(glass.brand, 'green lion')
  const links = rankSearchLinks([{url:'https://05.ru/cat/cases/p/iphone-15-pro-max-123/', title:'Чехол Green Lion для iPhone 15 Pro Max'}], 'green lion чехол iphone 15Pro Max')
  assert.equal(links.length, 1)
  const matching = new MatchingEngine()
  const check = compareItems({name:names[0][0]}, {name:'Чехол Green Lion Other Series iPhone 15 Pro Max Blue'})
  assert.equal(matching.strongVariant(check), true)
  assert.equal(check.canAutoConfirm, false) // Suggestion only; no GTIN/MPN proof.
  const wrongMaker = compareItems({name:names[0][0]}, {name:'Чехол G-Case iPhone 15 Pro Max Blue', brand:'G-Case'})
  assert.equal(matching.strongVariant(wrongMaker), false)
  assert(wrongMaker.conflicts.includes('бренд'))

  const exactGtin = validGtin('4006381333931')
  assert.ok(exactGtin)
  const exactAccessory = compareItems(
    { name: 'Зарядное устройство Green Lion 20W', brand: 'Green Lion', gtin: exactGtin },
    { name: 'Зарядное устройство Green Lion 20W', brand: 'Green Lion', gtin: exactGtin },
  )
  assert.equal(exactAccessory.exactId, true)
  assert.equal(matching.strongVariant(exactAccessory), true)
  assert.equal(exactAccessory.canAutoConfirm, true)
})


test('Complete smartphone variants auto-confirm only with compatible explicit SIM details', () => {
  const complete = { name: 'Apple iPhone 17 Pro 12GB/256GB Cosmic Orange eSIM', brand: 'Apple' }
  assert.equal(compareItems(complete, complete).canAutoConfirm, true)
  assert.equal(compareItems(complete, {
    name: 'Apple iPhone 17 Pro 12GB/256GB Cosmic Orange', brand: 'Apple',
  }).canAutoConfirm, false) // 1C explicitly requires eSIM; source did not prove it.
  for (const name of [
    'Apple iPhone 17 Pro 12GB/512GB Cosmic Orange eSIM',
    'Apple iPhone 17 Pro 12GB/256GB Blue eSIM',
  ]) {
    assert.equal(compareItems(complete, {name, brand:'Apple'}).canAutoConfirm, false)
  }

  // SIM is not a blocker when neither source records it; the actual phone
  // variant is still uniquely identified by brand, model, storage and colour.
  const noSim = { name: 'Смартфон Apple iPhone 13 128 Гб черный', brand: 'Apple' }
  const exactNoSim = { name: 'Смартфон Apple iPhone 13 4 Гб/128 Гб черный (без RuStore)', brand: 'Apple' }
  assert.equal(compareItems(noSim, exactNoSim).canAutoConfirm, true)
  assert.equal(compareItems(noSim, {name:'Смартфон Apple iPhone 13 128 Гб белый',brand:'Apple'}).canAutoConfirm, false)
  assert.equal(compareItems(noSim, {name:'Смартфон Apple iPhone 13 128 Гб черный eSIM',brand:'Apple'}).canAutoConfirm, true)
  assert.equal(compareItems(noSim, {name:'Смартфон Apple iPhone 13 128 Гб черный (замена платы)',brand:'Apple'}).canAutoConfirm, false)
  assert.equal(identity({name:'Смартфон Apple iPhone 13 128 Гб черный (замена платы)'}).condition, 'defective')
})

test('Competitor catalog import never creates draft store inventory', async () => {
  const url = fixture.sourceUrl.replace('24007/', randomUUID() + '/')
  const before = await prisma.product.count()
  const parser = { discover:async () => ({urls:[url], title:'Аксессуары', discovered:1}),
    parse:async () => ({...extractFiveRu(fixture.snapshot, fixture.sourceUrl), url}) }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const result = await monitor.importFiveRuCatalog({url:'https://05.ru/cat/test/',limit:1})
  assert.equal(result.imported,1)
  assert.equal(await prisma.product.count(), before)
  assert(await prisma.competitorProduct.findUnique({where:{externalUrl:url}}))
})

test('No-match classification requires completed, error-free discovery', () => {
  const complete = { linksFound: 30, searchPages: 1, rankedLinks: 0, cardsParsed: 0, rejectedCards: [] }
  assert.equal(canDeclareNoMatch([complete]), true)
  assert.equal(canDeclareNoMatch([{ ...complete, searchPages: 0 }]), false)
  assert.equal(canDeclareNoMatch([{ ...complete, rankedLinks: 2, cardsParsed: 1 }]), false)
  assert.equal(canDeclareNoMatch([{ ...complete, rejectedCards: ['HTTP 429'] }]), false)
})

test('Negative matches are excluded from bulk and can be manually searched again', async () => {
  const id = randomUUID()
  const categoryPath = 'NO MATCH ' + id
  await new IntegrationsService(prisma, {}, {}).importCatalog({
    categories: [{ oneCId: 'nocat-' + id, name: categoryPath, slug: 'nocat-' + id }],
    products: [{ oneCId: 'noitem-' + id, sku: 'NO-' + id, slug: 'no-' + id,
      name: 'Смартфон Motorola Edge 90 128 ГБ синий', brand: 'Motorola',
      categoryOneCId: 'nocat-' + id, price: 55000, stockQty: 1 }],
  })
  const product = await prisma.product.findUniqueOrThrow({ where: { oneCId: 'noitem-' + id } })
  const parser = { searchProducts: async (_query, _limit, trace) => {
    Object.assign(trace, { linksFound: 8, searchPages: 1, rankedLinks: 0, cardsParsed: 0, rejectedCards: [] })
    return []
  } }
  const monitor = new PriceMonitorService(prisma, parser, new MonitorExchangeService(prisma))
  const first = await monitor.autoFindOneCSection({ categoryPath, maxItems: 10, onlyUnlinked: true })
  await monitor.tick()
  assert.equal((await prisma.monitorJob.findUniqueOrThrow({ where: { id: first.id } })).status, 'COMPLETED')
  const key = { productId_sourceKey: { productId: product.id, sourceKey: '05ru' } }
  assert.equal((await prisma.productMatchOutcome.findUniqueOrThrow({ where: key })).status, 'NO_MATCH')
  await assert.rejects(() => monitor.autoFindOneCSection({
    categoryPath, maxItems: 10, onlyUnlinked: true,
  }), /Нет непривязанных товаров/)
  const retried = await monitor.retryMatch(product.id)
  assert.deepEqual(retried.pendingUrls, ['product:' + product.id])
  assert.equal((await prisma.productMatchOutcome.findUniqueOrThrow({ where: key })).status, 'PENDING')
  await monitor.cancelJob(retried.id)
})

test('Site admin edits queue an exact 1C retail price change and protect against stale 1C catalog', async () => {
  const seed = randomUUID()
  const cat = { oneCId: 'price-admin-cat-' + seed, name: 'Ручные цены 1С ' + seed, slug: 'price-admin-cat-' + seed }
  const name = 'Ноутбук Huawei MateBook D14 512GB'
  const product = { oneCId: 'price-admin-' + seed, sku: 'PRICE-ADMIN-' + seed,
    slug: 'price-admin-' + seed, name, brand: 'Huawei', categoryOneCId: cat.oneCId,
    price: 53500, stockQty: 2, costPrice: 41000 }
  const integration = new IntegrationsService(prisma, {})
  await integration.importCatalog({ categories: [cat], products: [product] })
  let row = await prisma.product.findUniqueOrThrow({ where: { oneCId: product.oneCId } })
  const site = new ProductsService(prisma, { log: async () => {} })
  const sync = new OneCPriceSyncService(prisma)
  // Unapproved 1C items must not diverge silently when the editor is used.
  await assert.rejects(() => site.update(row.id, { price: 54000 }), /Сначала включи товар/)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: row.id } })).price, 53500)
  await sync.configureScope({ oneCIds: [product.oneCId] })

  // Saving the same price or unrelated product metadata creates no 1C task.
  await site.update(row.id, { price: 53500, shortSpec: 'Демо' })
  assert.equal((await sync.pending()).items.length, 0)

  const updated = await site.update(row.id, { price: 54000 })
  assert.equal(updated.price, 54000)
  const pending = await sync.pending()
  assert.equal(pending.items.length, 1)
  assert.equal(pending.items[0].oneCId, product.oneCId)
  assert.equal(pending.items[0].expectedPrice, 53500)
  assert.equal(pending.items[0].targetPrice, 54000)
  assert.equal((await prisma.oneCPriceChange.findUniqueOrThrow({
    where: { id: pending.items[0].id },
  })).sourceLinkId, null, 'a manual price change requires no 05.ru link')

  // No second update while 1C has not acknowledged the first.
  await assert.rejects(() => site.update(row.id, { price: 56000 }), /Предыдущая цена ещё не передана/)
  await integration.importCatalog({ categories: [cat], products: [product] })
  row = await prisma.product.findUniqueOrThrow({ where: { id: row.id } })
  assert.equal(row.price, 54000, 'old 1C catalog must not overwrite site edits in transit')

  await sync.receipts({ items: [{ id: pending.items[0].id, error: 'Временно нет доступа к 1С' }] })
  assert.equal((await sync.pending()).items.length, 1)
  await sync.receipts({ items: [{ id: pending.items[0].id, appliedPrice: 54000 }] })
  assert.equal((await sync.pending()).items.length, 0)
  assert.equal((await prisma.oneCPriceChange.findUniqueOrThrow({
    where: { id: pending.items[0].id },
  })).status, 'DELIVERED')
  await integration.importCatalog({ categories: [cat], products: [{ ...product, price: 54000 }] })
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: row.id } })).price, 54000)
})

test('A site-created product still accepts a direct price edit without creating an 1C task', async () => {
  const seed = randomUUID()
  const category = await prisma.category.create({ data: { name: 'Site only ' + seed, slug: 'site-only-' + seed } })
  const site = new ProductsService(prisma, { log: async () => {} })
  const product = await site.create({ sku: 'SITE-' + seed, slug: 'site-' + seed,
    name: 'Зарядное устройство тест', brand: 'Test', categoryId: category.id,
    price: 1000 })
  const result = await site.update(product.id, { price: 1200 })
  assert.equal(result.price, 1200)
  assert.equal(await prisma.oneCPriceChange.count({ where: { productId: product.id } }), 0)
})

test('Bulk price preview lists every changed 05.ru price, explains blocked rows, and queues only selected eligible rows', async () => {
  const integration = new IntegrationsService(prisma, {})
  const exchange = new MonitorExchangeService(prisma)
  const monitor = new PriceMonitorService(prisma, {}, exchange)
  const categoryId = randomUUID()
  const enabledId = randomUUID()
  const disabledId = randomUUID()
  const unconfirmedId = randomUUID()
  const category = { oneCId: categoryId, name: 'Тестовые товары цен', slug: 'bulk-price-test-' + categoryId }
  await integration.importCatalog({ categories: [category], products: [
    { oneCId: enabledId, sku: 'BULK-ENABLED-' + enabledId, slug: 'bulk-enabled-' + enabledId,
      name: 'Тестовый товар доступный', brand: 'Test', categoryOneCId: categoryId,
      price: 70000, stockQty: 5, costPrice: 60000 },
    { oneCId: disabledId, sku: 'BULK-DISABLED-' + disabledId, slug: 'bulk-disabled-' + disabledId,
      name: 'Тестовый товар без области 1С', brand: 'Test', categoryOneCId: categoryId,
      price: 70000, stockQty: 5, costPrice: 60000 },
    { oneCId: unconfirmedId, sku: 'BULK-UNCONFIRMED-' + unconfirmedId, slug: 'bulk-unconfirmed-' + unconfirmedId,
      name: 'Тестовый товар без подтверждения', brand: 'Test', categoryOneCId: categoryId,
      price: 70000, stockQty: 5, costPrice: 60000 },
  ] })
  const enabled = await prisma.product.findUniqueOrThrow({ where: { oneCId: enabledId } })
  const disabled = await prisma.product.findUniqueOrThrow({ where: { oneCId: disabledId } })
  const unconfirmed = await prisma.product.findUniqueOrThrow({ where: { oneCId: unconfirmedId } })
  await prisma.product.update({ where: { id: enabled.id }, data: { priceSyncEnabled: true } })
  await prisma.product.update({ where: { id: unconfirmed.id }, data: { priceSyncEnabled: true } })
  const enabledProduct = await prisma.product.findUniqueOrThrow({ where: { id: enabled.id } })
  const disabledProduct = await prisma.product.findUniqueOrThrow({ where: { id: disabled.id } })
  const unconfirmedProduct = await prisma.product.findUniqueOrThrow({ where: { id: unconfirmed.id } })
  const source = await prisma.competitorSource.upsert({
    where: { key: '05ru' }, update: {}, create: { key: '05ru', name: '05.ru', baseUrl: 'https://05.ru' },
  })
  const now = new Date()
  async function addChangedLink({ product, externalName, matchStatus = 'CONFIRMED' }) {
    const attributes = {}
    return prisma.competitorProduct.create({ data: {
      sourceId: source.id, productId: product?.id ?? null,
      externalUrl: 'https://05.ru/cat/test/p/' + randomUUID() + '/',
      externalName, attributes, seller: '05.ru', priceSource: 'JSON-LD Offer',
      matchStatus,
      confirmedFingerprint: product && matchStatus === 'CONFIRMED' ? fingerprint({ name: externalName, attributes }) : null,
      confirmedProductFingerprint: product && matchStatus === 'CONFIRMED' ? fingerprint(product) : null,
      lastSuccessAt: now, lastCheckedAt: now, latestPrice: 71000, inStock: true,
      history: { create: { price: 71000, oldPrice: 72000, inStock: true, checkedAt: now } },
    } })
  }
  const eligibleLink = await addChangedLink({ product: enabledProduct, externalName: enabledProduct.name })
  const disabledLink = await addChangedLink({ product: disabledProduct, externalName: disabledProduct.name })
  const unconfirmedLink = await addChangedLink({
    product: unconfirmedProduct, externalName: unconfirmedProduct.name, matchStatus: 'SUGGESTED',
  })
  const testProductIds = [enabled.id, disabled.id, unconfirmed.id]

  // Merely collecting and previewing a price change must not create a retail-price task.
  assert.equal(await prisma.oneCPriceChange.count({ where: { productId: { in: testProductIds } } }), 0)
  const preview = await monitor.previewBulkPrices({})
  const testRows = preview.items.filter(item => [eligibleLink.id, disabledLink.id, unconfirmedLink.id].includes(item.id))
  assert.equal(testRows.length, 3)
  const eligibleRow = testRows.find(item => item.id === eligibleLink.id)
  const disabledRow = testRows.find(item => item.id === disabledLink.id)
  const unconfirmedRow = testRows.find(item => item.id === unconfirmedLink.id)
  assert.equal(eligibleRow.canSend, true)
  assert.equal(eligibleRow.previousCompetitorPrice, 72000)
  assert.equal(eligibleRow.competitorPrice, 71000)
  assert.equal(eligibleRow.newPrice, 70500) // 05.ru minus 500 ₽
  assert.equal(testRows.filter(item => item.canSend).length, 1)
  assert.equal(disabledRow.canSend, false)
  assert(disabledRow.blockedReasons.some(reason => reason.includes('не включён')))
  assert.equal(unconfirmedRow.canSend, false)
  assert(unconfirmedRow.blockedReasons.some(reason => reason.includes('не подтверждено')))
  assert.equal(await prisma.oneCPriceChange.count({ where: { productId: { in: testProductIds } } }), 0)

  // A blocked row cannot be smuggled into the queue through the API.
  await prisma.monitorJob.updateMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', leaseUntil: null, finishedAt: new Date() },
  })
  await assert.rejects(() => monitor.applyBulkPrices({
    categoryPath: '', token: preview.token, ids: [disabledLink.id],
    acceptUnknownCost: false, acceptLargeChange: false,
  }), /заблокированные или устаревшие/)

  const result = await monitor.applyBulkPrices({
    categoryPath: '', token: preview.token, ids: [eligibleLink.id],
    acceptUnknownCost: false, acceptLargeChange: false,
  })
  assert.equal(result.oneCQueued, 1)
  const queued = await prisma.oneCPriceChange.findMany({
    where: { productId: enabled.id, status: 'PENDING' },
  })
  assert.equal(queued.length, 1)
  assert.equal(queued[0].newPrice, 70500)
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: enabled.id } })).price, 70000,
    'TEXHORU keeps the old price until 1C confirms the posted document')
})
