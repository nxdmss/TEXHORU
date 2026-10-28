import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ProductStatus, StockState } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { ApplyRecommendedPriceDto, AutoFindOneCSectionDto, CheckCompetitorPriceDto, ImportFiveRuCatalogDto, ImportManualCompetitorPricesDto, MonitorSettingsDto, ScanFiveRuDto } from './price-monitor.dto'
import { FiveRuParser, fiveRuUrl, type FiveRuResult, type FiveRuSearchTrace } from './five-ru.parser'
import { compareItems, fingerprint, identity, recommendation } from './product-matching'
import { jsonValue, MonitorExchangeService } from './monitor-exchange.service'
import { OneCPriceSyncService } from '../integrations/price-sync.service'

// Storefront search often fails on 1C-only labels such as "(EAC)" and the
// 1C memory format "12/512". Start with model + capacity, then the model alone.
// All returned product cards still undergo strict variant comparison.
export function oneCSearchQueries(product: { name: string; brand?: string | null }) {
  const parsed = identity(product)
  if (!parsed.model) return [product.name.replace(/\s*\(EAC\)/gi, '').trim()]
  const model = parsed.brand === 'samsung' && !parsed.model.startsWith('samsung ')
    ? 'samsung ' + parsed.model : parsed.model
  // Storefront search must not receive internal 1C notes, slashes or EAC tags.
  return [...new Set([model + (parsed.storage ? ' ' + parsed.storage : ''), model])]
}

