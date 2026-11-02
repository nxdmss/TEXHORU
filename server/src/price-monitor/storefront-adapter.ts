import { BadGatewayException, BadRequestException, Injectable, OnModuleDestroy } from '@nestjs/common'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { existsSync } from 'node:fs'
import { identity, normalize, type Identity } from './product-matching'

export type StoreKey = '05ru' | 'mvideo' | 'dns'
export type StoreProductResult = {
  name: string
  price: number
  oldPrice: number | null
  inStock: boolean | null
  externalSku: string | null
  categoryName: string
  brand: string
  url: string
  attributes: Identity
  seller: string | null
  region: string | null
  priceSource: string
}
export type StoreSearchTrace = {
  query: string
  linksFound: number
  rankedLinks: number
  cardsParsed: number
  rejectedCards: string[]
  cached?: boolean
  pageUrl?: string
  searchMode?: string
  searchPages?: number
  directLinksFound?: number
  catalogLinksFound?: number
  rankingMode?: string
}
export interface StorefrontAdapter {
  readonly key: StoreKey
  readonly name: string
  readonly baseUrl: string
  normalizeProductUrl(raw: string): string
  parse(raw: string, region?: string | null): Promise<StoreProductResult>
  searchProducts(query: string, limit?: number, trace?: StoreSearchTrace, region?: string | null): Promise<StoreProductResult[]>
}

export const STORE_DEFINITIONS: Array<{ key: StoreKey; name: string; baseUrl: string }> = [
  { key: '05ru', name: '05.ru', baseUrl: 'https://05.ru' },
  { key: 'mvideo', name: 'М.Видео', baseUrl: 'https://www.mvideo.ru' },
  { key: 'dns', name: 'DNS', baseUrl: 'https://www.dns-shop.ru' },
]

export function storeKeyFromUrl(raw: string): StoreKey {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw new BadRequestException('Некорректная ссылка магазина') }
  const host = url.hostname.toLowerCase()
  if (host === '05.ru' || host.endsWith('.05.ru')) return '05ru'
  if (host === 'mvideo.ru' || host.endsWith('.mvideo.ru')) return 'mvideo'
  if (host === 'dns-shop.ru' || host.endsWith('.dns-shop.ru')) return 'dns'
  throw new BadRequestException('Поддерживаются только 05.ru, М.Видео и DNS')
}

type RetailerConfig = {
  key: Exclude<StoreKey, '05ru'>
  name: string
  baseUrl: string
  allowedHosts: string[]
  productLinkSelector: string
  productPath: RegExp
  priceSelectors: string[]
  oldPriceSelectors: string[]
  regionSelectors: string[]
  searchFallback: (query: string) => string
  officialSellerPattern: RegExp
}
type ProductSnapshot = {
  h1: string
  scripts: string[]
  metaPrice: string | null
  metaCurrency: string | null
  domPrice: string | null
  oldPrice: string | null
  availability: string | null
  specs: Array<{ label: string; value: string }>
  seller: string | null
  region: string | null
  category: string | null
}
type JsonObject = Record<string, unknown>

function parsePrice(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 && value <= 5_000_000 ? Math.round(value) : null
  if (typeof value !== 'string') return null
  const match = value.replace(/[\u00a0\u202f]/g, ' ').match(/(?:^|\D)(\d[\d\s.,]*\d|\d)\s*(?:₽|руб\.?|RUB)?/i)
  if (!match) return null
  const clean = match[1].replace(/[\s.,]/g, '')
  const amount = Number(clean)
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 5_000_000 ? amount : null
}
function jsonLdObjects(scripts: string[]) {
  const found: JsonObject[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') {
      found.push(value as JsonObject)
      Object.values(value).forEach(visit)
    }
  }
  for (const script of scripts) { try { visit(JSON.parse(script)) } catch {} }
  return found
}
function hasType(value: JsonObject, type: string) {
  return value['@type'] === type || (Array.isArray(value['@type']) && value['@type'].includes(type))
}
function objectName(value: unknown) {
  return typeof value === 'string' ? value : value && typeof value === 'object'
    ? String((value as JsonObject).name || '') : ''
}
function normalizeHost(host: string) { return host.toLowerCase().replace(/^www\./, '') }

