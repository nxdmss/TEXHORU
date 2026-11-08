import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { Prisma, ProductStatus, StockState } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { ApplyRecommendedPriceDto, BulkApplyPricesDto, BulkPriceScopeDto, AutoFindOneCSectionDto, CheckCompetitorPriceDto, ImportFiveRuCatalogDto, ImportManualCompetitorPricesDto, MonitorSettingsDto, ScanFiveRuDto, CheckAllDto, PriceUpdateDto } from './price-monitor.dto'
import { FiveRuParser, fiveRuUrl, type FiveRuResult, type FiveRuSearchTrace } from './five-ru.parser'
import { DnsParser, MvideoParser, STORE_DEFINITIONS, storeKeyFromUrl, type StoreKey, type StorefrontAdapter, type StoreProductResult } from './storefront-adapter'
import { canonicalModel, compareItems, fingerprint, identity, manualConfirmationBlockers, recommendation, reviewCandidate } from './product-matching'
import { canDeclareNoMatch, type SearchEvidence } from './match-outcome'
import { jsonValue, MonitorExchangeService } from './monitor-exchange.service'
import { MatchingEngine } from './matching-engine'
import { OneCPriceSyncService } from '../integrations/price-sync.service'
import { PriceUpdateWorkflow } from './price-update.workflow'

// Small 1C batches should not read 50 catalog pages before matching.
const FAST_MATCH_MAX_ITEMS = 40

// Temporary demo policy: TEST prices can change by any percentage.
function allowLargeTestPriceChange() {
  return process.env.ONE_C_BASE_KIND === 'TEST' && process.env.ONE_C_TEST_PRICE_SYNC_ENABLED === 'true'
}

// Temporary 05.ru-only testing. Retain historical DNS and M.Video data.
const ENABLED_STORE_KEYS: StoreKey[] = ['05ru']
function requireEnabledStore(key: StoreKey) {
  if (!ENABLED_STORE_KEYS.includes(key)) throw new BadRequestException('На время тестирования доступен только 05.ru')
}

// Storefront search often fails on 1C-only labels such as "(EAC)" and the
// 1C memory format "12/512". Start with model + capacity, then the model alone.
// Strict variant comparison controls automatic selection; uncertain variants are kept for manual review.
export function oneCSearchQueries(product: { name: string; brand?: string | null; category?: string | { name?: string } | null }) {
  const parsed = identity(product)
  // Remove internal 1C annotations, but preserve the product family.
  const cleanName = product.name.replace(/\s*\(EAC\)/gi, '').replace(/\s+/g, ' ').trim()
  const accessoryType: Record<string, string> = {
    case: 'чехол', 'screen-protector': 'защитное стекло', 'watch-strap': 'ремешок',
    charger: 'зарядное устройство', cable: 'кабель',
  }
  if (parsed.kind && accessoryType[parsed.kind]) {
    const searchBrand = parsed.brand || parsed.compatibleBrand
    const focused = [searchBrand, accessoryType[parsed.kind], parsed.model].filter(Boolean).join(' ')
    const typeModel = [accessoryType[parsed.kind], parsed.model].filter(Boolean).join(' ')
    return [...new Set([focused, typeModel, cleanName].filter(Boolean))]
  }
  if (parsed.kind === 'laptop') {
    // Laptop retail names are noisy, but manufacturer part numbers are often
    // stable. Search that identifier first, then hardware configuration, then
    // the untouched 1C title as a recall fallback.
    const code = parsed.productCode || parsed.mpn || parsed.model
    const byCode = [parsed.brand, code].filter(Boolean).join(' ')
    const hardwareQuery = (capacity?: string) => [
      parsed.brand, parsed.cpu,
      parsed.ram ? parsed.ram + 'gb' : undefined, capacity,
      parsed.screenSize ? parsed.screenSize + '"' : undefined,
    ].filter(Boolean).join(' ')
    const byHardware = hardwareQuery(parsed.storage ? parsed.storage + 'gb' : undefined)
    const tbSizes: Record<string, string> = {
      '1024': '1tb', '2048': '2tb', '4096': '4tb', '8192': '8tb',
    }
    const decimalSizes: Record<string, string> = {
      '1024': '1000gb', '2048': '2000gb', '4096': '4000gb', '8192': '8000gb',
    }
    // Discover 1TB notebooks also listed as 1000 GB or 1024GB, but verify
    // canonical SSD capacity on the actual card before any confirmation.
    const byTerabytes = parsed.storage && tbSizes[parsed.storage]
      ? hardwareQuery(tbSizes[parsed.storage]) : ''
    const byDecimal = parsed.storage && decimalSizes[parsed.storage]
      ? hardwareQuery(decimalSizes[parsed.storage]) : ''
    return [...new Set([byCode, byHardware, byTerabytes, byDecimal, cleanName].filter(Boolean))].slice(0, 5)
  }
  if (parsed.kind === 'smartwatch') {
    const focused = [parsed.brand, parsed.model].filter(Boolean).join(' ')
    return [...new Set([focused, cleanName].filter(Boolean))]
  }
  if (!parsed.model && parsed.mpn) {
    return [...new Set([[parsed.brand, parsed.mpn].filter(Boolean).join(' '), parsed.mpn, cleanName].filter(Boolean))]
  }
  if (!parsed.model) return [cleanName]
  if (parsed.kind !== 'smartphone') {
    const focused = [parsed.brand, parsed.model, parsed.storage].filter(Boolean).join(' ')
    return [...new Set([focused, cleanName].filter(Boolean))]
  }
  const originalModel = parsed.brand === 'samsung' && !parsed.model.startsWith('samsung ')
    ? 'samsung ' + parsed.model : parsed.model
  // Search under Apple's actual retail name before trying the incorrect 1C
  // generation label. This avoids hundreds of unrelated iPhone 17 results.
  const model = canonicalModel(originalModel) === 'iphone air' ? 'iphone air' : originalModel
  const modelWithoutBrand = parsed.brand && model.startsWith(parsed.brand + ' ')
    ? model.slice(parsed.brand.length + 1) : model
  const searchColor: Record<string, string> = {
    black: 'черный', white: 'белый', blue: 'синий', gray: 'серый',
    silver: 'серебристый', gold: 'золотой', green: 'зеленый',
    pink: 'розовый', purple: 'фиолетовый', lavender: 'розовый', orange: 'оранжевый',
  }
  const byColor = parsed.color
    ? [parsed.brand, modelWithoutBrand, parsed.storage, searchColor[parsed.color]].filter(Boolean).join(' ')
    : undefined
  // The first query should reflect 1C's explicit SIM requirement instead of
  // repeatedly requesting only a broad model+capacity search.
  const bySim = parsed.sim === 'esim' || parsed.sim === 'physical+esim'
    ? [parsed.brand, modelWithoutBrand, parsed.storage, parsed.color ? searchColor[parsed.color] : undefined, 'e sim'].filter(Boolean).join(' ')
    : undefined
  const alternateLavender = model === 'iphone 17' && parsed.color === 'lavender'
    ? [parsed.brand, modelWithoutBrand, parsed.storage, 'фиолетовый'].filter(Boolean).join(' ')
    : undefined
  // 05.ru writes "iPhone 16e" as one token, while 1C often normalizes
  // it to "iPhone 16 e". Search both spellings; otherwise the live search
  // can return hundreds of unrelated results and miss the exact 16e card.
  const compactModel = model.replace(/\b(iphone\s+\d{1,2})\s+e\b/, '$1e')
  const compactModelWithoutBrand = parsed.brand && compactModel.startsWith(parsed.brand + ' ')
    ? compactModel.slice(parsed.brand.length + 1) : compactModel
  const compactByColor = parsed.color
    ? [parsed.brand, compactModelWithoutBrand, parsed.storage, searchColor[parsed.color]].filter(Boolean).join(' ')
    : undefined
  return [...new Set([
    bySim, byColor, compactByColor, alternateLavender,
    model + (parsed.storage ? ' ' + parsed.storage : ''),
    compactModel + (parsed.storage ? ' ' + parsed.storage : ''),
    model, compactModel,
    ...(model === 'iphone air'
      ? [originalModel + (parsed.storage ? ' ' + parsed.storage : '')]
      : []),
  ].filter((query): query is string => Boolean(query)))]
}

export function isExpectedReviewOutcome(message: string) {
  const text = message.toLowerCase()
  return text.includes('нет подтверждённого совпадения')
    || text.includes('найдены варианты для ручной проверки')
    || text.includes('несколько близких совпадений')
    || text.includes('карточка 05.ru уже связана')
    || text.includes('не найдено точное соответствие')
    || text.includes('найдено несколько сохранённых карточек')
    || text.includes('товар исключён из выбранного раздела')
}

type RankedMatch = { check: ReturnType<typeof compareItems> }

// An explicitly identified SIM variant is stronger evidence than an otherwise
// matching 05.ru card that omits SIM information entirely.
function rankVerifiedMatches<T extends RankedMatch>(matches: T[]): T[] {
  const explicitSim = (row: T) => row.check.ours.sim
    && row.check.theirs.sim === row.check.ours.sim ? 1 : 0
  return [...matches].sort((a, b) => explicitSim(b) - explicitSim(a)
    || b.check.score - a.check.score)
}

// Consistent decision rule for BOTH the saved 05.ru category index and live
// search. A full-variant match must already be verified before calling this.
function hasDecisiveWinner<T extends RankedMatch>(ranked: T[]): boolean {
  if (ranked.length < 2) return ranked.length === 1
  const ours = ranked[0].check.ours
  const simProfiles = new Set(ranked.map(row => row.check.theirs.sim || 'unspecified'))
  // If 1C does not identify the SIM variant and 05.ru offers physical, eSIM
  // and/or combined variants, even a higher title score does NOT justify
  // picking a commercial variant on the user's behalf.
  if (ours.kind === 'smartphone' && !ours.sim && simProfiles.size > 1) return false
  // A single unambiguous source card specifying the same SIM variant as 1C
  // beats otherwise comparable cards that omitted the specification.
  if (ours.kind === 'smartphone' && ours.sim) {
    const explicit = ranked.filter(row => row.check.theirs.sim === ours.sim)
    if (explicit.length === 1
      && ranked[0].check.theirs.sim === ours.sim
      && ranked.every(row => !row.check.theirs.sim || row.check.theirs.sim === ours.sim)
      && ranked.every(row => row.check.canAutoConfirm && !row.check.conflicts.length)) return true
  }
  return ranked[0].check.score - ranked[1].check.score >= 10
}

/** Next 06:00 Moscow time (UTC+3 year round). Schedules reading only. */
function nextDailyPriceCheck(after: Date): Date {
  const next = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), 3))
  if (next <= after) next.setUTCDate(next.getUTCDate() + 1)
  return next
}