@Injectable()
export class PriceMonitorService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout
  private working = false
  private parsing = false
  constructor(private readonly prisma: PrismaService, private readonly fiveRu: FiveRuParser, private readonly exchange: MonitorExchangeService) {}

  onModuleInit() {
    if (process.env.MONITOR_WORKER_DISABLED === 'true') return
    this.timer = setInterval(() => { void this.tick().catch(error => console.error('Мониторинг:', error instanceof Error ? error.message : 'Ошибка')) }, 1000)
    this.timer.unref()
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer) }
  private source() {
    return this.prisma.competitorSource.upsert({ where: { key: '05ru' }, update: {}, create: { key: '05ru', name: '05.ru', baseUrl: 'https://05.ru' } })
  }
  private decorated<T extends { latestPrice?: number | null; inStock?: boolean | null; lastError?: string | null; lastSuccessAt?: Date | null; product?: { name: string; price: number; costPrice?: number | null } | null; matchStatus: string; confirmedFingerprint?: string | null; confirmedProductFingerprint?: string | null; externalName?: string | null; attributes: unknown }>(row: T) {
    const valid = row.matchStatus === 'CONFIRMED' && row.product && fingerprint(row.product) === row.confirmedProductFingerprint && fingerprint({ name: row.externalName || '', attributes: row.attributes }) === row.confirmedFingerprint
    return { ...row, matchStatus: row.matchStatus === 'CONFIRMED' && !valid ? 'REVIEW_REQUIRED' : row.matchStatus, ...recommendation(row, valid ? row.product : null) }
  }
  async list() {
    const rows = await this.prisma.competitorProduct.findMany({ include: { source: true, product: { include: { category: true } } }, orderBy: [{ lastCheckedAt: 'desc' }, { createdAt: 'desc' }] })
    return rows.map(row => this.decorated(row))
  }
  async candidates(id: string) {
    const link = await this.prisma.competitorProduct.findUnique({ where: { id } })
    if (!link) throw new NotFoundException('Карточка не найдена')
    const products = await this.prisma.product.findMany({ where: { status: 'ACTIVE' } })
    return products.map(product => ({ product: { id: product.id, oneCId: product.oneCId, name: product.name, sku: product.sku }, ...compareItems(product, { name: link.externalName || '', attributes: link.attributes }) }))
      .filter(c => c.score >= 20).sort((a,b) => b.score - a.score).slice(0, 5)
  }
  async confirm(id: string, productId: number) {
    const updated = await this.prisma.$transaction(async tx => {
      const link = await tx.competitorProduct.findUnique({ where: { id } })
      const product = await tx.product.findUnique({ where: { id: productId } })
      if (!link || !product || product.status !== 'ACTIVE') throw new NotFoundException('Карточка или активный товар не найдены')
      if (!link.externalName || !link.lastSuccessAt || link.lastError) throw new BadRequestException('Сначала успешно проверь карточку')
      const check = compareItems(product, { name: link.externalName, attributes: link.attributes })
      if (check.conflicts.length) throw new BadRequestException(`Характеристики расходятся: ${check.conflicts.join(', ')}. Исправь данные товара перед подтверждением.`)
      if (link.productId === productId && link.matchStatus === 'CONFIRMED' && link.confirmedFingerprint === fingerprint({ name: link.externalName, attributes: link.attributes }) && link.confirmedProductFingerprint === fingerprint(product)) {
        return tx.competitorProduct.findUniqueOrThrow({ where: { id }, include: { product: true, source: true } })
      }
      // Explicit user confirmation is allowed with missing fields; the UI lists them.
      await tx.monitorDelivery.updateMany({ where: { linkId: id, status: 'PENDING' }, data: { status: 'CANCELLED', lastError: 'Связь подтверждена заново' } })
      // A changed mapping needs a fresh observation, even if the price is unchanged.
      const history = await tx.competitorPriceHistory.create({ data: { competitorProductId: id, price: link.latestPrice!, oldPrice: link.oldPrice, inStock: link.inStock, checkedAt: link.lastSuccessAt } })
      const row = await tx.competitorProduct.update({ where: { id }, data: {
        productId, matchStatus: 'CONFIRMED', confirmedAt: new Date(),
        confirmedFingerprint: fingerprint({ name: link.externalName, attributes: link.attributes }), confirmedProductFingerprint: fingerprint(product),
      }, include: { product: true, source: true } })
      await this.exchange.enqueue(id, tx, history.id)
      await tx.auditLog.create({ data: { action: 'CONFIRM_PRICE_MATCH', entity: 'CompetitorProduct', entityId: id, details: { productId, missing: check.missing } } })
      return row
    })
    return this.decorated(updated)
  }
  async unmatch(id: string) {
    return this.prisma.$transaction(async tx => {
      await tx.monitorDelivery.updateMany({ where: { linkId: id, status: 'PENDING' }, data: { status: 'CANCELLED', lastError: 'Связь снята пользователем' } })
      return tx.competitorProduct.update({ where: { id }, data: { productId: null, matchStatus: 'UNMATCHED', confirmedAt: null, confirmedFingerprint: null, confirmedProductFingerprint: null } })
    })
  }
  async history(id: string) { return this.prisma.competitorPriceHistory.findMany({ where: { competitorProductId: id }, orderBy: { checkedAt: 'desc' }, take: 100 }) }

  async check(dto: CheckCompetitorPriceDto) {
    const url = fiveRuUrl(dto.url, 'product')
    if (this.parsing) throw new ConflictException('Парсер занят. Дождись текущей проверки.')
    if (dto.productId && !await this.prisma.product.findUnique({ where: { id: dto.productId } })) throw new NotFoundException('Товар TEXHORU не найден')
    const source = await this.source()
    this.parsing = true
    try {
      const result = await this.fiveRu.parse(url)
      return await this.save(result, source.id, dto.productId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ошибка проверки'
      await this.prisma.competitorProduct.upsert({ where: { externalUrl: url }, update: { lastCheckedAt: new Date(), lastError: message }, create: { sourceId: source.id, externalUrl: url, lastCheckedAt: new Date(), lastError: message } })
      throw error
    } finally { this.parsing = false }
  }
  private async save(result: FiveRuResult, sourceId: string, suggestedProductId?: number) {
    return this.prisma.$transaction(async tx => {
      const existing = await tx.competitorProduct.findUnique({ where: { externalUrl: result.url }, include: { product: true } })
      let productId = existing?.productId || suggestedProductId || null
      let matchStatus = existing?.matchStatus || 'UNMATCHED'
      let confirmedFingerprint = existing?.confirmedFingerprint || null
      let confirmedProductFingerprint = existing?.confirmedProductFingerprint || null
      const theirs = { name: result.name, attributes: result.attributes }
      if (matchStatus === 'CONFIRMED' && (fingerprint(theirs) !== confirmedFingerprint || !existing?.product || fingerprint(existing.product) !== confirmedProductFingerprint)) matchStatus = 'REVIEW_REQUIRED'
      if (!productId && matchStatus !== 'REVIEW_REQUIRED') {
        const products = await tx.product.findMany({ where: { status: 'ACTIVE' } })
        const candidates = products.map(product => ({ product, check: compareItems(product, theirs) })).filter(c => c.check.score >= 20).sort((a,b) => b.check.score - a.check.score)
        const exact = candidates.filter(c => c.check.canAutoConfirm)
        if (exact.length === 1) {
          productId = exact[0].product.id; matchStatus = 'CONFIRMED'
          confirmedFingerprint = fingerprint(theirs); confirmedProductFingerprint = fingerprint(exact[0].product)
        } else if (candidates.length) { productId = candidates[0].product.id; matchStatus = 'SUGGESTED' }
      } else if (suggestedProductId && matchStatus !== 'CONFIRMED' && matchStatus !== 'REVIEW_REQUIRED') matchStatus = 'SUGGESTED'
      const now = new Date()
      const data = { sourceId, productId, externalName: result.name, externalSku: result.externalSku,
        attributes: jsonValue(result.attributes), seller: result.seller, region: result.region, priceSource: result.priceSource,
        latestPrice: result.price, oldPrice: result.oldPrice, inStock: result.inStock, lastCheckedAt: now, lastSuccessAt: now, lastError: null,
        matchStatus, confirmedFingerprint, confirmedProductFingerprint,
      }
      const row = await tx.competitorProduct.upsert({ where: { externalUrl: result.url }, update: data, create: { ...data, externalUrl: result.url }, include: { source: true, product: true } })
      const history = await tx.competitorPriceHistory.create({ data: { competitorProductId: row.id, price: result.price, oldPrice: result.oldPrice, inStock: result.inStock, checkedAt: now } })
      await this.exchange.enqueue(row.id, tx, history.id)
      return this.decorated(row)
    })
  }
  // A saved 05.ru link is stronger evidence than a storefront search page.
  // Refresh its price from the *actual product URL*, never from stale stored prices.
  private strongVariant(check: ReturnType<typeof compareItems>): boolean {
    return check.score >= 40 && !check.conflicts.length
      && Boolean(check.ours.model && check.theirs.model === check.ours.model)
      && (!check.ours.storage || check.theirs.storage === check.ours.storage)
      && (!check.ours.color || check.theirs.color === check.ours.color)
      && (!check.ours.sim || !check.theirs.sim || check.theirs.sim === check.ours.sim)
  }

  private async refreshKnownMatch(product: { id: number; name: string; brand?: string | null; attributes?: unknown }): Promise<boolean> {
    const saved = await this.prisma.competitorProduct.findMany({
      where: { source: { key: '05ru' }, externalName: { not: null } },
      orderBy: { lastSuccessAt: 'desc' }, take: 1000,
    })
    const possible = saved.map(link => ({
      link, check: compareItems(product, { name: link.externalName || '', attributes: link.attributes }),
    })).filter(row => (row.link.productId === null || row.link.productId === product.id) && this.strongVariant(row.check))
    // An already confirmed association wins over another unlinked card.
    const assigned = possible.filter(row => row.link.productId === product.id && row.link.matchStatus === 'CONFIRMED')
    const eligible = assigned.length ? assigned : possible
    if (!eligible.length) return false
    if (eligible.length !== 1) throw new Error(
      '05.ru: найдено несколько сохранённых карточек для ' + product.name +
      '. Не выбираем автоматически — проверь соответствия вручную.'
    )
    const url = eligible[0].link.externalUrl
    // Do not re-use the stored observation from 26.10 as if it was checked today.
    let fresh: FiveRuResult
    try { fresh = await this.fiveRu.parse(url) }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.prisma.competitorProduct.update({
        where: { id: eligible[0].link.id },
        data: { lastCheckedAt: new Date(), lastError: reason.slice(0, 2000) },
      })
      throw new Error('05.ru: карточка уже известна (' + url + '), но повторная проверка не удалась: ' + reason)
    }
    const updated = compareItems(product, { name: fresh.name, brand: fresh.brand, attributes: fresh.attributes })
    if (!this.strongVariant(updated)) {
      // Preserve the observation and invalidate stale confirmed fingerprints.
      const source = await this.source()
      await this.save(fresh, source.id)
      throw new Error('05.ru: сохранённая карточка изменилась, совпадение требует проверки: ' + fresh.name)
    }
    const source = await this.source()
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
    if (this.working || this.parsing) throw new ConflictException('Мониторинг занят. Повтори импорт после окончания задания.')
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
        || link.inStock !== true || !link.latestPrice || link.latestPrice <= 500) {
        throw new BadRequestException('Нужна свежая проверка цены и подтверждённое наличие на 05.ru')
      }
      const product = link.product
      const price = link.latestPrice - 500
      if (dto.expectedCurrentPrice !== product.price || dto.expectedCompetitorPrice !== link.latestPrice || dto.targetPrice !== price) {
        throw new ConflictException('Цена изменилась. Обнови мониторинг перед применением')
      }
      if (price < 1) throw new BadRequestException('Некорректная новая цена')
      if (product.costPrice && price < product.costPrice) throw new BadRequestException('Цена ниже известной себестоимости')
      if (!product.costPrice && !dto.acceptUnknownCost) throw new BadRequestException('Себестоимость неизвестна. Требуется явное подтверждение риска')
      const largeChange = Math.abs(price - product.price) > product.price * 0.1
      if (largeChange && !dto.acceptLargeChange) throw new BadRequestException('Изменение больше 10%. Требуется явное подтверждение')
      if (price === product.price) {
        throw new BadRequestException('Цена уже установлена; повторная отправка не требуется')
      }
      const message = await OneCPriceSyncService.queue(tx, product, price, id)
      const result = await tx.product.updateMany({ where: { id: product.id, price: dto.expectedCurrentPrice, status: ProductStatus.ACTIVE }, data: { price } })
      if (result.count !== 1) throw new ConflictException('Цена товара изменилась. Обнови страницу')
      await tx.auditLog.create({ data: {
        action: 'APPLY_MONITOR_SITE_PRICE', entity: 'Product', entityId: String(product.id),
        details: { monitorLinkId: id, previousPrice: product.price, competitorPrice: link.latestPrice,
          newPrice: price, costUnknown: !product.costPrice, largeChange,
          siteOnly: !message, oneCQueued: Boolean(message), oneCMessageId: message?.id ?? null },
      } })
      return { ok: true, productId: product.id, previousPrice: product.price, newPrice: price,
        siteOnly: !message, oneCQueued: Boolean(message), oneCMessageId: message?.id ?? null }
    })
    return updated
  }

  async settings() { return this.prisma.monitorSettings.upsert({ where: { id: '05ru' }, update: {}, create: { id: '05ru' } }) }
  async updateSettings(dto: MonitorSettingsDto) {
    const catalogUrl = fiveRuUrl(dto.catalogUrl, 'catalog')
    if (dto.intervalMinutes > 0 && dto.intervalMinutes < 120) throw new BadRequestException('Минимальный интервал — 120 минут')
    return this.prisma.monitorSettings.upsert({ where: { id: '05ru' }, create: { id: '05ru', catalogUrl, intervalMinutes: dto.intervalMinutes, nextRunAt: dto.intervalMinutes ? new Date(Date.now() + dto.intervalMinutes * 60000) : null }, update: { catalogUrl, intervalMinutes: dto.intervalMinutes, nextRunAt: dto.intervalMinutes ? new Date(Date.now() + dto.intervalMinutes * 60000) : null } })
  }
  jobs() { return this.prisma.monitorJob.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }) }
  async scan(dto: ScanFiveRuDto) {
    const url = fiveRuUrl(dto.url, 'catalog')
    return this.prisma.monitorJob.create({ data: { kind: 'CATALOG', url, maxPages: dto.maxPages || 1, perPage: 200 } })
  }
  async autoFindOneCSection(dto: AutoFindOneCSectionDto) {
    const path = (dto.categoryPath || '').trim()
    const limit = dto.maxItems || 30
    const imported = await this.prisma.product.findMany({
      where: { oneCId: { not: null }, status: 'ACTIVE', stockQty: { gt: 0 }, price: { gt: 0 } },
      include: { category: true }, orderBy: [{ id: 'asc' }],
    })
    const scoped = imported.filter(p => !path || p.category.name === path || p.category.name.startsWith(path + ' / '))
    if (!scoped.length) throw new BadRequestException('В выбранном разделе нет импортированных из 1С товаров с ценой и остатком')
    if (await this.prisma.monitorJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } })) {
      throw new ConflictException('Мониторинг уже выполняет задачу. Дождись завершения или останови её.')
    }
    const selected = scoped.slice(0, limit)
    const job = await this.prisma.monitorJob.create({
      data: { kind: 'MATCH_1C', url: path || null, maxPages: 1, perPage: selected.length,
        pendingUrls: selected.map(p => 'product:' + p.id) },
    })
    return { ...job, eligible: scoped.length, queued: selected.length }
  }

  async checkAll() {
    const links = await this.prisma.competitorProduct.findMany({ where: { source: { key: '05ru' } }, select: { externalUrl: true } })
    if (!links.length) throw new BadRequestException('Сначала добавь карточки или собери раздел каталога')
    return this.prisma.monitorJob.create({ data: { kind: 'RECHECK', pendingUrls: links.map(row => row.externalUrl) } })
  }
  async cancelJob(id: string) { return this.prisma.monitorJob.updateMany({ where: { id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED', finishedAt: new Date() } }) }
  async retryJob(id: string) {
    const job = await this.prisma.monitorJob.findUnique({ where: { id } })
    if (!job || !['FAILED', 'CANCELLED'].includes(job.status)) throw new BadRequestException('Можно продолжить остановленную задачу')
    return this.prisma.monitorJob.update({ where: { id }, data: { status: 'QUEUED', leaseUntil: null, finishedAt: null, lastError: null } })
  }
  private strings(value: unknown) { return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [] }
  private async tick() {
    if (this.working || this.parsing) return
    this.working = true
    try {
      const now = new Date()
      await this.prisma.monitorJob.updateMany({ where: { status: 'RUNNING', leaseUntil: { lt: now } }, data: { status: 'QUEUED' } })
      const settings = await this.settings()
      if (settings.intervalMinutes && settings.nextRunAt && settings.nextRunAt <= now && !await this.prisma.monitorJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } })) {
        const links = await this.prisma.competitorProduct.count({ where: { source: { key: '05ru' } } })
        if (links) await this.checkAll()
        await this.prisma.monitorSettings.update({ where: { id: '05ru' }, data: { nextRunAt: new Date(Date.now() + settings.intervalMinutes * 60000) } })
      }
      const job = await this.prisma.monitorJob.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' } })
      if (!job) return
      const claimed = await this.prisma.monitorJob.updateMany({ where: { id: job.id, status: 'QUEUED' }, data: { status: 'RUNNING', leaseUntil: new Date(Date.now() + 180000) } })
      if (!claimed.count) return
      let pending = this.strings(job.pendingUrls)
      try {
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
              if (!product?.oneCId || product.status !== 'ACTIVE' || product.stockQty <= 0 || product.price <= 0
                || (job.url && product.category.name !== job.url && !product.category.name.startsWith(job.url + ' / '))) {
                throw new Error('Товар исключён из выбранного раздела или больше не продаётся')
              }
              if (!(await this.refreshKnownMatch(product))) {
              let ranked: Array<{ result: FiveRuResult; check: ReturnType<typeof compareItems> }> = []
              const traces: FiveRuSearchTrace[] = []
              const rejected: string[] = []
              for (const query of oneCSearchQueries(product)) {
                const trace: FiveRuSearchTrace = { query, linksFound: 0, cardsParsed: 0, rejectedCards: [] }
                traces.push(trace)
                const results = await this.fiveRu.searchProducts(query, 12, trace)
                const checked = results.map(result => ({
                  result, check: compareItems(product, { name: result.name, brand: result.brand, attributes: result.attributes }),
                }))
                ranked = checked.filter(row => this.strongVariant(row.check))
                  .sort((a,b) => b.check.score - a.check.score)
                if (ranked.length) break
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
              if (!ranked.length) {
                const summary = traces.map(trace =>
                  '"' + trace.query + '": ' + trace.linksFound + ' ссылок, ' + trace.cardsParsed + ' прочитано' +
                    (trace.cached ? ' (кеш)' : '') +
                    (trace.pageUrl ? ' · страница ' + new URL(trace.pageUrl).pathname : '') +
                    (trace.searchMode ? ' · режим ' + trace.searchMode : '')
                ).join('; ')
                const parsingErrors = traces.flatMap(trace => trace.rejectedCards).slice(0, 2)
                throw new Error('05.ru: нет подтверждённого совпадения для ' + product.name +
                  '. Поиск: ' + summary + '. ' +
                  (rejected.length ? 'Отсеяны: ' + rejected.join('; ') : parsingErrors.length
                    ? 'Ошибки чтения: ' + parsingErrors.join('; ')
                    : '05.ru не отдал ссылки на товары. Это сбой формы поиска или пустая выдача; отсутствие товара не подтверждено.'))
              }
              // More than one plausible variant must be manually reviewed, never silently chosen.
              if (ranked.length > 1 && ranked[0].check.score - ranked[1].check.score < 10) {
                // Keep plausible 05.ru cards in the monitor for manual review,
                // but do NOT choose a winner or apply a price automatically.
                const source = await this.source()
                for (const option of ranked.slice(0, 3)) await this.save(option.result, source.id)
                throw new Error('05.ru: несколько близких совпадений для ' + product.name + '; проверь вручную')
              }
              const already = await this.prisma.competitorProduct.findUnique({ where: { externalUrl: ranked[0].result.url } })
              if (already?.productId && already.productId !== product.id) {
                throw new Error('Карточка 05.ru уже связана с другим товаром: ' + product.name)
              }
              const source = await this.source()
              await this.save(ranked[0].result, source.id, product.id)
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
            if (/HTTP\s+(?:403|429)\b|проверку доступа/i.test(message)) throw error
            const diagnostic = job.kind === 'MATCH_1C'
              ? [job.lastError, message].filter(Boolean).join('\n').slice(-7000)
              : message
            await this.prisma.monitorJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { errors: { increment: 1 }, lastError: diagnostic } })
          }
          await this.prisma.monitorJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { pendingUrls: pending.slice(1), processed: { increment: 1 } } })
        }
        const latest = await this.prisma.monitorJob.findUnique({ where: { id: job.id } })
        if (latest?.status !== 'RUNNING') return
        const done = !this.strings(latest.pendingUrls).length && (latest.kind !== 'CATALOG' || !latest.url || latest.page >= latest.maxPages)
        await this.prisma.monitorJob.update({ where: { id: job.id }, data: { status: done ? 'COMPLETED' : 'QUEUED', leaseUntil: null, finishedAt: done ? new Date() : null } })
      } catch (error) {
        await this.prisma.monitorJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: 'FAILED', leaseUntil: null, finishedAt: new Date(), lastError: error instanceof Error ? error.message : 'Ошибка задачи' } })
      }
    } finally { this.working = false }
  }

  // Kept for older clients: test imports are drafts, never inventory of the real business.
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
          const category = await this.ensureTestCategory(scan.title)
          categories.add(category.name)
          const sku = this.testSku(result), existing = await this.prisma.product.findUnique({ where: { sku } })
          const data = { sku, slug: `test-05ru-${this.key(url)}`, name: result.name, brand: result.brand, price: result.price,
            stockQty: 0, stockState: StockState.OUT_OF_STOCK, status: ProductStatus.DRAFT, categoryId: category.id,
            badge: 'ТЕСТ', attributes: jsonValue(result.attributes), image: '/products/phone.svg' }
          const product = existing ? await this.prisma.product.update({ where: { id: existing.id }, data }) : await this.prisma.product.create({ data })
          existing ? updated++ : created++
          await this.save(result, source.id, product.id)
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