export function normalizeRetailerProductUrl(raw: string, config: RetailerConfig): string {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw new BadRequestException('Некорректная ссылка на товар') }
  if (url.protocol !== 'https:' || !config.allowedHosts.some(root => url.hostname.toLowerCase() === root || url.hostname.toLowerCase().endsWith('.' + root))
    || url.username || url.password || (url.port && url.port !== '443')) {
    throw new BadRequestException('Нужна HTTPS-ссылка на официальную карточку ' + config.name)
  }
  if (!config.productPath.test(url.pathname)) {
    throw new BadRequestException('Ссылка не похожа на карточку товара ' + config.name)
  }
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/?$/, '/')
  return url.toString()
}

function extractRetailerProduct(snapshot: ProductSnapshot, url: string, config: RetailerConfig): StoreProductResult {
  const objects = jsonLdObjects(snapshot.scripts)
  const products = objects.filter(object => hasType(object, 'Product'))
  const h1 = snapshot.h1.trim()
  const product = products.find(object => normalize(String(object.name || '')) === normalize(h1))
    || (products.length === 1 ? products[0] : undefined)
  const name = h1 || String(product?.name || '')
  if (!name) throw new Error('Не найдено название основной карточки товара')

  const rawOffers = Array.isArray(product?.offers) ? product.offers as JsonObject[]
    : product?.offers && typeof product.offers === 'object' ? [product.offers as JsonObject] : []
  const offers = rawOffers.filter(offer => !hasType(offer, 'AggregateOffer'))
  // M.Video can show marketplace offers for one product. Prefer the retailer's
  // own offer; never silently take an arbitrary third-party seller's price.
  const officialOffer = offers.find(offer => config.officialSellerPattern.test(objectName(offer.seller)))
  const oneOfferSeller = offers.length === 1 ? objectName(offers[0].seller) : ''
  if (config.key === 'mvideo' && oneOfferSeller && !config.officialSellerPattern.test(oneOfferSeller)) {
    throw new Error('Карточка М.Видео показывает стороннего продавца «' + oneOfferSeller + '», а не цену самого магазина')
  }
  if (config.key === 'mvideo' && offers.length > 1 && !officialOffer
    && snapshot.seller && !config.officialSellerPattern.test(snapshot.seller)) {
    throw new Error('В карточке М.Видео выбран сторонний продавец «' + snapshot.seller + '»')
  }
  const singleOffer = offers.length === 1 && (!oneOfferSeller || config.officialSellerPattern.test(oneOfferSeller))
    ? offers[0] : undefined
  const offer = officialOffer || singleOffer
  const currency = String(offer?.priceCurrency || 'RUB').toUpperCase()
  if (currency !== 'RUB') throw new Error('Цена магазина указана не в рублях: ' + currency)
  const candidates: Array<[unknown, string]> = [
    [offer?.price, officialOffer ? 'JSON-LD официального продавца' : 'JSON-LD Offer'],
    [snapshot.metaPrice, 'метаданные основной карточки'],
    [snapshot.domPrice, 'цена основной карточки'],
  ]
  const found = candidates.map(([value, source]) => ({ price: parsePrice(value), source }))
    .find(candidate => candidate.price !== null)
  if (!found?.price) throw new Error('Не удалось однозначно прочитать цену основной карточки ' + config.name)
  if (snapshot.metaCurrency && snapshot.metaCurrency.toUpperCase() !== 'RUB' && found.source === 'метаданные основной карточки') {
    throw new Error('Цена основной карточки не в RUB')
  }

  const availability = String(offer?.availability || snapshot.availability || '').toLowerCase()
  const inStock = /(?:\/|^)(instock|limitedavailability)$|в наличии|можно купить|добавить в корзину/i.test(availability) ? true
    : /outofstock|soldout|discontinued|нет в наличии|нет в продаже|распродано|preorder|backorder/i.test(availability) ? false : null
  const brand = objectName(product?.brand) || identity({ name }).brand || 'Без бренда'
  const additional = Array.isArray(product?.additionalProperty) ? product.additionalProperty as JsonObject[] : []
  const specs = [...snapshot.specs, ...additional.map(item => ({
    label: String(item.name || ''), value: String(item.value || ''),
  })).filter(item => item.label && item.value)]
  const condition = String(offer?.itemCondition || product?.itemCondition || '')
  const attributes = identity({
    name, brand, specs, category: snapshot.category,
    attributes: { condition: /used|refurbished/i.test(condition) ? 'used' : /newcondition/i.test(condition) ? 'new' : undefined },
    gtin: String(product?.gtin13 || product?.gtin14 || product?.gtin12 || product?.gtin8 || product?.gtin || ''),
    mpn: String(product?.mpn || ''),
  })
  const oldPrice = parsePrice(snapshot.oldPrice)
  const pathId = config.key === 'mvideo'
    ? new URL(url).pathname.match(/\/products\/(\d+)/)?.[1]
    : new URL(url).pathname.match(/\/product\/([a-f0-9]+)/i)?.[1]
  return {
    name,
    price: found.price,
    oldPrice: oldPrice && oldPrice > found.price ? oldPrice : null,
    inStock,
    externalSku: String(product?.sku || product?.mpn || pathId || '') || null,
    categoryName: objectName(product?.category) || snapshot.category || 'Товары ' + config.name,
    brand,
    url,
    attributes,
    seller: objectName(offer?.seller) || snapshot.seller || config.name,
    region: snapshot.region,
    priceSource: found.source,
  }
}