@Injectable()
export class PriceMonitorService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout
  private followUpTimer?: NodeJS.Timeout
  private stopped = false
  private indexedCatalogStatus?: { expires: number; ready: boolean }
  private working = false
  private parsing = false
  private readonly matching = new MatchingEngine()
  private readonly priceUpdate: PriceUpdateWorkflow
  constructor(
    private readonly prisma: PrismaService,
    private readonly fiveRu: FiveRuParser,
    private readonly exchange: MonitorExchangeService,
    private readonly mvideo: MvideoParser,
    private readonly dns: DnsParser,
  ) {
    this.priceUpdate = new PriceUpdateWorkflow(prisma, db => this.bulkPriceSnapshot(db))
  }

  startPriceUpdate(dto: PriceUpdateDto) { return this.priceUpdate.start(dto.productIds) }
  currentPriceUpdate() { return this.priceUpdate.current() }
  cancelPriceUpdate(id: string) { return this.priceUpdate.cancel(id) }

  onModuleInit() {
    this.stopped = false
    void this.sources().catch(error => console.error('Источники мониторинга:', error instanceof Error ? error.message : 'Ошибка'))
    // Pause old queued tasks; do not delete competitor links or price history.
    void this.prisma.monitorJob.updateMany({
      where: { sourceKey: { in: ['dns', 'mvideo'] }, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELLED', leaseUntil: null, finishedAt: new Date() },
    }).catch(error => console.error('Отключение DNS/М.Видео:', error instanceof Error ? error.message : 'Ошибка'))
    if (process.env.MONITOR_WORKER_DISABLED === 'true') return
    this.timer = setInterval(() => { void this.tick().catch(error => console.error('Мониторинг:', error instanceof Error ? error.message : 'Ошибка')) }, 1000)
    this.timer.unref()
  }
  onModuleDestroy() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.followUpTimer) clearTimeout(this.followUpTimer)
  }
  private source(key: StoreKey = '05ru') {
    requireEnabledStore(key)
    const definition = STORE_DEFINITIONS.find(item => item.key === key)!
    return this.prisma.competitorSource.upsert({
      where: { key },
      update: { name: definition.name, baseUrl: definition.baseUrl },
      create: { key, name: definition.name, baseUrl: definition.baseUrl },
    })
  }
  private nameForSource(key: StoreKey) {
    return STORE_DEFINITIONS.find(item => item.key === key)?.name || key
  }
  private parserFor(key: StoreKey): StorefrontAdapter {
    requireEnabledStore(key)
    if (key === '05ru') return this.fiveRu
    if (key === 'mvideo') return this.mvideo
    return this.dns
  }
  async sources() {
    return Promise.all(STORE_DEFINITIONS.filter(definition => ENABLED_STORE_KEYS.includes(definition.key)).map(async definition => {
      const source = await this.source(definition.key)
      const settings = await this.settings(definition.key)
      const [confirmed, review, total] = await Promise.all([
        this.prisma.competitorProduct.count({ where: { sourceId: source.id, matchStatus: 'CONFIRMED' } }),
        this.prisma.competitorProduct.count({ where: { sourceId: source.id, matchStatus: { in: ['SUGGESTED', 'REVIEW_REQUIRED'] } } }),
        this.prisma.competitorProduct.count({ where: { sourceId: source.id } }),
      ])
      return { ...source, settings, counts: { confirmed, review, total } }
    }))
  }
  private decorated<T extends { latestPrice?: number | null; inStock?: boolean | null; lastError?: string | null; lastSuccessAt?: Date | null; product?: { name: string; price: number; costPrice?: number | null } | null; matchStatus: string; confirmedFingerprint?: string | null; confirmedProductFingerprint?: string | null; externalName?: string | null; attributes: unknown }>(row: T) {
    const valid = row.matchStatus === 'CONFIRMED' && row.product && fingerprint(row.product) === row.confirmedProductFingerprint && fingerprint({ name: row.externalName || '', attributes: row.attributes }) === row.confirmedFingerprint
    return { ...row, matchStatus: row.matchStatus === 'CONFIRMED' && !valid ? 'REVIEW_REQUIRED' : row.matchStatus, ...recommendation(row, valid ? row.product : null, { allowLargeChange: allowLargeTestPriceChange() }) }
  }
  async matchOutcomes(sourceKey: StoreKey = '05ru') {
    requireEnabledStore(sourceKey)
    return this.prisma.productMatchOutcome.findMany({
      where: { sourceKey },
      select: { productId: true, sourceKey: true, status: true, reason: true, checkedAt: true },
    })
  }

  private async recordMatchOutcome(productId: number, sourceKey: StoreKey,
    status: 'CONFIRMED' | 'REVIEW' | 'NO_MATCH' | 'RETRYABLE', reason: string | null = null) {
    const checkedAt = new Date()
    return this.prisma.productMatchOutcome.upsert({
      where: { productId_sourceKey: { productId, sourceKey } },
      create: { productId, sourceKey, status, reason: reason?.slice(0, 900) || null, checkedAt },
      update: { status, reason: reason?.slice(0, 900) || null, checkedAt },
    })
  }

  // A deliberate manual retry clears the persistent NO_MATCH exclusion.
  async retryMatch(productId: number) {
    if (await this.prisma.monitorJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } })) {
      throw new ConflictException('Сначала заверши текущую проверку')
    }
    const product = await this.prisma.product.findUnique({ where: { id: productId } })
    if (!product || !product.oneCId || product.status !== ProductStatus.ACTIVE
      || product.price <= 0 || product.stockQty <= product.reservedQty) {
      throw new BadRequestException('Нужен активный товар 1С с положительной ценой и остатком')
    }
    const linked = await this.prisma.competitorProduct.findFirst({
      where: { productId, source: { key: '05ru' }, matchStatus: 'CONFIRMED' },
      select: { id: true },
    })
    if (linked) throw new BadRequestException('Товар уже привязан. Используй обновление цены по ссылке')
    return this.prisma.$transaction(async tx => {
      const job = await tx.monitorJob.create({
        data: { kind: 'MATCH_1C', sourceKey: '05ru', perPage: 1, maxPages: 1,
          pendingUrls: ['product:' + productId] },
      })
      await tx.productMatchOutcome.upsert({
        where: { productId_sourceKey: { productId, sourceKey: '05ru' } },
        create: { productId, sourceKey: '05ru', status: 'PENDING', reason: null },
        update: { status: 'PENDING', reason: null, checkedAt: new Date() },
      })
      return job
    })
  }

  async list() {
    const rows = await this.prisma.competitorProduct.findMany({ where: { source: { key: '05ru' } }, include: { source: true, product: { include: { category: true } } }, orderBy: [{ lastCheckedAt: 'desc' }, { createdAt: 'desc' }] })
    return rows.map(row => this.decorated(row))
  }
  async candidates(id: string) {
    const link = await this.prisma.competitorProduct.findUnique({ where: { id } })
    if (!link) throw new NotFoundException('Карточка не найдена')
    const products = await this.prisma.product.findMany({ where: { status: 'ACTIVE' } })
    const theirs = { name: link.externalName || '', attributes: link.attributes }
    return products.map(product => {
      const check = compareItems(product, theirs)
      return {
        product: { id: product.id, oneCId: product.oneCId, name: product.name, sku: product.sku },
        ...check, reviewScore: reviewCandidate(product, theirs)?.score || 0,
        manualBlockers: manualConfirmationBlockers(product, theirs),
      }
    })
      .filter(c => c.score >= 20 || c.reviewScore >= 20 || c.product.id === link.productId)
      .sort((a,b) => (b.product.id === link.productId ? 1 : 0) - (a.product.id === link.productId ? 1 : 0)
        || Math.max(b.score, b.reviewScore) - Math.max(a.score, a.reviewScore))
      .slice(0, 8)
  }
  async confirm(id: string, productId: number) {
    const updated = await this.prisma.$transaction(async tx => {
      const link = await tx.competitorProduct.findUnique({ where: { id }, include: { source: true } })
      const product = await tx.product.findUnique({ where: { id: productId } })
      if (!link || !product || product.status !== 'ACTIVE') throw new NotFoundException('Карточка или активный товар не найдены')
      if (!link.externalName || !link.lastSuccessAt || link.lastError || link.latestPrice == null) {
        throw new BadRequestException('Сначала успешно проверь карточку и получи цену')
      }
      if (link.matchStatus === 'CONFIRMED' && link.productId && link.productId !== productId) {
        throw new ConflictException('Эта ссылка уже подтверждена для другого товара. Сначала сними прежнюю привязку.')
      }
      const other = await tx.competitorProduct.findFirst({
        where: { sourceId: link.sourceId, productId, matchStatus: 'CONFIRMED', id: { not: id } },
        select: { id: true, externalUrl: true },
      })
      if (other) {
        throw new ConflictException('У этого товара уже есть подтверждённая ссылка в источнике «' + link.source.name + '». Сначала сними старую привязку.')
      }
      const check = compareItems(product, { name: link.externalName, attributes: link.attributes })
      const blockers = manualConfirmationBlockers(product, { name: link.externalName, attributes: link.attributes })
      if (blockers.length) throw new BadRequestException(`Нельзя подтвердить карточку: ${blockers.join(', ')}. Проверь модель, бренд и тип товара.`)
      if (link.productId === productId && link.matchStatus === 'CONFIRMED' && link.confirmedFingerprint === fingerprint({ name: link.externalName, attributes: link.attributes }) && link.confirmedProductFingerprint === fingerprint(product)) {
        return tx.competitorProduct.findUniqueOrThrow({ where: { id }, include: { product: true, source: true } })
      }
      // Explicit user confirmation is allowed with missing fields; the UI lists them.
      await tx.monitorDelivery.updateMany({ where: { linkId: id, status: 'PENDING' }, data: { status: 'CANCELLED', lastError: 'Связь подтверждена заново' } })
      // A new/reconfirmed mapping starts a fresh baseline. Never replay a
      // price change that belonged to the previous mapping after it is reviewed.
      await tx.competitorPriceHistory.create({
        data: { competitorProductId: id, price: link.latestPrice, oldPrice: null, inStock: link.inStock, checkedAt: new Date() },
      })
      const row = await tx.competitorProduct.update({ where: { id }, data: {
        productId, matchStatus: 'CONFIRMED', confirmedAt: new Date(),
        confirmedFingerprint: fingerprint({ name: link.externalName, attributes: link.attributes }), confirmedProductFingerprint: fingerprint(product),
      }, include: { product: true, source: true } })
      await tx.auditLog.create({ data: { action: 'CONFIRM_PRICE_MATCH', entity: 'CompetitorProduct', entityId: id, details: { productId, missing: check.missing, manuallyOverriddenConflicts: check.conflicts } } })
      return row
    })
    await this.recordMatchOutcome(productId, updated.source.key as StoreKey, 'CONFIRMED')
    return this.decorated(updated)
  }
  async unmatch(id: string) {
    const removed = await this.prisma.$transaction(async tx => {
      await tx.monitorDelivery.updateMany({ where: { linkId: id, status: 'PENDING' }, data: { status: 'CANCELLED', lastError: 'Связь снята пользователем' } })
      return tx.competitorProduct.update({ where: { id }, data: { productId: null, matchStatus: 'UNMATCHED', confirmedAt: null, confirmedFingerprint: null, confirmedProductFingerprint: null }, include: { source: true } })
    })
    if (removed.productId) {
      await this.prisma.productMatchOutcome.deleteMany({
        where: { productId: removed.productId, sourceKey: removed.source.key },
      })
    }
    return removed
  }
  async history(id: string) { return this.prisma.competitorPriceHistory.findMany({ where: { competitorProductId: id }, orderBy: { checkedAt: 'desc' }, take: 100 }) }

  async check(dto: CheckCompetitorPriceDto) {
    const sourceKey = storeKeyFromUrl(dto.url)
    const parser = this.parserFor(sourceKey)
    const url = sourceKey === '05ru' ? fiveRuUrl(dto.url, 'product') : parser.normalizeProductUrl(dto.url)
    if (this.parsing) throw new ConflictException('Парсер занят. Дождись текущей проверки.')
    if (dto.productId && !await this.prisma.product.findUnique({ where: { id: dto.productId } })) throw new NotFoundException('Товар TEXHORU не найден')
    if (dto.productId) {
      const claimed = await this.prisma.competitorProduct.findUnique({ where: { externalUrl: url } })
      if (claimed?.productId && claimed.productId !== dto.productId) {
        throw new ConflictException('Эта карточка уже связана с другим товаром. Сначала сними прежнюю привязку.')
      }
      const source = await this.source(sourceKey)
      const other = await this.prisma.competitorProduct.findFirst({
        where: { sourceId: source.id, productId: dto.productId, matchStatus: 'CONFIRMED', externalUrl: { not: url } },
      })
      if (other) throw new ConflictException('У товара уже есть подтверждённая ссылка в «' + source.name + '». Сними старую привязку перед заменой.')
    }
    const source = await this.source(sourceKey)
    this.parsing = true
    try {
      const settings = sourceKey === '05ru' ? null : await this.settings(sourceKey)
      if (sourceKey !== '05ru' && !settings?.region?.trim()) {
        throw new BadRequestException('Сначала укажи город для магазина ' + source.name)
      }
      const result = await parser.parse(url, settings?.region)
      return await this.save(result, source.id, dto.productId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ошибка проверки'
      await this.prisma.competitorProduct.upsert({ where: { externalUrl: url }, update: { lastCheckedAt: new Date(), lastError: message }, create: { sourceId: source.id, externalUrl: url, lastCheckedAt: new Date(), lastError: message } })
      throw error
    } finally { this.parsing = false }
  }
  private async save(result: FiveRuResult, sourceId: string, suggestedProductId?: number, forceReview = false, autoConfirmExact = false, repairConflictingLinks: string[] = []) {
    return this.prisma.$transaction(async tx => {
      const existing = await tx.competitorProduct.findUnique({ where: { externalUrl: result.url }, include: { product: true } })
      let productId = existing?.productId || suggestedProductId || null
      let matchStatus = existing?.matchStatus || 'UNMATCHED'
      let confirmedFingerprint = existing?.confirmedFingerprint || null
      let confirmedProductFingerprint = existing?.confirmedProductFingerprint || null
      const theirs = { name: result.name, brand: result.brand, attributes: result.attributes, category: result.categoryName }
      const externalFingerprint = fingerprint({ name: result.name, attributes: result.attributes })
      const legacyExternalFingerprint = fingerprint(theirs)
      if (matchStatus === 'CONFIRMED') {
        const externalChanged = externalFingerprint !== confirmedFingerprint
          && legacyExternalFingerprint !== confirmedFingerprint
        if (externalChanged || !existing?.product || fingerprint(existing.product) !== confirmedProductFingerprint) {
          matchStatus = 'REVIEW_REQUIRED'
        } else {
          // Normalize legacy fingerprints created before manual confirmation
          // used the same name+attributes contract as list(), confirm() and 1C.
          confirmedFingerprint = externalFingerprint
        }
      }

      let autoConfirmed = false
      if (autoConfirmExact && suggestedProductId && matchStatus !== 'REVIEW_REQUIRED') {
        const product = await tx.product.findUnique({ where: { id: suggestedProductId } })
        if (!product || product.status !== ProductStatus.ACTIVE) {
          throw new ConflictException('Товар 1С изменился до автоматического подтверждения совпадения.')
        }
        const check = compareItems(product, theirs)
        if (!check.canAutoConfirm || check.conflicts.length) {
          throw new ConflictException('Совпадение больше не является точным. Требуется ручная проверка.')
        }
        if (existing?.productId && existing.productId !== suggestedProductId) {
          throw new ConflictException('Эта ссылка уже назначена другому товару 1С.')
        }
        const otherConfirmed = await tx.competitorProduct.findFirst({
          where: {
            sourceId, productId: suggestedProductId, matchStatus: 'CONFIRMED',
            ...(existing ? { id: { not: existing.id } } : {}),
          },
          select: { id: true },
        })
        if (!otherConfirmed) {
          productId = suggestedProductId
          matchStatus = 'CONFIRMED'
          confirmedFingerprint = externalFingerprint
          confirmedProductFingerprint = fingerprint(product)
          autoConfirmed = true
        }
      }

      if (autoConfirmed && repairConflictingLinks.length) {
        // A workflow may replace only a legacy assignment that its own fresh
        // card read proved wrong. Keep the old observation/history for review,
        // but do not let that obsolete binding make the exact replacement
        // ambiguous forever. Never detach a valid or merely incomplete card.
        const obsolete = await tx.competitorProduct.findMany({ where: {
          id: { in: repairConflictingLinks }, sourceId, productId: suggestedProductId,
          matchStatus: 'REVIEW_REQUIRED', ...(existing ? { NOT: { id: existing.id } } : {}),
        } })
        for (const old of obsolete) {
          const product = await tx.product.findUniqueOrThrow({ where: { id: suggestedProductId! } })
          if (!compareItems(product, { name: old.externalName || '', attributes: old.attributes }).conflicts.length) continue
          await tx.competitorProduct.update({ where: { id: old.id }, data: {
            productId: null, confirmedAt: null, confirmedFingerprint: null, confirmedProductFingerprint: null,
          } })
          await tx.auditLog.create({ data: { action: 'REPLACE_CONFLICTING_MONITOR_LINK', entity: 'Product',
            entityId: String(suggestedProductId), details: { obsoleteLinkId: old.id, replacementUrl: result.url } } })
        }
      }

      if (!productId && matchStatus !== 'REVIEW_REQUIRED') {
        if (forceReview) {
          // Uncertain discoveries remain unlinked unless the 1C product was
          // explicitly supplied by the current one-product discovery job.
          matchStatus = 'UNMATCHED'
        } else {
          const products = await tx.product.findMany({ where: { status: 'ACTIVE' } })
          const candidates = products.map(product => ({ product, check: compareItems(product, theirs) }))
            .filter(c => c.check.score >= 20 && !c.check.conflicts.length)
            .sort((a,b) => b.check.score - a.check.score)
          if (candidates.length) {
            // Even a mathematically exact candidate is only a suggestion.
            // A person confirms the URL-to-1C relationship once.
            productId = candidates[0].product.id
            matchStatus = 'SUGGESTED'
          }
        }
      } else if (suggestedProductId && matchStatus !== 'CONFIRMED' && matchStatus !== 'REVIEW_REQUIRED') {
        matchStatus = 'SUGGESTED'
      }
      const now = new Date()
      const data = { sourceId, productId, externalName: result.name, externalSku: result.externalSku,
        attributes: jsonValue(result.attributes), seller: result.seller, region: result.region, priceSource: result.priceSource,
        latestPrice: result.price, oldPrice: result.oldPrice, inStock: result.inStock, lastCheckedAt: now, lastSuccessAt: now, lastError: null,
        matchStatus, confirmedFingerprint, confirmedProductFingerprint,
        ...(autoConfirmed ? { confirmedAt: now } : {}),
      }
      const row = await tx.competitorProduct.upsert({ where: { externalUrl: result.url }, update: data, create: { ...data, externalUrl: result.url }, include: { source: true, product: true } })
      const previousPrice = existing?.priceSource === 'USER_FILE' ? null : existing?.latestPrice ?? null
      const priceChanged = previousPrice !== null && previousPrice !== result.price
      const stockChanged = existing?.inStock != null && result.inStock != null && existing.inStock !== result.inStock
      const historyExists = existing
        ? await tx.competitorPriceHistory.findFirst({ where: { competitorProductId: row.id }, select: { id: true } })
        : null
      const newlyConfirmed = autoConfirmed && existing?.matchStatus !== 'CONFIRMED'
      const baselineNeeded = newlyConfirmed || !historyExists || existing?.priceSource === 'USER_FILE'
      const history = baselineNeeded || priceChanged || stockChanged
        ? await tx.competitorPriceHistory.create({
            data: { competitorProductId: row.id, price: result.price,
              oldPrice: priceChanged && !newlyConfirmed ? previousPrice : null, inStock: result.inStock, checkedAt: now },
          })
        : null
      // A newly confirmed mapping starts from today's price. Do not replay a
      // price movement that happened while the URL was only a suggestion.
      if (priceChanged && history && row.matchStatus === 'CONFIRMED' && !newlyConfirmed) {
        await this.exchange.enqueue(row.id, tx, history.id, previousPrice)
      }
      if (autoConfirmed) {
        await tx.auditLog.create({ data: {
          action: 'AUTO_CONFIRM_PRICE_MATCH', entity: 'CompetitorProduct', entityId: row.id,
          details: { productId: suggestedProductId ?? null, basis: 'complete model/variant configuration without explicit conflicts; best-ranked candidate selected when alternatives are weaker or 1C omits SIM type' },
        } })
      }
      return this.decorated(row)
    })
  }
  // A saved 05.ru link is stronger evidence than a storefront search page.
  // Refresh its price from the *actual product URL*, never from stale stored prices.

  private async refreshKnownMatch(
    product: { id: number; name: string; brand?: string | null; attributes?: unknown },
    sourceKey: StoreKey,
    parser: StorefrontAdapter,
    region?: string | null,
  ): Promise<boolean> {
    // Reuse only cards already assigned to this exact 1C product and this store.
    const saved = await this.prisma.competitorProduct.findMany({
      where: { source: { key: sourceKey }, productId: product.id, matchStatus: 'CONFIRMED', externalName: { not: null } },
      orderBy: { lastSuccessAt: 'desc' }, take: 50,
    })
    if (!saved.length) return false
    const source = await this.source(sourceKey)
    if (saved.length !== 1) throw new Error(
      'У товара ' + product.name + ' несколько подтверждённых ссылок в «' + source.name + '». Исправь привязки вручную.'
    )
    const url = saved[0].externalUrl
    let fresh: StoreProductResult
    try { fresh = await parser.parse(url, region) }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.prisma.competitorProduct.update({
        where: { id: saved[0].id },
        data: { lastCheckedAt: new Date(), lastError: reason.slice(0, 2000) },
      })
      throw new Error(source.name + ': сохранённая карточка (' + url + '), повторная проверка не удалась: ' + reason)
    }
    const updated = compareItems(product, { name: fresh.name, brand: fresh.brand, attributes: fresh.attributes })
    if (!this.matching.strongVariant(updated)) {
      // A previously confirmed 1 TB laptop must not retain a 512 GB link
      // after a recheck. Demote BEFORE saving, so a price-change message
      // cannot be queued using the obsolete confirmation.
      await this.prisma.monitorDelivery.updateMany({
        where: { linkId: saved[0].id, status: 'PENDING' },
        data: { status: 'CANCELLED', lastError: 'Характеристики товара не совпадают с 1С' },
      })
      await this.prisma.competitorProduct.update({
        where: { id: saved[0].id },
        data: { matchStatus: 'REVIEW_REQUIRED', confirmedAt: null,
          confirmedFingerprint: null, confirmedProductFingerprint: null },
      })
      await this.save(fresh, source.id)
      throw new Error(source.name + ': сохранённая карточка изменилась, совпадение требует проверки: ' + fresh.name
        + (updated.ours.kind === 'laptop' ? '. Проверь объём SSD: ' + (updated.ours.storage || '?')
          + ' ГБ в 1С, ' + (updated.theirs.storage || '?') + ' ГБ у магазина.' : ''))
    }
    await this.save(fresh, source.id, product.id)
    return true
  }

  /**
   * A real business can import its own supplier/monitoring price file without
   * depending on 05.ru navigation. Imported prices are NOT verified 05.ru
   * observations and must never enter automatic price changes or 1C deliveries.
   * All rows are checked before any change is committed.
   */
  async importManualPrices(dto: ImportManualCompetitorPricesDto) {
    if (this.parsing || await this.prisma.monitorJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } })) {
      throw new ConflictException('Мониторинг занят. Повтори импорт после окончания задания.')
    }
    if (!dto.rows?.length || dto.rows.length > 500) throw new BadRequestException('Нужно передать от 1 до 500 строк прайса.')
    const now = Date.now()
    const seenUrls = new Set<string>()
    const seenOneC = new Set<string>()
    const entries = dto.rows.map((row, index) => {
      const line = index + 2
      const url = fiveRuUrl(row.url, 'product')
      const name = row.name.trim()
      const observedAt = new Date(row.observedAt)
      const oneCId = row.oneCId?.trim() || undefined
      if (!name || name.length > 300) throw new BadRequestException('Строка ' + line + ': название товара обязательно.')
      if (!Number.isSafeInteger(row.price) || row.price < 1 || row.price > 5_000_000) throw new BadRequestException('Строка ' + line + ': цена должна быть целым числом рублей.')
      if (!Number.isFinite(observedAt.getTime()) || observedAt.getTime() > now + 5 * 60_000 || observedAt.getTime() < now - 30 * 86400_000) {
        throw new BadRequestException('Строка ' + line + ': дата прайса должна быть за последние 30 дней, не из будущего.')
      }
      if (seenUrls.has(url)) throw new BadRequestException('Повторная ссылка в файле: ' + url)
      seenUrls.add(url)
      if (oneCId) {
        if (seenOneC.has(oneCId)) throw new BadRequestException('Один товар 1С повторяется в файле: ' + oneCId)
        seenOneC.add(oneCId)
      }
      return { url, name, price: row.price, observedAt, oneCId, inStock: row.inStock ?? null, line }
    })
    const source = await this.source()
    return this.prisma.$transaction(async tx => {
      let created = 0, updated = 0, associated = 0
      for (const entry of entries) {
        const old = await tx.competitorProduct.findUnique({ where: { externalUrl: entry.url }, include: { product: true } })
        if (old && old.sourceId !== source.id) throw new BadRequestException('Ссылка уже относится к другому источнику: ' + entry.url)
        const product = entry.oneCId ? await tx.product.findUnique({ where: { oneCId: entry.oneCId } }) : old?.product
        if (entry.oneCId && (!product || product.status !== 'ACTIVE')) throw new BadRequestException('Строка ' + entry.line + ': товар 1С не найден или неактивен: ' + entry.oneCId)
        if (old?.productId && entry.oneCId && old.productId !== product?.id) {
          throw new BadRequestException('Строка ' + entry.line + ': карточка уже связана с другим товаром 1С.')
        }
        if (product) {
          const match = compareItems(product, { name: entry.name })
          // The file can contain an incorrect URL paired with a copied 1C name.
          // Compare model/storage encoded in the 05.ru slug too, when parseable.
          const slug = decodeURIComponent(new URL(entry.url).pathname.split('/p/')[1] || '').replace(/-\d+\/$/, '').replace(/-/g, ' ')
          const slugVariant = identity({ name: slug })
          if ((slugVariant.model && slugVariant.model !== match.ours.model)
            || (slugVariant.storage && match.ours.storage && slugVariant.storage !== match.ours.storage)
            || (slugVariant.color && match.ours.color && slugVariant.color !== match.ours.color)) {
            throw new BadRequestException('Строка ' + entry.line + ': ссылка 05.ru указывает на другую модель, память или цвет.')
          }
          // Require the relevant variant information, not just overlapping words.
          if (!match.ours.model || !match.theirs.model || match.ours.model !== match.theirs.model
            || (match.ours.storage && match.ours.storage !== match.theirs.storage)
            || (match.ours.color && match.ours.color !== match.theirs.color)
            || match.conflicts.length) {
            throw new BadRequestException('Строка ' + entry.line + ': модель, память или цвет не совпадают с товаром 1С «' + product.name + '».')
          }
        }
        if (old?.lastCheckedAt && old.lastCheckedAt.getTime() > entry.observedAt.getTime()) {
          throw new BadRequestException('Строка ' + entry.line + ': в TEXHORU уже есть более свежая проверка этой карточки.')
        }
        if (old?.matchStatus === 'CONFIRMED' && fingerprint({ name: entry.name }) !== fingerprint({ name: old.externalName || '' })) {
          // Never erase an existing verified confirmed identity with untrusted text.
          const original = identity({ name: old.externalName || '' })
          const incoming = identity({ name: entry.name })
          if (original.model !== incoming.model || original.storage !== incoming.storage || original.color !== incoming.color) {
            throw new BadRequestException('Строка ' + entry.line + ': импорт противоречит ранее подтверждённой карточке.')
          }
        }
        // USER_FILE is intentionally distinguishable from a verified 05.ru price.
        // lastSuccessAt=null and lastError prevent applying prices or queueing 1C updates.
        const data = {
          sourceId: source.id, externalName: entry.name, latestPrice: entry.price,
          inStock: entry.inStock, priceSource: 'USER_FILE',
          lastCheckedAt: entry.observedAt, lastSuccessAt: null,
          lastError: 'Цена из импортированного файла, не проверена на 05.ru.',
          ...(!old && product ? { productId: product.id, matchStatus: 'SUGGESTED' } : {}),
        }
        const record = await tx.competitorProduct.upsert({
          where: { externalUrl: entry.url },
          create: { externalUrl: entry.url, ...data },
          update: data,
        })
        if (old) updated++; else created++
        if (product) associated++
        await tx.monitorDelivery.updateMany({
          where: { linkId: record.id, status: 'PENDING' },
          data: { status: 'CANCELLED', lastError: 'Наблюдение заменено импортом из файла, источник не проверен' },
        })
        // Do not fabricate a website verification time: this is the date from the file.
        const duplicate = await tx.competitorPriceHistory.findFirst({
          where: { competitorProductId: record.id, checkedAt: entry.observedAt, price: entry.price, inStock: entry.inStock },
        })
        if (!duplicate) await tx.competitorPriceHistory.create({
          data: { competitorProductId: record.id, price: entry.price, inStock: entry.inStock, checkedAt: entry.observedAt },
        })
      }
      await tx.auditLog.create({
        data: { action: 'IMPORT_MANUAL_COMPETITOR_PRICES', entity: 'CompetitorSource', entityId: source.id,
          details: { created, updated, associated, rows: entries.length, verifiedOn05Ru: false } },
      })
      return { ok: true, created, updated, associated, imported: entries.length, verifiedOn05Ru: false }
    })
  }

  /**
   * Only verified product-page observations are saved as competitor prices.
   * The indexed title is a navigation hint, never a verified price.
   */
  private async hasCompletedSmartphoneIndex(): Promise<boolean> {
    const now = Date.now()
    if (this.indexedCatalogStatus && this.indexedCatalogStatus.expires > now) return this.indexedCatalogStatus.ready
    const index = await this.prisma.monitorJob.findFirst({
      where: { kind: 'INDEX_05RU_SMARTPHONES', status: 'COMPLETED' },
      orderBy: { finishedAt: 'desc' },
      select: { processed: true, finishedAt: true, lastError: true },
    })
    const ready = Boolean(index && index.processed > 0 && !index.lastError && index.finishedAt
      && now - index.finishedAt.getTime() < 7 * 86400_000)
    this.indexedCatalogStatus = { expires: now + 60_000, ready }
    return ready
  }

  private async refreshIndexedMatch(product: { id: number; name: string; brand?: string | null; attributes?: unknown }, repairConflictingLinks: string[] = []): Promise<boolean> {
    const requested = identity(product)
    if (!requested.model && !requested.productCode && !requested.mpn) return false
    const catalogFilters: Prisma.CompetitorCatalogEntryWhereInput[] = []
    if (requested.model) catalogFilters.push({
      model: canonicalModel(requested.model) === 'iphone air'
        ? { in: ['iphone air', 'iphone 17 air'] }
        : requested.model,
      ...(requested.storage ? { OR: [{ storage: requested.storage }, { storage: null }] } : {}),
    })
    // Older indices predate iPhone Air recognition and stored model=null.
    // Use the real 05.ru title as a discovery hint until the next reindex.
    // Actual model, storage and colour are checked from the product page.
    if (canonicalModel(requested.model) === 'iphone air') {
      catalogFilters.push({ title: { contains: 'iPhone Air' } })
    }
    if (requested.productCode) catalogFilters.push({ title: { contains: requested.productCode } })
    if (requested.mpn) catalogFilters.push({ title: { contains: requested.mpn } })
    const options = await this.prisma.competitorCatalogEntry.findMany({
      where: { OR: catalogFilters },
      take: 1000,
    })
    // Catalog titles are hints. Missing colour/SIM on a tile must not reject
    // a real product before reading its specifications.
    const ranked = options.map(link => ({ link, check: compareItems(product, { name: link.title }) }))
      .filter(option => !option.check.conflicts.length
        && (!requested.model || (option.check.theirs.model
          && canonicalModel(option.check.theirs.model) === canonicalModel(requested.model))
          || Boolean(requested.productCode && option.check.theirs.productCode === requested.productCode)))
      .sort((a, b) => b.check.score - a.check.score).slice(0, 24)
    // One DB query for all candidate ownership checks, instead of up to eight.
    const knownLinks = await this.prisma.competitorProduct.findMany({
      where: { externalUrl: { in: ranked.map(row => row.link.externalUrl) } },
      select: { externalUrl: true, productId: true },
    })
    const owners = new Map(knownLinks.map(row => [row.externalUrl, row.productId]))
    const verified: Array<{ result: FiveRuResult; check: ReturnType<typeof compareItems> }> = []
    for (const { link } of ranked) {
      const owner = owners.get(link.externalUrl)
      if (owner && owner !== product.id) continue
      try {
        // Initial matching can reuse a recently verified card across colours/
        // capacities. Scheduled price monitoring ALWAYS calls fresh parse().
        const result = typeof this.fiveRu.parseForMatching === 'function'
          ? await this.fiveRu.parseForMatching(link.externalUrl)
          : await this.fiveRu.parse(link.externalUrl)
        const check = compareItems(product, { name: result.name, brand: result.brand, attributes: result.attributes })
        if (this.matching.strongVariant(check)) verified.push({ result, check })
      } catch (error) {
        if (/HTTP\s+(?:401|403|429)\b|проверку доступа/i.test(error instanceof Error ? error.message : String(error))) throw error
      }
    }
    if (!verified.length) return false

    const exact = rankVerifiedMatches(verified.filter(item => item.check.canAutoConfirm))
    const source = await this.source()
    // Same decision policy as live search. An indexed model/colour/SIM match
    // should not remain stuck in review just because there are two offers.
    if (exact.length && hasDecisiveWinner(exact)) {
      await this.save(exact[0].result, source.id, product.id, false, true, repairConflictingLinks)
      return true
    }
    if (exact.length > 1) {
      // Never drop all discovered links on the floor: the best verified card
      // must remain visible on the 1C item even when manual review is needed.
      // Additional alternatives stay unlinked to prevent double ownership.
      let offered = 0
      for (const option of exact.slice(0, 3)) {
        const claimed = await this.prisma.competitorProduct.findUnique({
          where: { externalUrl: option.result.url },
        })
        if (claimed?.productId && claimed.productId !== product.id) continue
        await this.save(option.result, source.id, offered === 0 ? product.id : undefined, true)
        offered++
      }
      return true
    }

    verified.sort((a, b) => b.check.score - a.check.score)
    const top = verified[0]
    const runnerUp = verified[1]
    if (verified.length === 1 || (top && runnerUp && top.check.score - runnerUp.check.score >= 10)) {
      // A clear but non-exact candidate is attached as SUGGESTED, never confirmed.
      await this.save(top.result, source.id, product.id)
      return true
    }

    // Several close candidates stay review-only, but at least the first
    // verified offer is associated with the 1C item for a visible choice.
    let offered = 0
    for (const option of verified.slice(0, 3)) {
      const claimed = await this.prisma.competitorProduct.findUnique({
        where: { externalUrl: option.result.url },
      })
      if (claimed?.productId && claimed.productId !== product.id) continue
      await this.save(option.result, source.id, offered === 0 ? product.id : undefined, true)
      offered++
    }
    return true
  }

  // Explicitly approved price change. Only the ten opt-in 1C products enter the outbound queue.
  async applyRecommended(id: string, dto: ApplyRecommendedPriceDto) {
    const updated = await this.prisma.$transaction(async tx => {
      const link = await tx.competitorProduct.findUnique({ where: { id }, include: { product: true, source: true } })
      if (!link || !link.product || link.product.status !== ProductStatus.ACTIVE) throw new NotFoundException('Подтверждённый товар не найден')
      if (link.source.key !== '05ru' || link.matchStatus !== 'CONFIRMED'
        || fingerprint(link.product) !== link.confirmedProductFingerprint
        || fingerprint({ name: link.externalName || '', attributes: link.attributes }) !== link.confirmedFingerprint) {
        throw new BadRequestException('Связь с 05.ru устарела: проверь и подтверди товар заново')
      }
      if (link.lastError || !link.lastSuccessAt || Date.now() - link.lastSuccessAt.getTime() > 24 * 3600_000
        || link.inStock !== true || !link.latestPrice || link.latestPrice <= 100) {
        throw new BadRequestException('Нужна свежая проверка цены и подтверждённое наличие на 05.ru')
      }
      const product = link.product
      const price = link.latestPrice - 100
      if (dto.expectedCurrentPrice !== product.price || dto.expectedCompetitorPrice !== link.latestPrice || dto.targetPrice !== price) {
        throw new ConflictException('Цена изменилась. Обнови мониторинг перед применением')
      }
      if (price < 1) throw new BadRequestException('Некорректная новая цена')
      const largeChange = Math.abs(price - product.price) > product.price * 0.1
      if (!allowLargeTestPriceChange() && largeChange && !dto.acceptLargeChange) throw new BadRequestException('Изменение больше 10%. Требуется явное подтверждение')
      if (price === product.price) {
        throw new BadRequestException('Цена уже установлена; повторная отправка не требуется')
      }
      if (!product.priceSyncEnabled || !product.oneCId) {
        throw new BadRequestException('Товар не включён в разрешённую область обмена с 1С')
      }
      const message = await OneCPriceSyncService.queue(tx, product, price, id)
      if (!message) throw new ConflictException('Не удалось поставить цену в очередь 1С')
      await tx.auditLog.create({ data: {
        action: 'QUEUE_MONITOR_PRICE_TO_1C', entity: 'Product', entityId: String(product.id),
        details: { monitorLinkId: id, previousPrice: product.price, competitorPrice: link.latestPrice,
          newPrice: price, costCheck: 'disabled', largeChange,
          oneCQueued: true, oneCMessageId: message.id },
      } })
      return { ok: true, productId: product.id, previousPrice: product.price, newPrice: price,
        siteOnly: false, oneCQueued: true, oneCMessageId: message.id }
    })
    return updated
  }

  /**
   * Preview is read-only. The returned token binds the exact verified
   * observations and original site prices to the user's single confirmation.
   */
  private async bulkPriceSnapshot(db: PrismaService | Prisma.TransactionClient, categoryPath = '', includeAll = false) {
    const path = categoryPath.trim()
    // Include every saved 05.ru price change, not only rows already eligible for 1C.
    // The preview is read-only: it never creates OneCPriceChange records.
    const links = await db.competitorProduct.findMany({
      where: { source: { key: '05ru' } },
      include: {
        source: true,
        product: { include: { category: true } },
        history: {
          // The first successful scan is a baseline. It can still differ from the
          // TEXHORU retail price and must be eligible for a manual proposal.
          orderBy: [{ checkedAt: 'desc' }, { createdAt: 'desc' }],
          take: 1,
        },
      },
      take: 10000,
    })
    const now = Date.now()
    const rejectedAudits = await db.auditLog.findMany({
      where: { action: 'REJECT_MONITOR_PROPOSAL' }, orderBy: { createdAt: 'desc' }, take: 5000,
      select: { entityId: true, details: true },
    })
    const rejected = new Set(rejectedAudits.map(row => {
      const details = row.details as { linkId?: string; oldPrice?: number; competitorPrice?: number } | null
      return row.entityId + ':' + details?.linkId + ':' + details?.oldPrice + ':' + details?.competitorPrice
    }))
    const pending = await db.oneCPriceChange.findMany({ where: { status: 'PENDING' }, select: { productId: true } })
    const pendingIds = new Set(pending.map(row => row.productId))
    const linkCounts = new Map<number, number>()
    for (const link of links) {
      if (link.productId !== null) linkCounts.set(link.productId, (linkCounts.get(link.productId) || 0) + 1)
    }
    const rows: Array<{
      id: string; productId: number | null; productName: string; categoryPath: string;
      costPrice: number | null; oldPrice: number | null; previousCompetitorPrice: number | null;
      competitorPrice: number; newPrice: number; lastSuccessAt: string | null; externalUrl: string;
      canSend: boolean; blockedReasons: string[]; externalName: string; matchVerified: boolean; awaitingOneC: boolean;
    }> = []

    for (const link of links) {
      const history = link.history[0]
      const product = link.product
      const competitorPrice = link.latestPrice ?? history?.price ?? null
      if (competitorPrice === null && !includeAll) continue
      const newPrice = (competitorPrice ?? 0) - 100
      // A price difference against TEXHORU matters even if 05.ru has never changed.
      // Unmapped cards have no site retail price: show only actual 05.ru movements.
      const differsFromSite = !!product && newPrice !== product.price
      const changedOn05 = history?.oldPrice !== null && history?.oldPrice !== undefined
        && history.oldPrice !== history.price
      if (!includeAll && !differsFromSite && !(changedOn05 && !product)) continue
      const reasons: string[] = []
      const addReason = (reason: string) => { if (!reasons.includes(reason)) reasons.push(reason) }

      const comparison = product ? compareItems(product, { name: link.externalName || '', attributes: link.attributes }) : null
      const matchVerified = !!product && link.matchStatus === 'CONFIRMED' && !comparison?.conflicts.length
      if (comparison?.conflicts.length) addReason('Карточка 05.ru не совпадает с нашим товаром: ' + comparison.conflicts.join(', '))
      if (!product) addReason('Товар не сопоставлен с каталогом TEXHORU')
      if (link.matchStatus !== 'CONFIRMED') addReason('Сопоставление с товаром не подтверждено')
      if (link.priceSource === 'USER_FILE') addReason('Цена загружена из файла, а не проверена на 05.ru')
      if (link.lastError) addReason('Последняя проверка завершилась ошибкой: ' + link.lastError)
      if (!link.lastSuccessAt || now - link.lastSuccessAt.getTime() < 0 || now - link.lastSuccessAt.getTime() > 24 * 3600_000) {
        addReason('Цена 05.ru устарела: нужна успешная проверка не старше 24 часов')
      }
      if (link.latestPrice === null) addReason('Нет актуальной цены 05.ru')
      else if (history && link.latestPrice !== history.price) addReason('Текущая цена 05.ru не совпадает с последней записью истории')
      if (link.inStock !== true) addReason(link.inStock === false ? 'На 05.ru товар отсутствует в наличии' : 'Наличие товара на 05.ru не подтверждено')
      if (newPrice <= 0) addReason('Цена 05.ru минус 100 ₽ должна быть больше нуля')

      if (product) {
        if (product.status !== ProductStatus.ACTIVE) addReason('Товар неактивен в TEXHORU')
        if (!product.oneCId) addReason('У товара отсутствует GUID 1С')
        if (!product.priceSyncEnabled) addReason('Товар не включён в разрешённую область обмена с 1С')
        if (product.stockQty <= product.reservedQty) addReason('Нет свободного остатка товара')
        if (pendingIds.has(product.id)) addReason('Предыдущее изменение цены ещё ожидает подтверждения 1С')
        if ((linkCounts.get(product.id) || 0) > 1) addReason('Несколько карточек 05.ru сопоставлены с одним товаром')
        if (link.matchStatus === 'CONFIRMED'
          && (fingerprint(product) !== link.confirmedProductFingerprint
            || fingerprint({ name: link.externalName || '', attributes: link.attributes }) !== link.confirmedFingerprint)) {
          addReason('Сопоставление устарело: данные товара или карточки 05.ru изменились')
        }
        if (!allowLargeTestPriceChange() && product.price > 0 && Math.abs(newPrice - product.price) > product.price * 0.1) {
          addReason('Изменение превышает 10% от текущей цены')
        }
        if (newPrice === product.price) addReason('Предлагаемая цена уже совпадает с текущей ценой TEXHORU')
        if (rejected.has(product.id + ':' + link.id + ':' + product.price + ':' + competitorPrice)) {
          addReason('Это предложение уже отклонено для текущих цен')
        }
      }

      if (path && (!product || (product.category.name !== path && !product.category.name.startsWith(path + ' / ')))) continue
      rows.push({
        id: link.id,
        productId: product?.id ?? null,
        productName: product?.name || link.externalName || 'Товар без названия',
        categoryPath: product?.category.name || 'Без сопоставления',
        costPrice: product?.costPrice ?? null,
        oldPrice: product?.price ?? null,
        previousCompetitorPrice: history?.oldPrice ?? null,
        competitorPrice: competitorPrice ?? 0,
        newPrice,
        lastSuccessAt: link.lastSuccessAt?.toISOString() ?? null,
        externalUrl: link.externalUrl,
        externalName: link.externalName || 'Название не получено',
        matchVerified,
        awaitingOneC: product ? pendingIds.has(product.id) : false,
        canSend: reasons.length === 0,
        blockedReasons: reasons,
      })
    }

    // Catalog diagnostics are separate from price-change proposals. No retail
    // price is guessed for products without a verified 05.ru card.
    const imported = await db.product.findMany({
      where: { oneCId: { not: null }, status: ProductStatus.ACTIVE },
      select: { id: true, name: true, category: { select: { name: true } } },
      take: 10000,
    })
    const linkedProductIds = new Set(links.flatMap(link => link.productId === null ? [] : [link.productId]))
    const unlinkedProducts = imported
      .filter(product => !linkedProductIds.has(product.id))
      .filter(product => !path || product.category.name === path || product.category.name.startsWith(path + ' / '))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    const uncheckedLinks = links.filter(link => link.product?.oneCId
      && (!link.lastSuccessAt || link.latestPrice === null || link.lastError)
      && (!path || link.product.category.name === path || link.product.category.name.startsWith(path + ' / ')))
    const diagnostics = {
      unlinkedCount: unlinkedProducts.length,
      unlinked: unlinkedProducts.slice(0, 50).map(product => ({
        productId: product.id, productName: product.name, categoryPath: product.category.name,
      })),
      uncheckedCount: uncheckedLinks.length,
      unchecked: uncheckedLinks.slice(0, 50).map(link => ({
        productId: link.productId, productName: link.product!.name,
        reason: link.lastError || (!link.lastSuccessAt
          ? 'Карточка 05.ru ещё не проверена парсером'
          : 'Нет достоверной текущей цены 05.ru'),
      })),
    }

    rows.sort((a, b) => a.categoryPath.localeCompare(b.categoryPath, 'ru')
      || a.productName.localeCompare(b.productName, 'ru') || a.id.localeCompare(b.id))
    const available = rows.filter(row => row.canSend)
    const blocked = rows.filter(row => !row.canSend)
    const token = createHash('sha256').update(JSON.stringify({ path, rows })).digest('hex')
    return {
      token, count: available.length, totalScope: rows.length, skipped: blocked.length,
      unknownCost: blocked.filter(row => row.blockedReasons.includes('Не указана себестоимость')).length,
      largeChanges: blocked.filter(row => row.blockedReasons.includes('Изменение превышает 10% от текущей цены')).length,
      oneCQueued: available.length, items: rows, diagnostics,
    }
  }

  async priceReadiness() {
    // Database-only classification. Opening this screen never starts a parser.
    const [snapshot, products, pending, checking] = await Promise.all([
      this.bulkPriceSnapshot(this.prisma, '', true),
      this.prisma.product.findMany({ where: { oneCId: { not: null }, status: 'ACTIVE' }, include: { category: true }, orderBy: { id: 'asc' } }),
      this.prisma.oneCPriceChange.findMany({ where: { status: 'PENDING' } }),
      this.prisma.monitorJob.count({ where: { kind: 'RECHECK', status: { in: ['QUEUED', 'RUNNING'] } } }),
    ])
    const rows = new Map(snapshot.items.map(row => [row.productId, row]))
    const messages = new Map(pending.map(row => [row.productId, row]))
    const items = products.map(product => {
      const row = rows.get(product.id)
      const message = messages.get(product.id)
      const reason = !product.priceSyncEnabled ? 'Не разрешён обмен с 1С'
        : !row ? 'Нет привязки к 05.ru' : row.blockedReasons.join('; ') || null
      return { productId: product.id, name: product.name, categoryPath: product.category.name,
        authorized: product.priceSyncEnabled, oldPrice: message?.oldPrice ?? product.price,
        newPrice: message?.newPrice ?? (row && row.newPrice > 0 ? row.newPrice : null),
        status: message ? 'PENDING' as const : !reason ? 'READY' as const : 'BLOCKED' as const,
        reason: message ? message.lastError : reason }
    })
    return { items, authorized: products.filter(product => product.priceSyncEnabled).length, checking: checking > 0 }
  }

  checkAllowedPrices() { return this.checkAll({ authorizedOnly: true }) }

  async previewBulkPrices(dto: BulkPriceScopeDto) {
    return this.bulkPriceSnapshot(this.prisma, dto.categoryPath)
  }

  async applyBulkPrices(dto: BulkApplyPricesDto) {
    if (await this.prisma.monitorJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } })) {
      throw new ConflictException('Проверка цен ещё идёт. Заверши её перед массовым изменением.')
    }
    return this.prisma.$transaction(async tx => {
      // Verify token *inside the same transaction* that changes prices.
      const snapshot = await this.bulkPriceSnapshot(tx, dto.categoryPath)
      if (snapshot.token !== dto.token) {
        throw new ConflictException('Цены или совпадения изменились. Обнови предварительный просмотр и повтори.')
      }
      if (!snapshot.count) throw new BadRequestException('Нет подтверждённых актуальных цен для обновления')
      let oneCQueued = 0
      const selection = new Set(dto.ids)
      const chosen = snapshot.items.filter(item => selection.has(item.id) && item.canSend)
      if (!selection.size || selection.size !== chosen.length) {
        throw new BadRequestException('Выбраны заблокированные или устаревшие предложения. Обнови предварительный просмотр.')
      }
      for (const item of chosen) {
        if (item.productId === null) throw new BadRequestException('Нельзя отправить несопоставленный товар в 1С')
        const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId } })
        const message = await OneCPriceSyncService.queue(tx, product, item.newPrice, item.id)
        if (!message) throw new ConflictException('Товар не подключён к обмену с 1С. Ничего не изменено.')
        oneCQueued++
        await tx.auditLog.create({ data: {
          action: 'QUEUE_MONITOR_PRICE_TO_1C', entity: 'Product', entityId: String(product.id),
          details: { bulk: true, monitorLinkId: item.id, previousPrice: item.oldPrice,
            competitorPrice: item.competitorPrice, newPrice: item.newPrice,
            costCheck: 'disabled', largeChange: Math.abs(item.newPrice - product.price) > product.price * 0.1,
            oneCQueued: true, oneCMessageId: message.id },
        } })
      }
      return { ok: true, applied: chosen.length, skipped: snapshot.skipped,
        oneCQueued, siteOnly: 0 }
    }, { timeout: 120000 })
  }

  /** Decline selected observations; a changed competitor or website price can be proposed again. */
  async rejectBulkPrices(dto: BulkApplyPricesDto) {
    return this.prisma.$transaction(async tx => {
      const snapshot = await this.bulkPriceSnapshot(tx, dto.categoryPath)
      if (snapshot.token !== dto.token) throw new ConflictException('Предложения изменились. Обновите страницу.')
      const ids = new Set(dto.ids)
      const chosen = snapshot.items.filter(item => ids.has(item.id) && item.canSend)
      if (!ids.size || ids.size !== chosen.length) throw new BadRequestException('Выбраны заблокированные или устаревшие предложения')
      for (const item of chosen) await tx.auditLog.create({ data: {
        action: 'REJECT_MONITOR_PROPOSAL', entity: 'Product', entityId: String(item.productId),
        details: { linkId: item.id, oldPrice: item.oldPrice, competitorPrice: item.competitorPrice,
          suggestedPrice: item.newPrice, category: item.categoryPath },
      } })
      return { ok: true, rejected: chosen.length }
    })
  }

  async settings(sourceKey: StoreKey = '05ru') {
    requireEnabledStore(sourceKey)
    const definition = STORE_DEFINITIONS.find(item => item.key === sourceKey)
    if (!definition) throw new BadRequestException('Неизвестный магазин мониторинга')
    return this.prisma.monitorSettings.upsert({
      where: { id: sourceKey },
      update: {},
      create: { id: sourceKey, catalogUrl: sourceKey === '05ru' ? 'https://05.ru/cat/c/02e38f8a/telefony_i_gadzety/' : definition.baseUrl,
        intervalMinutes: sourceKey === '05ru' ? 1440 : 0,
        nextRunAt: sourceKey === '05ru' ? nextDailyPriceCheck(new Date()) : null },
    })
  }
  async updateSettings(dto: MonitorSettingsDto) {
    const sourceKey = (dto.sourceKey || '05ru') as StoreKey
    const current = await this.settings(sourceKey)
    const definition = STORE_DEFINITIONS.find(item => item.key === sourceKey)!
    const catalogUrl = sourceKey === '05ru'
      ? fiveRuUrl(dto.catalogUrl || current.catalogUrl, 'catalog')
      : definition.baseUrl
    if (dto.intervalMinutes > 0 && dto.intervalMinutes < 120) throw new BadRequestException('Минимальный интервал — 120 минут')
    const region = dto.region === undefined ? current.region : (dto.region.trim() || null)
    if (sourceKey !== '05ru' && dto.intervalMinutes > 0 && !region) {
      throw new BadRequestException('Для автоматического мониторинга ' + definition.name + ' сначала укажи город')
    }
    return this.prisma.monitorSettings.upsert({
      where: { id: sourceKey },
      create: { id: sourceKey, catalogUrl, region, intervalMinutes: dto.intervalMinutes,
        nextRunAt: dto.intervalMinutes === 1440 ? nextDailyPriceCheck(new Date()) : dto.intervalMinutes ? new Date(Date.now() + dto.intervalMinutes * 60000) : null },
      update: { catalogUrl, region, intervalMinutes: dto.intervalMinutes,
        nextRunAt: dto.intervalMinutes === 1440 ? nextDailyPriceCheck(new Date()) : dto.intervalMinutes ? new Date(Date.now() + dto.intervalMinutes * 60000) : null },
    })
  }
  jobs() { return this.prisma.monitorJob.findMany({ where: { kind: { not: 'PRICE_UPDATE' }, OR: [{ sourceKey: '05ru' }, { sourceKey: null }] }, orderBy: { createdAt: 'desc' }, take: 30 }) }
  async scan(dto: ScanFiveRuDto) {
    const url = fiveRuUrl(dto.url, 'catalog')
    return this.prisma.monitorJob.create({ data: { kind: 'CATALOG', sourceKey: '05ru', url, maxPages: dto.maxPages || 1, perPage: 200 } })
  }
  private async queueAutoFindForSource(dto: AutoFindOneCSectionDto, sourceKey: StoreKey, path: string, limit: number) {
    const imported = await this.prisma.product.findMany({
      where: { oneCId: { not: null }, status: 'ACTIVE', price: { gt: 0 } },
      include: { category: true }, orderBy: [{ id: 'asc' }],
    })
    const scoped = imported.filter(p => p.stockQty > p.reservedQty
      && (!path || p.category.name === path || p.category.name.startsWith(path + ' / '))
      && (!dto.onlyInStockSmartphones || /(?:смартфон|smartphone)/i.test(p.category.name)))
    if (!scoped.length) return { sourceKey, eligible: 0, queued: 0, job: null, hasSmartphones: false }
    const confirmed = dto.onlyUnlinked
      ? await this.prisma.competitorProduct.findMany({
          where: { source: { key: sourceKey }, productId: { not: null } },
          select: { productId: true },
        })
      : []
    const linkedIds = new Set(confirmed.map(link => link.productId))
    // Avoid repeating confirmed negatives on every automatic bulk launch.
    const outcomes = await this.prisma.productMatchOutcome?.findMany?.({
      where: { sourceKey, status: 'NO_MATCH' }, select: { productId: true },
    }) ?? []
    const excludedIds = new Set(outcomes.map(row => row.productId))
    const eligible = scoped.filter(product => !excludedIds.has(product.id)
      && (!dto.onlyUnlinked || !linkedIds.has(product.id)))
    if (!eligible.length) return { sourceKey, eligible: 0, queued: 0, job: null, hasSmartphones: false }
    const selected = eligible.slice(0, limit)
    const hasSmartphones = selected.some(product => identity(product).kind === 'smartphone'
      || /(?:смартфон|smartphone)/i.test(product.category.name))
    const job = await this.prisma.monitorJob.create({
      data: {
        kind: 'MATCH_1C', sourceKey, url: path || null, maxPages: 1, perPage: selected.length,
        pendingUrls: selected.map(product => 'product:' + product.id),
        visitedUrls: [...(dto.onlyInStockSmartphones ? ['STOCKED_SMARTPHONES'] : [])],
      },
    })
    return { sourceKey, eligible: eligible.length, queued: selected.length, job, hasSmartphones }
  }
  async autoFindOneCSection(dto: AutoFindOneCSectionDto) {
    if (await this.prisma.monitorJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } })) {
      throw new ConflictException('Мониторинг уже выполняет задачу. Дождись завершения или останови её.')
    }
    const path = (dto.categoryPath || '').trim()
    const limit = Math.min(5000, dto.maxItems || 30)
    const requestedSource = (dto.sourceKey || '05ru') as StoreKey | 'all'
    if (requestedSource !== 'all') requireEnabledStore(requestedSource)
    const sourceKeys: StoreKey[] = [...ENABLED_STORE_KEYS]
    for (const sourceKey of sourceKeys) {
      if (sourceKey === '05ru') continue
      const settings = await this.settings(sourceKey)
      const definition = STORE_DEFINITIONS.find(item => item.key === sourceKey)!
      if (!settings.region?.trim()) {
        throw new BadRequestException('Перед поиском укажи город для магазина ' + definition.name)
      }
    }
    const results = []
    for (const sourceKey of sourceKeys) {
      results.push(await this.queueAutoFindForSource(dto, sourceKey, path, limit))
    }
    const queued = results.reduce((sum, result) => sum + result.queued, 0)
    const eligible = results.reduce((sum, result) => sum + result.eligible, 0)
    if (!queued) throw new BadRequestException('Нет непривязанных товаров для выбранных источников. Проверь импорт 1С и существующие связи.')
    const fiveRuBatch = results.find(result => result.sourceKey === '05ru')
    // Index creation is worthwhile only for large 1C imports.
    if (dto.indexCatalog === true && fiveRuBatch?.hasSmartphones
      && fiveRuBatch.queued > FAST_MATCH_MAX_ITEMS) {
      await this.ensureIndexJob()
    }
    if (sourceKeys.length === 1) {
      const single = results[0]
      if (!single.job) throw new BadRequestException('Для выбранного магазина нет товаров для сопоставления')
      return { ...single.job, sourceKey: single.sourceKey, eligible: single.eligible, queued: single.queued }
    }
    return { sourceKey: 'all', eligible, queued, jobs: results.filter(result => result.job).map(result => result.job),
      sources: results.map(result => ({ sourceKey: result.sourceKey, eligible: result.eligible, queued: result.queued, job: result.job })) }
  }

  private async ensureIndexJob() {
    const lastJob = await this.prisma.monitorJob.findFirst({
      where: { kind: 'INDEX_05RU_SMARTPHONES' }, orderBy: { createdAt: 'desc' },
    })
    if (lastJob?.status === 'COMPLETED' && lastJob.processed > 0 && lastJob.finishedAt
      && Date.now() - lastJob.finishedAt.getTime() < 7 * 86400_000 && !lastJob.lastError) return null
    return this.prisma.monitorJob.create({
      data: {
        kind: 'INDEX_05RU_SMARTPHONES', sourceKey: '05ru',
        url: 'https://05.ru/cat/mc/396f7486/smartfony/',
        page: 0, maxPages: 50, perPage: 24, processed: 0, visitedUrls: [],
      },
    })
  }

  async checkAll(dto?: CheckAllDto) {
    if (await this.prisma.monitorJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } })) {
      throw new ConflictException('Мониторинг уже запущен. Дождись завершения или останови текущую задачу.')
    }
    const requestedSource = (dto?.sourceKey || '05ru') as StoreKey | 'all'
    if (requestedSource !== 'all') requireEnabledStore(requestedSource)
    const sourceKeys: StoreKey[] = [...ENABLED_STORE_KEYS]
    const jobs = []
    const sources = []
    const batches: Array<{ sourceKey: StoreKey; links: Array<{ externalUrl: string }> }> = []
    for (const sourceKey of sourceKeys) {
      const links = await this.prisma.competitorProduct.findMany({
        where: {
          source: { key: sourceKey }, matchStatus: 'CONFIRMED',
          product: { is: { oneCId: { not: null }, status: ProductStatus.ACTIVE, ...(dto?.authorizedOnly ? { priceSyncEnabled: true } : {}) } },
        },
        select: { externalUrl: true }, orderBy: { externalUrl: 'asc' },
      })
      if (links.length && sourceKey !== '05ru') {
        const settings = await this.settings(sourceKey)
        const definition = STORE_DEFINITIONS.find(item => item.key === sourceKey)!
        if (!settings.region?.trim()) {
          throw new BadRequestException('Перед обновлением цен укажи город для магазина ' + definition.name)
        }
      }
      batches.push({ sourceKey, links })
      sources.push({ sourceKey, queued: links.length })
    }
    for (const batch of batches) {
      if (batch.links.length) jobs.push(await this.prisma.monitorJob.create({
        data: { kind: 'RECHECK', sourceKey: batch.sourceKey, perPage: batch.links.length, pendingUrls: batch.links.map(row => row.externalUrl) },
      }))
    }
    const queued = sources.reduce((sum, item) => sum + item.queued, 0)
    if (!queued) throw new BadRequestException('Нет подтверждённых ссылок. Сначала выполни первоначальный поиск и привязку.')
    if (sourceKeys.length === 1) return { ...jobs[0], sourceKey: sourceKeys[0], queued }
    return { queued, jobs, sources }
  }

  // Price refresh reads only saved links for the selected store. Discovery is
  // never invoked from this path.
  private async recheckBatch(jobId: string, pending: string[], sourceKey: StoreKey = '05ru', previousError: string | null = null) {
    const batch = pending.slice(0, 4)
    const parser = this.parserFor(sourceKey)
    const settings = sourceKey === '05ru' ? null : await this.settings(sourceKey)
    if (sourceKey !== '05ru' && !settings?.region?.trim()) {
      throw new Error('Для обновления цен ' + this.nameForSource(sourceKey) + ' не указан город')
    }
    const results = await Promise.allSettled(batch.map(url => parser.parse(url, settings?.region)))
    const source = await this.source(sourceKey)
    const deferred: string[] = []
    const problems: string[] = []
    let processed = 0
    let errors = 0
    let blocked = false
    for (const [index, item] of results.entries()) {
      const url = batch[index]
      try {
        if (item.status === 'rejected') throw item.reason
        // A user may have removed a link while the pages were loading.
        const linked = await this.prisma.competitorProduct.findUnique({
          where: { externalUrl: url },
          select: { id: true, productId: true, matchStatus: true, product: true },
        })
        if (linked?.productId && linked.matchStatus === 'CONFIRMED') {
          const verified = linked.product && compareItems(linked.product, {
            name: item.value.name, brand: item.value.brand, attributes: item.value.attributes,
            category: item.value.categoryName,
          })
          // Stop a legacy incorrect laptop link, even when the old card name
          // and its old fingerprint have not changed since confirmation.
          const diskMismatch = verified && verified.ours.kind === 'laptop'
            && (!verified.ours.storage || !verified.theirs.storage
              || verified.ours.storage !== verified.theirs.storage
              || verified.conflicts.some(reason => reason.includes('память: название противоречит')))
          const simMismatch = verified && verified.ours.kind === 'smartphone'
            && verified.ours.sim && verified.theirs.sim
            && verified.ours.sim !== verified.theirs.sim
          if (diskMismatch || simMismatch) {
            await this.prisma.monitorDelivery.updateMany({
              where: { linkId: linked.id, status: 'PENDING' },
              data: { status: 'CANCELLED', lastError: simMismatch ? 'Несовпадение SIM' : 'Несовпадение объёма SSD' },
            })
            await this.prisma.competitorProduct.update({
              where: { id: linked.id },
              data: { matchStatus: 'REVIEW_REQUIRED', confirmedAt: null,
                confirmedFingerprint: null, confirmedProductFingerprint: null },
            })
            await this.save(item.value, source.id)
            problems.push(url + (simMismatch ? ': конфигурация SIM отличается от 1С, подтверждение снято' : ': объем SSD отличается от 1С, подтверждение снято'))
          } else {
            await this.save(item.value, source.id)
          }
        }
        processed++
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
        if (/HTTP\s+(?:401|403|429)\b|проверку доступа/i.test(message)) {
          blocked = true
          deferred.push(url)
          problems.push(url + ': сайт ограничил запросы, задача остановлена')
          continue
        }
        await this.prisma.competitorProduct.updateMany({
          where: { externalUrl: url },
          data: { lastCheckedAt: new Date(), lastError: message },
        })
        errors++
        processed++
        if (problems.length < 5) problems.push(url + ': ' + message.slice(0, 200))
      }
    }
    const remaining = [...deferred, ...pending.slice(batch.length)]
    const done = !blocked && remaining.length === 0
    await this.prisma.monitorJob.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: {
        pendingUrls: remaining, processed: { increment: processed }, errors: { increment: errors },
        lastError: [previousError, ...problems].filter(Boolean).join('\n').slice(-7000) || null,
        status: blocked ? 'FAILED' : done ? 'COMPLETED' : 'QUEUED',
        leaseUntil: null, finishedAt: blocked || done ? new Date() : null,
      },
    })
  }
  async cancelJob(id: string) { return this.prisma.monitorJob.updateMany({ where: { id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED', finishedAt: new Date() } }) }
  async retryJob(id: string) {
    const job = await this.prisma.monitorJob.findUnique({ where: { id } })
    if (job?.sourceKey) requireEnabledStore(job.sourceKey as StoreKey)
    if (job?.kind === 'PRICE_UPDATE') throw new BadRequestException('Для повторной проверки используй кнопку «Обновить цены»')
    if (!job || !['FAILED', 'CANCELLED'].includes(job.status)) throw new BadRequestException('Можно продолжить остановленную задачу')
    return this.prisma.monitorJob.update({ where: { id }, data: { status: 'QUEUED', leaseUntil: null, finishedAt: null, lastError: null } })
  }
  private strings(value: unknown) { return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [] }
  private async tick() {
    if (this.stopped || this.working || this.parsing) return
    this.working = true
    let handledJob = false
    try {
      await this.priceUpdate.advance()
      const now = new Date()
      await this.prisma.monitorJob.updateMany({
        where: { sourceKey: { in: ['dns', 'mvideo'] }, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'CANCELLED', leaseUntil: null, finishedAt: now },
      })
      await this.prisma.monitorJob.updateMany({
        where: { status: 'RUNNING', leaseUntil: { lt: now }, OR: [{ sourceKey: '05ru' }, { sourceKey: null }] },
        data: { status: 'QUEUED' },
      })
      const dueSettings = await this.prisma.monitorSettings.findMany({
        where: { id: '05ru', intervalMinutes: { gt: 0 }, nextRunAt: { lte: now } },
      })
      for (const setting of dueSettings) {
        if (!STORE_DEFINITIONS.some(item => item.key === setting.id)) continue
        const sourceKey = setting.id as StoreKey
        const activeForSource = await this.prisma.monitorJob.count({
          where: { sourceKey, status: { in: ['QUEUED', 'RUNNING'] } },
        })
        if (!activeForSource) {
          const source = await this.source(sourceKey)
          const links = await this.prisma.competitorProduct.findMany({
            where: {
              sourceId: source.id, matchStatus: 'CONFIRMED',
              product: { is: { oneCId: { not: null }, status: ProductStatus.ACTIVE } },
            },
            select: { externalUrl: true }, orderBy: { externalUrl: 'asc' },
          })
          if (links.length) await this.prisma.monitorJob.create({
            data: { kind: 'RECHECK', sourceKey, perPage: links.length, pendingUrls: links.map(link => link.externalUrl) },
          })
        }
        await this.prisma.monitorSettings.update({
          where: { id: setting.id },
          data: { nextRunAt: setting.intervalMinutes === 1440 ? nextDailyPriceCheck(now) : new Date(Date.now() + setting.intervalMinutes * 60000) },
        })
      }
      // Older releases queued a 50-page scan even for 1-13 products. Cancel
      // ONLY a zero-progress index when a small match batch is queued.
      const smallBatch = await this.prisma.monitorJob.findFirst({
        where: { kind: 'MATCH_1C', sourceKey: '05ru', status: 'QUEUED',
          perPage: { lte: FAST_MATCH_MAX_ITEMS } },
        select: { id: true },
      })
      if (smallBatch) {
        await this.prisma.monitorJob.updateMany({
          where: { kind: 'INDEX_05RU_SMARTPHONES', sourceKey: '05ru',
            status: { in: ['QUEUED', 'RUNNING'] }, page: 0 },
          data: { status: 'CANCELLED', leaseUntil: null, finishedAt: now,
            lastError: 'Полный обход пропущен: малая партия 1С обрабатывается быстрым поиском.' },
        })
      }
      // The persistent index remains useful for large 1C imports.
      const indexJob = await this.prisma.monitorJob.findFirst({
        where: { status: 'QUEUED', kind: { in: ['INDEX_05RU_SMARTPHONES', 'INDEX_05RU'] } },
        orderBy: { createdAt: 'asc' },
      })
      const matchJob = await this.prisma.monitorJob.findFirst({
        where: { status: 'QUEUED', kind: 'MATCH_1C', OR: [{ sourceKey: '05ru' }, { sourceKey: null }] }, orderBy: { createdAt: 'asc' },
      })
      const job = indexJob ?? matchJob ?? await this.prisma.monitorJob.findFirst({
        where: { status: 'QUEUED', OR: [{ sourceKey: '05ru' }, { sourceKey: null }] }, orderBy: { createdAt: 'asc' },
      })
      if (!job) return
      const claimed = await this.prisma.monitorJob.updateMany({ where: { id: job.id, status: 'QUEUED' }, data: { status: 'RUNNING', leaseUntil: new Date(Date.now() + 180000) } })
      if (!claimed.count) return
      handledJob = true
      let pending = this.strings(job.pendingUrls)
      try {
        if (job.kind === 'RECHECK') {
          if (!pending.length) {
            await this.prisma.monitorJob.updateMany({
              where: { id: job.id, status: 'RUNNING' },
              data: { status: 'COMPLETED', leaseUntil: null, finishedAt: new Date() },
            })
          } else {
            await this.recheckBatch(job.id, pending, (job.sourceKey || '05ru') as StoreKey, job.lastError)
          }
          return
        }
        if (job.kind === 'INDEX_05RU_SMARTPHONES' || job.kind === 'INDEX_05RU') {
          // Progress is persisted every page. A restart resumes from job.page.
          const pageNumber = job.page + 1
          this.parsing = true
          let links: Array<{ url: string; title: string }>
          try {
            links = job.kind === 'INDEX_05RU_SMARTPHONES'
              ? await this.fiveRu.indexSmartphoneCatalogPage(pageNumber)
              : await this.fiveRu.indexCatalogPage(pageNumber)
          } finally { this.parsing = false }
          const visited = this.strings(job.visitedUrls)
          if (!links.length) {
            // A transient empty render must not silently truncate the catalog.
            // Retry the same page once; only a repeated empty response ends the crawl.
            const retryMarker = 'EMPTY_PAGE_RETRY:' + pageNumber
            if (!visited.includes(retryMarker)) {
              await this.prisma.monitorJob.update({
                where: { id: job.id },
                data: { visitedUrls: [...visited, retryMarker], status: 'QUEUED', leaseUntil: null },
              })
              return
            }
            if (pageNumber === 1) {
              throw new Error('05.ru: первая страница каталога дважды не отдала товары. Индексация невозможна.')
            }
          }
          const signature = createHash('sha256').update(
            links.map(link => link.url).sort().join('\n')
          ).digest('hex')
          if (links.length && visited.includes(signature)) {
            throw new Error('05.ru: страница ' + pageNumber + ' повторяет предыдущую выдачу. ' +
              'Пагинация не подтвердилась, индекс неполный; сопоставление отменено.')
          }
          const scannedAt = new Date()
          for (const link of links) {
            const title = link.title.trim() || decodeURIComponent(new URL(link.url).pathname.split('/p/')[1] || '').replace(/-\d+\/?$/, '').replace(/-/g, ' ')
            const data = identity({ name: title })
            await this.prisma.competitorCatalogEntry.upsert({
              where: { externalUrl: link.url },
              create: { externalUrl: link.url, title, model: data.model || null,
                storage: data.storage || null, color: data.color || null, lastSeenAt: scannedAt },
              update: { title, model: data.model || null, storage: data.storage || null,
                color: data.color || null, lastSeenAt: scannedAt },
            })
          }
          if (pageNumber >= job.maxPages && links.length) {
            throw new Error(job.kind === 'INDEX_05RU_SMARTPHONES'
              ? 'Достигнут защитный лимит страниц каталога смартфонов; полный индекс не подтверждён.'
              : 'Достигнут защитный лимит страниц; полный индекс 05.ru не подтверждён.')
          }
          const finished = !links.length
          if (finished) this.indexedCatalogStatus = undefined
          await this.prisma.monitorJob.update({
            where: { id: job.id }, data: {
              page: pageNumber, processed: { increment: links.length },
              visitedUrls: [...visited, signature],
              status: finished ? 'COMPLETED' : 'QUEUED', leaseUntil: null,
              finishedAt: finished ? new Date() : null,
              lastError: null,
            },
          })
          return
        }
        if (!pending.length && job.kind === 'CATALOG' && job.url && job.page < job.maxPages) {
          this.parsing = true
          let discovered: Awaited<ReturnType<FiveRuParser['discover']>>
          try { discovered = await this.fiveRu.discover(job.url, job.perPage) } finally { this.parsing = false }
          const visited = this.strings(job.visitedUrls)
          pending = discovered.urls.filter(url => !visited.includes(url))
          await this.prisma.monitorJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { pendingUrls: pending, visitedUrls: [...visited, ...pending], page: { increment: 1 }, url: discovered.next, lastError: discovered.truncated ? `На странице ${discovered.discovered} карточек: лимит ${job.perPage}. Продолжение раздела остановлено, уменьшите раздел.` : null } })
        } else if (pending.length) {
          try {
            if (job.kind === 'MATCH_1C') {
              const foundId = /^product:(\d+)$/.exec(pending[0])
              const product = foundId
                ? await this.prisma.product.findUnique({ where: { id: Number(foundId[1]) }, include: { category: true } })
                : null
              if (!product?.oneCId || product.status !== 'ACTIVE' || product.price <= 0
                || (job.url && product.category.name !== job.url && !product.category.name.startsWith(job.url + ' / '))
                || (this.strings(job.visitedUrls).includes('STOCKED_SMARTPHONES')
                  && (product.stockQty <= product.reservedQty || !/(?:смартфон|smartphone)/i.test(product.category.name)))) {
                throw new Error('Товар исключён из выбранного раздела или больше не продаётся')
              }
              const sourceKey = (job.sourceKey || '05ru') as StoreKey
              const parser = this.parserFor(sourceKey)
              const source = await this.source(sourceKey)
              const settings = await this.settings(sourceKey)
              const markers = this.strings(job.visitedUrls)
              const workflow = markers.some(marker => marker.startsWith('PRICE_UPDATE:'))
              const repairPrefix = 'REPAIR_LINK:' + product.id + ':'
              let repairLinks = workflow ? markers.filter(marker => marker.startsWith(repairPrefix)).map(marker => marker.slice(repairPrefix.length)) : []
              let knownRefreshed = false
              try { knownRefreshed = await this.refreshKnownMatch(product, sourceKey, parser, settings.region) }
              catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                if (!workflow || !message.includes('сохранённая карточка изменилась, совпадение требует проверки:')) throw error
                const demoted = await this.prisma.competitorProduct.findMany({ where: {
                  productId: product.id, sourceId: source.id, matchStatus: 'REVIEW_REQUIRED',
                  lastSuccessAt: { gte: job.createdAt },
                } })
                repairLinks = demoted.filter(link => compareItems(product, {
                  name: link.externalName || '', attributes: link.attributes,
                }).conflicts.length).map(link => link.id)
                if (!repairLinks.length) throw error // missing/uncertain variants still require review
                await this.prisma.monitorJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: {
                  visitedUrls: [...markers, ...repairLinks.map(id => repairPrefix + id)],
                } })
              }
              if (!knownRefreshed) {
              if (sourceKey === '05ru' && await this.refreshIndexedMatch(product, repairLinks)) {
                // Indexed candidates are always re-opened for an actual price check.
                const indexedLink = await this.prisma.competitorProduct.findFirst({
                  where: { productId: product.id, source: { key: sourceKey },
                    matchStatus: { in: ['CONFIRMED', 'SUGGESTED', 'REVIEW_REQUIRED'] } },
                  select: { matchStatus: true },
                })
                if (indexedLink) await this.recordMatchOutcome(product.id, sourceKey,
                  indexedLink.matchStatus === 'CONFIRMED' ? 'CONFIRMED' : 'REVIEW')
              } else {
              const rankedByUrl = new Map<string, { result: FiveRuResult; check: ReturnType<typeof compareItems> }>()
              const reviewByUrl = new Map<string, { result: FiveRuResult; score: number }>()
              const traces: FiveRuSearchTrace[] = []
              const rejected: string[] = []
              const requestedKind = identity(product).kind
              // A small batch must not trigger a hidden 50-page crawl within
              // EACH query. Use saved index hints and direct search immediately.
              const indexedCatalogReady = requestedKind === 'smartphone'
                && sourceKey === '05ru'
                && ((job.perPage || 0) <= FAST_MATCH_MAX_ITEMS
                  || await this.hasCompletedSmartphoneIndex())
              let cleanSearches = 0
              const exactSeenAcrossQueries = new Map<string, number>()
              for (const query of oneCSearchQueries(product)) {
                const trace: FiveRuSearchTrace = { query, linksFound: 0, rankedLinks: 0, cardsParsed: 0, rejectedCards: [] }
                traces.push(trace)
                let results: FiveRuResult[]
                try {
                  results = sourceKey === '05ru'
                    ? await this.fiveRu.searchProducts(query, 18, trace, settings.region, indexedCatalogReady)
                    : await parser.searchProducts(query, 18, trace, settings.region)
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error)
                  if (/HTTP\s+(?:401|403|429)\b|проверку доступа/i.test(message)) throw error
                  trace.rejectedCards.push(message)
                  continue
                }
                const checked = results.map(result => ({
                  result, check: compareItems(product, { name: result.name, brand: result.brand, attributes: result.attributes, category: result.categoryName }),
                }))
                // Count an URL once per independently completed query. Two clean
                // overlapping results allow a fast exit; partial/error results do not.
                if (results.length && !trace.rejectedCards.length) {
                  cleanSearches++
                  for (const row of checked) {
                    if (this.matching.strongVariant(row.check) && row.check.canAutoConfirm) {
                      exactSeenAcrossQueries.set(row.result.url, (exactSeenAcrossQueries.get(row.result.url) || 0) + 1)
                    }
                  }
                }
                for (const row of checked) {
                  if (this.matching.strongVariant(row.check)) {
                    const previous = rankedByUrl.get(row.result.url)
                    if (!previous || row.check.score > previous.check.score) rankedByUrl.set(row.result.url, row)
                  } else {
                    // Less complete non-phone matches are suggestions only.
                    const review = reviewCandidate(product, {
                      name: row.result.name, brand: row.result.brand,
                      attributes: row.result.attributes, category: row.result.categoryName,
                    })
                    if (review && (!reviewByUrl.has(row.result.url)
                      || review.score > reviewByUrl.get(row.result.url)!.score)) {
                      reviewByUrl.set(row.result.url, { result: row.result, score: review.score })
                    }
                  }
                }
                // A fully variant-filtered smartphone result is already precise.
                // Accessories keep searching all query variants to improve recall.
                if (rankedByUrl.size) {
                  const exact = [...rankedByUrl.values()].filter(row => row.check.canAutoConfirm)
                  // Two different successful queries returning the SAME complete
                  // exact URL without a competing candidate are enough to stop.
                  // A missing/ambiguous/partial match still exhausts fallbacks.
                  if (requestedKind === 'smartphone' && cleanSearches >= 2
                    && exact.length === 1
                    && (exactSeenAcrossQueries.get(exact[0].result.url) || 0) >= 2) break
                  if (requestedKind !== 'smartphone' && exact.length === 1) break
                }
                for (const row of checked.slice(0, 3)) {
                  const reason = row.check.conflicts.length ? row.check.conflicts.join(', ')
                    : !row.check.theirs.model ? 'модель не распознана'
                    : row.check.ours.model !== row.check.theirs.model ? 'другая модель'
                    : row.check.ours.storage !== row.check.theirs.storage ? 'другая или неизвестная память'
                    : row.check.ours.color !== row.check.theirs.color ? 'другой или неизвестный цвет'
                    : 'недостаточная уверенность (' + row.check.score + ')'
                  if (rejected.length < 5) rejected.push(row.result.name + ': ' + reason)
                }
              }
              const ranked = rankVerifiedMatches([...rankedByUrl.values()])
              const review = [...reviewByUrl.values()]
                .filter(option => !rankedByUrl.has(option.result.url))
                .sort((a, b) => b.score - a.score)
              if (!ranked.length && review.length) {
                let offered = 0
                for (const option of review.slice(0, 3)) {
                  const claimed = await this.prisma.competitorProduct.findUnique({
                    where: { externalUrl: option.result.url },
                  })
                  if (claimed?.productId && claimed.productId !== product.id) continue
                  // First candidate is visible on this product's card.
                  await this.save(option.result, source.id, offered === 0 ? product.id : undefined, true)
                  offered++
                }
                if (offered) {
                  await this.recordMatchOutcome(product.id, sourceKey, 'REVIEW',
                    'Найдены похожие карточки, необходимо подтверждение')
                  throw new Error('' + source.name + ': найдены варианты для ручной проверки для ' + product.name +
                    '. Автоматическая привязка запрещена: проверь модель и характеристики.')
                }
              }
              if (!ranked.length) {
                // Only complete discovery without unread candidates is a negative.
                // Network faults and empty pages always remain retryable.
                const existingReview = await this.prisma.competitorProduct.findFirst({
                  where: { productId: product.id, source: { key: sourceKey },
                    matchStatus: { in: ['CONFIRMED', 'SUGGESTED', 'REVIEW_REQUIRED'] } },
                  select: { matchStatus: true },
                })
                const safeNegative = !existingReview && canDeclareNoMatch(traces as SearchEvidence[])
                await this.recordMatchOutcome(product.id, sourceKey,
                  existingReview ? 'REVIEW' : safeNegative ? 'NO_MATCH' : 'RETRYABLE',
                  existingReview ? 'Есть кандидаты для ручной проверки.'
                    : safeNegative ? 'Поиск выполнен, подходящих карточек не обнаружено. Повтор только вручную.'
                    : 'Проверка неполная или ошибка сайта. Автоматический повтор разрешён.')
                const summary = traces.map(trace =>
                  '"' + trace.query + '": ' + trace.linksFound + ' ссылок, ' + (trace.rankedLinks ?? 0) + ' кандидатов, ' + trace.cardsParsed + ' карточек прочитано' +
                    (trace.cached ? ' (кеш)' : '') +
                    (trace.searchPages ? ' · страниц поиска: ' + trace.searchPages : '') +
                    (trace.pageUrl ? ' · страница ' + new URL(trace.pageUrl).pathname : '') +
                    (trace.directLinksFound !== undefined ? ' · прямой поиск: ' + trace.directLinksFound +
                      ', каталог смартфонов: ' + (trace.catalogLinksFound ?? 0) : '') +
                    (trace.rankingMode ? ' · подбор: ' + trace.rankingMode : '') +
                    (trace.searchMode ? ' · режим ' + trace.searchMode : '')
                ).join('; ')
                const parsingErrors = traces.flatMap(trace => trace.rejectedCards).slice(0, 2)
                const noModelCandidates = traces.some(trace => trace.linksFound > 0)
                  && traces.every(trace => (trace.rankedLinks ?? 0) === 0)
                const noProductLinks = traces.every(trace => trace.linksFound === 0)
                const reason = rejected.length ? 'Отсеяны: ' + rejected.join('; ')
                  : parsingErrors.length ? 'Ошибки чтения: ' + parsingErrors.join('; ')
                  : noModelCandidates
                    ? 'Поиск отработал, но карточек с этой моделью не найдено в «' + source.name + '». Возможно, предложения сейчас нет в каталоге; можно повторить позже.'
                    : noProductLinks
                      ? source.name + ' не отдал ссылки на товары. Поиск не подтвердил отсутствие товара: проверь доступность выдачи и повтори позже.'
                      : 'Не удалось получить пригодные карточки. Повтори поиск позже.'
                throw new Error('' + source.name + ': нет подтверждённого совпадения для ' + product.name +
                  '. Поиск: ' + summary + '. ' + reason)
              }
              const hasClearWinner = hasDecisiveWinner(ranked)

              // If the alternatives are genuinely close and cannot be separated
              // by the known 1C identity or the SIM fallback above, keep review.
              if (ranked.length > 1 && !hasClearWinner) {
                let offered = 0
                for (const option of ranked.slice(0, 3)) {
                  const claimed = await this.prisma.competitorProduct.findUnique({
                    where: { externalUrl: option.result.url },
                  })
                  if (claimed?.productId && claimed.productId !== product.id) continue
                  await this.save(option.result, source.id, offered === 0 ? product.id : undefined, true)
                  offered++
                }
                await this.recordMatchOutcome(product.id, sourceKey, 'REVIEW',
                  'Найдено несколько близких карточек, необходимо подтверждение')
                throw new Error('' + source.name + ': несколько близких совпадений для ' + product.name + '; проверь вручную')
              }
              const already = await this.prisma.competitorProduct.findUnique({ where: { externalUrl: ranked[0].result.url } })
              if (already?.productId && already.productId !== product.id) {
                throw new Error('Карточка в ' + source.name + ' уже связана с другим товаром: ' + product.name)
              }
              // Auto-confirm only one unique candidate whose full identity
              // is complete. This includes exact laptop hardware/SKU matches;
              // missing optional fields are allowed, explicit conflicts are not.
              const autoConfirmExact = hasClearWinner && ranked[0].check.canAutoConfirm
              const saved = await this.save(ranked[0].result, source.id, product.id, false, autoConfirmExact, repairLinks)
              await this.recordMatchOutcome(product.id, sourceKey,
                saved.matchStatus === 'CONFIRMED' ? 'CONFIRMED' : 'REVIEW')
              }
              }
            } else {
              await this.check({ url: pending[0] })
            }
          }
          catch (error) {
            const message = error instanceof Error ? error.message : 'Ошибка карточки'
            // Explicit access-denial/rate-limit responses pause the job.
            // A browser/network timeout is a per-product failure, not an access-denial:
            // record it and continue the remaining 1C products instead of aborting at 0/10.
            if (/HTTP\s+(?:401|403|429)\b|проверку доступа/i.test(message)) throw error
            const diagnostic = job.kind === 'MATCH_1C'
              ? [job.lastError, message].filter(Boolean).join('\n').slice(-7000)
              : message
            // No safe match or several candidates means review, not a parser crash.
            // The red counter is reserved for actual technical failures.
            const expectedReview = isExpectedReviewOutcome(message)
            await this.prisma.monitorJob.updateMany({
              where: { id: job.id, status: 'RUNNING' },
              data: { ...(expectedReview ? {} : { errors: { increment: 1 } }), lastError: diagnostic },
            })
          }
          await this.prisma.monitorJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { pendingUrls: pending.slice(1), processed: { increment: 1 } } })
        }
        const latest = await this.prisma.monitorJob.findUnique({ where: { id: job.id } })
        if (latest?.status !== 'RUNNING') return
        const done = !this.strings(latest.pendingUrls).length && (latest.kind !== 'CATALOG' || !latest.url || latest.page >= latest.maxPages)
        await this.prisma.monitorJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: done ? 'COMPLETED' : 'QUEUED', leaseUntil: null, finishedAt: done ? new Date() : null } })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Ошибка задачи'
        await this.prisma.monitorJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: 'FAILED', leaseUntil: null, finishedAt: new Date(), lastError: message } })
        // A failed optional index is not a failed product search. MATCH_1C
        // uses the live 05.ru search whenever no usable index entry exists.
      }
    } finally {
      this.working = false
      // Keep processing an active queue without the one-second idle poll.
      // Runs sequentially: working guard still prevents overlapping ticks.
      if (handledJob && this.timer && !this.stopped && !this.followUpTimer) {
        this.followUpTimer = setTimeout(() => {
          this.followUpTimer = undefined
          void this.tick().catch(error => console.error('Мониторинг:', error instanceof Error ? error.message : 'Ошибка'))
        }, 100)
        this.followUpTimer.unref()
      }
    }
  }

  // Legacy catalog import now collects competitor observations without creating shop inventory.
  async importFiveRuCatalog(dto: ImportFiveRuCatalogDto) {
    if (this.working || this.parsing) throw new ConflictException('Парсер занят')
    this.parsing = true
    try {
      const source = await this.source()
      const scan = await this.fiveRu.discover(dto.url, dto.limit || 12)
      let created = 0, updated = 0, errors = 0
      const categories = new Set<string>()
      for (const url of scan.urls) {
        try {
          const result = await this.fiveRu.parse(url)
          categories.add(result.categoryName || scan.title)
          const existing = await this.prisma.competitorProduct.findUnique({ where: { externalUrl: result.url } })
          await this.save(result, source.id)
          existing ? updated++ : created++
        } catch { errors++ }
      }
      return { ok: true, sourceCategoryName: scan.title, discoveredLinks: scan.discovered, imported: created+updated, created, updated, categories: [...categories], errors }
    } finally { this.parsing = false }
  }
  async clearFiveRuTestImport() {
    const products = await this.prisma.product.findMany({
      where: { sku: { startsWith: '05RU-' } },
      select: { id: true, _count: { select: { orderItems: true } } },
    })
    let deleted = 0
    let archived = 0

    for (const product of products) {
      if (product._count.orderItems > 0) {
        await this.prisma.product.update({ where: { id: product.id }, data: { status: ProductStatus.ARCHIVED } })
        archived += 1
      } else {
        await this.prisma.product.delete({ where: { id: product.id } })
        deleted += 1
      }
    }

    const testCategories = await this.prisma.category.findMany({ where: { name: { startsWith: 'ТЕСТ 05.ru · ' } }, select: { id: true } })
    let categoriesDeleted = 0
    for (const category of testCategories) {
      const remaining = await this.prisma.product.count({ where: { categoryId: category.id } })
      if (remaining === 0) {
        await this.prisma.category.delete({ where: { id: category.id } })
        categoriesDeleted += 1
      }
    }

    return { ok: true, deleted, archived, categoriesDeleted }
  }

  private async ensureTestCategory(rawName: string) {
    const clean = rawName.trim() || 'Товары'
    const name = `ТЕСТ 05.ru · ${clean}`
    const existing = await this.prisma.category.findFirst({ where: { name } })
    if (existing) return this.prisma.category.update({ where: { id: existing.id }, data: { isActive: true } })
    return this.prisma.category.create({
      data: {
        name,
        slug: `test-05ru-${this.key(clean)}`,
        sortOrder: 900,
        isActive: true,
      },
    })
  }

  private testSku(result: FiveRuResult) {
    const external = (result.externalSku || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50)
    return `05RU-${external || this.key(result.url)}`.toUpperCase()
  }

  private key(value: string) {
    let hash = 2166136261
    const normalized = value.trim().toLocaleLowerCase('ru-RU')
    for (let index = 0; index < normalized.length; index += 1) {
      hash ^= normalized.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(36)
  }
}