abstract class RetailerParserBase implements StorefrontAdapter, OnModuleDestroy {
  readonly key: Exclude<StoreKey, '05ru'>
  readonly name: string
  readonly baseUrl: string
  private browserPromise?: Promise<Browser>
  private users = 0
  private idleTimer?: NodeJS.Timeout
  private queryCache = new Map<string, { expires: number; results: StoreProductResult[] }>()

  protected constructor(private readonly config: RetailerConfig) {
    this.key = config.key
    this.name = config.name
    this.baseUrl = config.baseUrl
  }

  normalizeProductUrl(raw: string) { return normalizeRetailerProductUrl(raw, this.config) }

  private async browser() {
    if (process.platform === 'win32') {
      try { return await chromium.launch({ channel: 'msedge', headless: true }) } catch {}
    }
    if (!existsSync(chromium.executablePath())) {
      throw new Error('Не найден браузер фонового парсера. Установи Microsoft Edge или выполни установку TEXHORU.')
    }
    return chromium.launch({ headless: true })
  }

  private async withBrowser<T>(operation: (browser: Browser) => Promise<T>): Promise<T> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.users++
    try {
      if (!this.browserPromise || !(await this.browserPromise).isConnected()) {
        const launch = this.browser().catch(error => {
          if (this.browserPromise === launch) this.browserPromise = undefined
          throw error
        })
        this.browserPromise = launch
      }
      return await operation(await this.browserPromise)
    } finally {
      this.users--
      if (!this.users) {
        this.idleTimer = setTimeout(() => {
          if (this.users) return
          const idle = this.browserPromise
          this.browserPromise = undefined
          if (idle) void idle.then(browser => browser.close()).catch(() => undefined)
        }, 90_000)
        this.idleTimer.unref()
      }
    }
  }

  async onModuleDestroy() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const current = this.browserPromise
    this.browserPromise = undefined
    if (current) await current.then(browser => browser.close()).catch(() => undefined)
  }

  private async context(browser: Browser) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 1000 } })
    await context.route('**/*', route => {
      const requestUrl = new URL(route.request().url())
      if (['image', 'font', 'media'].includes(route.request().resourceType())) return route.abort()
      const host = requestUrl.hostname.toLowerCase()
      const allowed = this.config.allowedHosts.some(root => host === root || host.endsWith('.' + root))
      return requestUrl.protocol === 'https:' && allowed ? route.continue() : route.abort()
    })
    return context
  }

  private async open(context: BrowserContext, url: string) {
    const page = await context.newPage()
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
      if (response && response.status() >= 400) {
        throw new Error(this.name + ' ответил HTTP ' + response.status() + '. Ограничения доступа не обходятся.')
      }
      const host = new URL(page.url()).hostname.toLowerCase()
      if (!this.config.allowedHosts.some(root => host === root || host.endsWith('.' + root))) {
        throw new Error('Карточка перенаправила за пределы официального сайта ' + this.name)
      }
      const ready = await page.locator('h1').first().waitFor({ state: 'visible', timeout: 12_000 })
        .then(() => true).catch(() => false)
      if (!ready) {
        const hasProductData = await page.locator('script[type="application/ld+json"]').evaluateAll(nodes =>
          nodes.some(node => /"@type"\s*:\s*"Product"/.test(node.textContent || ''))
        ).catch(() => false)
        if (!hasProductData) throw new Error('Карточка ' + this.name + ' не отдала заголовок товара')
      }
      return page
    } catch (error) {
      await page.close()
      throw error
    }
  }

  private async selectRegion(page: Page, region?: string | null) {
    const wanted = (region || '').trim()
    if (!wanted) return
    const header = page.locator('header').first()
    const headerText = await header.innerText().catch(() => '')
    if (normalize(headerText).includes(normalize(wanted))) return

    // Use only the site's visible city selector. If the requested city cannot
    // be selected and verified, fail instead of storing a price for the wrong region.
    const locationTrigger = header.locator('a,button,[role="button"]').filter({ hasText: /Москва|Санкт|город|регион|местополож/i }).first()
    if (await locationTrigger.count().catch(() => 0)) {
      await locationTrigger.click({ timeout: 2500 }).catch(() => undefined)
    }
    const cityInput = page.locator('input[placeholder*="Город"],input[placeholder*="город"],input[placeholder*="Регион"],input[placeholder*="регион"],input[aria-label*="город"],input[aria-label*="Город"]').first()
    if (await cityInput.count().catch(() => 0)) {
      await cityInput.fill(wanted).catch(() => undefined)
      await page.waitForTimeout(500)
      const option = page.getByText(new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).last()
      if (await option.count().catch(() => 0)) await option.click({ timeout: 2500 }).catch(() => undefined)
      await page.waitForTimeout(900)
    }
    const updated = await header.innerText().catch(() => '')
    if (!normalize(updated).includes(normalize(wanted))) {
      throw new Error(this.name + ': не удалось подтвердить регион «' + wanted + '». Цена не будет сохранена.')
    }
  }

  private async snapshot(page: Page): Promise<ProductSnapshot> {
    const snapshotConfig = {
      priceSelectors: this.config.priceSelectors,
      oldPriceSelectors: this.config.oldPriceSelectors,
      regionSelectors: this.config.regionSelectors,
    }
    return page.evaluate((config) => {
      const main = document.querySelector('main') || document.body
      const visibleText = (root: ParentNode, selectors: string[]) => {
        for (const selector of selectors) {
          const node = Array.from(root.querySelectorAll(selector)).find(el => (el as HTMLElement).offsetParent !== null)
          if (!node) continue
          const value = node.getAttribute('content') || node.getAttribute('data-price')
            || (node as HTMLElement).innerText || node.textContent || ''
          if (value.trim()) return value.trim()
        }
        return null
      }
      const specs: Array<{ label: string; value: string }> = []
      for (const row of Array.from(main.querySelectorAll('tr'))) {
        const cells = row.querySelectorAll('th,td')
        const label = cells[0]?.textContent?.trim() || ''
        const value = cells[1]?.textContent?.trim() || ''
        if (label && value) specs.push({ label, value })
      }
      for (const row of Array.from(main.querySelectorAll('dl'))) {
        const terms = Array.from(row.querySelectorAll('dt'))
        for (const term of terms) {
          const value = term.nextElementSibling?.textContent?.trim() || ''
          const label = term.textContent?.trim() || ''
          if (label && value) specs.push({ label, value })
        }
      }
      for (const row of Array.from(main.querySelectorAll('[class*="characteristic"],[data-testid*="spec"]'))) {
        const children = Array.from(row.children)
        if (children.length >= 2) {
          const label = children[0].textContent?.trim() || ''
          const value = children[1].textContent?.trim() || ''
          if (label && value && label.length < 100 && value.length < 180) specs.push({ label, value })
        }
      }
      const uniqueSpecs = [...new Map(specs.map(item => [item.label.toLowerCase() + ':' + item.value.toLowerCase(), item])).values()]
      const region = visibleText(document, config.regionSelectors)
        || visibleText(document.querySelector('header') || document, ['[data-testid*="city"]','[class*="city"]','[class*="location"]'])
      const sellerText = visibleText(main, ['[data-testid*="seller"]','[class*="seller-name"]','[class*="merchant"]'])
      const availability = visibleText(main, ['[itemprop="availability"]','[data-testid*="availability"]','[class*="availability"]','[class*="stock"]'])
      return {
        h1: document.querySelector('h1')?.textContent?.trim() || '',
        scripts: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(node => node.textContent || ''),
        metaPrice: document.querySelector('meta[property="product:price:amount"],meta[itemprop="price"],meta[property="og:price:amount"]')?.getAttribute('content') || null,
        metaCurrency: document.querySelector('meta[property="product:price:currency"],meta[itemprop="priceCurrency"]')?.getAttribute('content') || null,
        domPrice: visibleText(main, config.priceSelectors),
        oldPrice: visibleText(main, config.oldPriceSelectors),
        availability,
        specs: uniqueSpecs,
        seller: sellerText,
        region: region?.trim() || null,
        category: Array.from(document.querySelectorAll('nav a, [aria-label*="breadcrumb"] a, .breadcrumb a'))
          .map(node => node.textContent?.trim() || '').filter(Boolean).slice(-1)[0] || null,
      }
    }, snapshotConfig)
  }

  private rankLinks(links: Array<{ url: string; title: string }>, query: string) {
    const wanted = identity({ name: query })
    const tokens = normalize(query).split(' ').filter(token => token.length > 1 && !['gb','гб','tb','тб','для','смартфон','smartphone'].includes(token))
    return links.map((link, index) => {
      const candidate = identity({ name: link.title || new URL(link.url).pathname.replace(/[/-]/g, ' ') })
      let score = 0
      if (wanted.model && candidate.model && normalize(wanted.model) === normalize(candidate.model)) score += 80
      else if (wanted.model && candidate.model && normalize(candidate.model).includes(normalize(wanted.model))) score += 35
      if (wanted.brand && candidate.brand && wanted.brand === candidate.brand) score += 15
      if (wanted.storage && candidate.storage) score += wanted.storage === candidate.storage ? 14 : -2
      if (wanted.ram && candidate.ram) score += wanted.ram === candidate.ram ? 8 : -1
      if (wanted.color && candidate.color) score += wanted.color === candidate.color ? 7 : -1
      const title = normalize(link.title)
      for (const token of tokens) if (title.includes(token)) score += 2
      return { ...link, score, index }
    }).sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 18)
  }

  private async searchPage(context: BrowserContext, query: string) {
    const page = await context.newPage()
    try {
      const home = await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 })
      if (home && home.status() >= 400) throw new Error(this.name + ' ответил HTTP ' + home.status())
      const host = new URL(page.url()).hostname.toLowerCase()
      if (!this.config.allowedHosts.some(root => host === root || host.endsWith('.' + root))) {
        throw new Error(this.name + ' перенаправил главную страницу на другой домен')
      }
      const selectors = [
        'input[type="search"]', 'input[placeholder*="Поиск"]', 'input[placeholder*="поиск"]',
        'input[aria-label*="Поиск"]', 'input[name="q"]', 'input[name="query"]',
      ]
      await page.locator(selectors.join(',')).first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined)
      let submitted = false
      for (const selector of selectors) {
        const input = page.locator(selector).first()
        if (await input.count().catch(() => 0)) {
          try {
            await input.fill(query, { timeout: 2500 })
            await input.press('Enter', { timeout: 2500 })
            submitted = true
            break
          } catch {}
        }
      }
      const collectLinks = async () => {
        await page.locator(this.config.productLinkSelector).first()
          .waitFor({ state: 'attached', timeout: 8_000 }).catch(() => undefined)
        return page.locator(this.config.productLinkSelector).evaluateAll((nodes, pattern) =>
          nodes.map(node => ({
            url: (node as HTMLAnchorElement).href,
            title: (node.getAttribute('title') || node.getAttribute('aria-label')
              || node.querySelector('img')?.getAttribute('alt')
              || node.closest('article,[class*="product-card"],[class*="catalog-product"],[data-product-id]')?.textContent
              || (node as HTMLElement).innerText || '').trim().slice(0, 260),
          })).filter(link => {
            try { return new RegExp(pattern).test(new URL(link.url).pathname) } catch { return false }
          })
        , this.config.productPath.source)
      }
      let links = submitted ? await collectLinks() : []
      // Search widgets sometimes show suggestions but do not navigate. Fall back
      // to the retailer's public search route if the form produced no product links.
      if (!links.length) {
        const fallback = this.config.searchFallback(query)
        const response = await page.goto(fallback, { waitUntil: 'domcontentloaded', timeout: 25_000 })
        if (response && response.status() >= 400) throw new Error(this.name + ' ответил HTTP ' + response.status() + ' при поиске')
        const searchHost = new URL(page.url()).hostname.toLowerCase()
        if (!this.config.allowedHosts.some(root => searchHost === root || searchHost.endsWith('.' + root))) {
          throw new Error(this.name + ' перенаправил поисковую выдачу на другой домен')
        }
        links = await collectLinks()
      }
      const unique = new Map<string, { url: string; title: string }>()
      for (const link of links) {
        try {
          const url = this.normalizeProductUrl(link.url)
          if (!unique.has(url)) unique.set(url, { url, title: link.title })
        } catch {}
      }
      return { page, links: [...unique.values()] }
    } catch (error) {
      await page.close()
      throw error
    }
  }

  private async parseInContext(context: BrowserContext, url: string, region?: string | null) {
    const page = await this.open(context, url)
    try {
      await this.selectRegion(page, region)
      return extractRetailerProduct(await this.snapshot(page), url, this.config)
    } finally { await page.close() }
  }

  async parse(raw: string, region?: string | null): Promise<StoreProductResult> {
    const url = this.normalizeProductUrl(raw)
    try {
      return await this.withBrowser(async browser => {
        const context = await this.context(browser)
        try { return await this.parseInContext(context, url, region) }
        finally { await context.close() }
      })
    } catch (error) {
      throw new BadGatewayException('Не удалось проверить ' + this.name + ': ' + (error instanceof Error ? error.message : 'Ошибка'))
    }
  }

  async searchProducts(query: string, limit = 18, trace?: StoreSearchTrace, region?: string | null): Promise<StoreProductResult[]> {
    const text = query.trim().slice(0, 160)
    if (!text || limit < 1 || limit > 18) throw new BadRequestException('Неправильный поисковый запрос')
    const cacheKey = normalize(text) + ':' + limit + ':' + normalize(region || '')
    trace ??= { query: text, linksFound: 0, rankedLinks: 0, cardsParsed: 0, rejectedCards: [] }
    Object.assign(trace, { query: text, linksFound: 0, rankedLinks: 0, cardsParsed: 0, rejectedCards: [], cached: false })
    const cached = this.queryCache.get(cacheKey)
    if (cached && cached.expires > Date.now()) {
      trace.linksFound = cached.results.length
      trace.rankedLinks = cached.results.length
      trace.cardsParsed = cached.results.length
      trace.cached = true
      return cached.results
    }
    try {
      return await this.withBrowser(async browser => {
        const context = await this.context(browser)
        try {
          const discovered = await this.searchPage(context, text)
          const { page, links } = discovered
          try {
            await this.selectRegion(page, region)
            trace!.pageUrl = page.url()
            trace!.linksFound = links.length
            trace!.searchMode = 'public-search-form'
            const ranked = this.rankLinks(links, text).slice(0, limit)
            trace!.rankedLinks = ranked.length
            trace!.rankingMode = 'model-and-variant-ranking'
            if (!ranked.length) throw new Error(this.name + ': поиск не вернул ссылок на карточки товаров')
            const slots: Array<StoreProductResult | undefined> = new Array(ranked.length)
            let cursor = 0
            const worker = async () => {
              while (cursor < ranked.length) {
                const index = cursor++
                try {
                  slots[index] = await this.parseInContext(context, ranked[index].url, region)
                  trace!.cardsParsed++
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error)
                  if (trace!.rejectedCards.length < 5) trace!.rejectedCards.push(ranked[index].url + ': ' + message.slice(0, 180))
                  if (/HTTP\s+(?:403|429)\b/.test(message)) throw error
                }
              }
            }
            const workers = await Promise.allSettled(Array.from({ length: Math.min(3, ranked.length) }, () => worker()))
            const failed = workers.find(result => result.status === 'rejected')
            if (failed?.status === 'rejected') throw failed.reason
            const results = slots.filter((result): result is StoreProductResult => Boolean(result))
            if (!results.length) throw new Error(this.name + ': найденные ссылки не удалось прочитать как карточки товаров')
            if (!trace!.rejectedCards.length) {
              if (this.queryCache.size >= 100) this.queryCache.delete(this.queryCache.keys().next().value!)
              this.queryCache.set(cacheKey, { expires: Date.now() + 5 * 60_000, results })
            }
            return results
          } finally { await page.close() }
        } finally { await context.close() }
      })
    } catch (error) {
      throw new BadGatewayException('Автопоиск ' + this.name + ': ' + (error instanceof Error ? error.message : 'Ошибка'))
    }
  }
}

@Injectable()
export class MvideoParser extends RetailerParserBase {
  constructor() {
    super({
      key: 'mvideo',
      name: 'М.Видео',
      baseUrl: 'https://www.mvideo.ru',
      allowedHosts: ['mvideo.ru'],
      productLinkSelector: 'a[href*="/products/"]',
      productPath: /^\/products\/\d+\/?$/,
      priceSelectors: [
        '[data-testid*="price"]', '[class*="price__main"]', '[class*="price-main"]',
        '[class*="productPrice"]', '[class*="price-current"]', '[itemprop="price"]',
      ],
      oldPriceSelectors: ['[class*="price-old"]','[class*="oldPrice"]','del','s'],
      regionSelectors: ['header [class*="city"]','header [class*="location"]','header [data-testid*="city"]'],
      searchFallback: query => 'https://www.mvideo.ru/search?query=' + encodeURIComponent(query),
      officialSellerPattern: /м\.?\s*видео|mvideo/i,
    })
  }
}

@Injectable()
export class DnsParser extends RetailerParserBase {
  constructor() {
    super({
      key: 'dns',
      name: 'DNS',
      baseUrl: 'https://www.dns-shop.ru',
      allowedHosts: ['dns-shop.ru'],
      productLinkSelector: 'a[href*="/product/"]',
      productPath: /^\/product\/[a-f0-9]+\/[a-z0-9-]+\/?$/i,
      priceSelectors: [
        '[data-product-price]', '[data-testid*="price"]', '[class*="product-buy__price"]',
        '[class*="product-price"]', '[class*="price__current"]', '[itemprop="price"]',
      ],
      oldPriceSelectors: ['[class*="old-price"]','[class*="price-old"]','del','s'],
      regionSelectors: ['header [class*="city"]','header [class*="location"]','header [data-testid*="city"]'],
      searchFallback: query => 'https://www.dns-shop.ru/search/?q=' + encodeURIComponent(query),
      officialSellerPattern: /\bdns\b|днс/i,
    })
  }
}
