import { BadGatewayException, BadRequestException, Injectable, OnModuleDestroy } from '@nestjs/common'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { identity, normalize, type Identity } from './product-matching'
import { existsSync } from 'node:fs'
import { rankSearchLinks } from './search-discovery'

type JsonObject = Record<string, unknown>
export type FiveRuResult = {
  name: string; price: number; oldPrice: number | null; inStock: boolean | null
  externalSku: string | null; categoryName: string; brand: string; url: string
  attributes: Identity; seller: string | null; region: string | null; priceSource: string
}
export type FiveRuSearchTrace = {
  query: string; linksFound: number; cardsParsed: number; rejectedCards: string[]; cached?: boolean
}
export type ProductSnapshot = {
  h1: string; scripts: string[]; metaPrice: string | null; domPrice: string | null
  oldPrice: string | null; availability: string | null; specs: Array<{ label: string; value: string }>
  seller?: string | null; region?: string | null; category?: string | null
  metaCurrency?: string | null
}

export function fiveRuUrl(raw: string, mode: 'product' | 'catalog') {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw new BadRequestException('Некорректная ссылка') }
  if (url.protocol !== 'https:' || !['05.ru', 'www.05.ru'].includes(url.hostname.toLowerCase()) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new BadRequestException('Нужна HTTPS-ссылка на 05.ru без логина и нестандартного порта')
  }
  url.hostname = '05.ru'; url.hash = ''
  if (mode === 'product') {
    if (!/^\/cat\/[^/]+\/p\/[^/]+\/?$/.test(url.pathname)) throw new BadRequestException('Нужна сама карточка товара 05.ru, без /reviews/')
    url.search = ''; url.pathname = url.pathname.replace(/\/?$/, '/')
  } else if (!url.pathname.startsWith('/cat/') || /\/p\//.test(url.pathname)) throw new BadRequestException('Нужна ссылка на раздел каталога 05.ru')
  return url.toString()
}

export function priceNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 && value <= 5_000_000 ? Math.round(value) : null
  if (typeof value !== 'string') return null
  const clean = value.trim().replace(/[\s\u00a0\u202f]/g, '').replace(/(?:₽|руб\.?|RUB)$/i, '').replace(',', '.')
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) return null
  return priceNumber(Number(clean))
}
function ldObjects(scripts: string[]) {
  const out: JsonObject[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') { out.push(value as JsonObject); Object.values(value).forEach(walk) }
  }
  for (const text of scripts) { try { walk(JSON.parse(text)) } catch {} }
  return out
}
function byType(object: JsonObject, type: string) { return object['@type'] === type || (Array.isArray(object['@type']) && object['@type'].includes(type)) }
function objectName(value: unknown) { return typeof value === 'string' ? value : value && typeof value === 'object' ? String((value as JsonObject).name || '') : '' }

// Prices and stock never come from the entire page: it also contains recommendations and instalments.
export function extractFiveRu(snapshot: ProductSnapshot, url: string): FiveRuResult {
  const all = ldObjects(snapshot.scripts)
  const products = all.filter(o => byType(o, 'Product'))
  const product = products.find(o => normalize(String(o.name || '')) === normalize(snapshot.h1)) || (!snapshot.h1 && products.length === 1 ? products[0] : undefined)
  const name = snapshot.h1 || String(product?.name || '')
  if (!name) throw new Error('Не найдено название основной карточки')
  const offers = Array.isArray(product?.offers) ? product.offers as JsonObject[] : product?.offers && typeof product.offers === 'object' ? [product.offers as JsonObject] : []
  const single = offers.length === 1 && !byType(offers[0], 'AggregateOffer') ? offers[0] : undefined
  const currency = String(single?.priceCurrency || 'RUB').toUpperCase()
  if (currency !== 'RUB') throw new Error(`Цена не в рублях: ${currency}`)
  const candidates: Array<[unknown, string]> = [[single?.price, 'JSON-LD Offer'], [snapshot.metaPrice, 'product:price:amount'], [snapshot.domPrice, 'DOM основной карточки']]
  const found = candidates.map(([value, source]) => ({ price: priceNumber(value), source })).find(v => v.price)
  if (!found?.price) throw new Error('Не найдена однозначная цена основной карточки. Общая цена страницы не используется.')
  if (found.source === 'product:price:amount' && snapshot.metaCurrency && snapshot.metaCurrency !== 'RUB') throw new Error('Основная цена не в RUB')
  const availability = String(single?.availability || snapshot.availability || '').toLowerCase()
  const inStock = /(?:\/|^)(instock|limitedavailability)$|^в наличии$|^в корзину$/i.test(availability) ? true
    : /outofstock|soldout|discontinued|нет в наличии|распродано|под заказ|preorder|backorder/i.test(availability) ? false : null
  const brand = objectName(product?.brand) || identity({ name }).brand || 'Без бренда'
  const additional = Array.isArray(product?.additionalProperty) ? product.additionalProperty as JsonObject[] : []
  const specs = [...snapshot.specs, ...additional.map(o => ({ label: String(o.name || ''), value: String(o.value || '') }))]
  const condition = String(single?.itemCondition || product?.itemCondition || '')
  const attributes = identity({ name, brand, specs, attributes: { condition: /used|refurbished/i.test(condition) ? 'used' : /newcondition/i.test(condition) ? 'new' : undefined }, gtin: String(product?.gtin13 || product?.gtin14 || product?.gtin12 || product?.gtin8 || product?.gtin || ''), mpn: String(product?.mpn || '') })
  const old = priceNumber(snapshot.oldPrice)
  return {
    name, price: found.price, oldPrice: old && old > found.price ? old : null, inStock,
    externalSku: String(product?.sku || '') || new URL(url).pathname.match(/-(\d+)\/$/)?.[1] || null,
    categoryName: objectName(product?.category) || snapshot.category || 'Товары 05.ru', brand, url, attributes,
    seller: objectName(single?.seller) || snapshot.seller || null, region: objectName(single?.eligibleRegion) || snapshot.region || null, priceSource: found.source,
  }
}

@Injectable()
export class FiveRuParser implements OnModuleDestroy {
  private sharedBrowser?: Promise<Browser>
  private browserUsers = 0
  private browserIdleTimer?: NodeJS.Timeout
  private readonly queryCache = new Map<string, { expires: number; results: FiveRuResult[] }>()

  // Browser startup dominates short searches: reuse one process, but keep
  // isolated contexts so concurrent/admin requests cannot share page state.
  private async withBrowser<T>(operation: (browser: Browser) => Promise<T>): Promise<T> {
    if (this.browserIdleTimer) clearTimeout(this.browserIdleTimer)
    this.browserUsers++
    try {
      const current = this.sharedBrowser && await this.sharedBrowser
      if (!current?.isConnected()) {
        const launch = this.browser().catch(error => {
          if (this.sharedBrowser === launch) this.sharedBrowser = undefined
          throw error
        })
        this.sharedBrowser = launch
      }
      return await operation(await this.sharedBrowser!)
    } finally {
      this.browserUsers--
      if (this.browserUsers === 0) {
        this.browserIdleTimer = setTimeout(() => {
          if (this.browserUsers) return
          const idle = this.sharedBrowser
          this.sharedBrowser = undefined
          if (idle) void idle.then(browser => browser.close()).catch(() => undefined)
        }, 90_000)
        this.browserIdleTimer.unref()
      }
    }
  }

  async onModuleDestroy() {
    if (this.browserIdleTimer) clearTimeout(this.browserIdleTimer)
    const running = this.sharedBrowser
    this.sharedBrowser = undefined
    if (running) await running.then(browser => browser.close()).catch(() => undefined)
  }

  private async browser() {
    const channel = process.platform === 'win32' && !existsSync(chromium.executablePath()) ? 'msedge' : 'chromium'
    return chromium.launch({ channel, headless: process.env.FIVE_RU_HEADFUL !== 'true' })
  }
  private async context(browser: Browser, lightweight = false) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 1000 } })
    await context.route('**/*', route => {
      const u = new URL(route.request().url())
      // Product data is in HTML/JSON, not in images/fonts/videos; skipping them
      // substantially reduces traffic in a multi-item search.
      if (lightweight && ['image', 'font', 'media'].includes(route.request().resourceType())) return route.abort()
      return u.protocol === 'https:' && (u.hostname === '05.ru' || u.hostname.endsWith('.05.ru')) && (!u.port || u.port === '443') ? route.continue() : route.abort()
    })
    return context
  }
  private async open(context: BrowserContext, url: string) {
    const page = await context.newPage()
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (response && response.status() >= 400) throw new Error(`05.ru ответил HTTP ${response.status()}. Проверка остановлена; обход защиты не выполняется.`)
      if (!['05.ru', 'www.05.ru'].includes(new URL(page.url()).hostname)) throw new Error('Карточка перенаправила на другой сайт')
      await page.locator('h1').first().waitFor({ timeout: 8_000 })
      await page.waitForTimeout(300)
      return page
    } catch (error) { await page.close(); throw error }
  }
  private async snapshot(page: Page): Promise<ProductSnapshot> {
    await page.locator('.shop-info__link').first().waitFor({ timeout: 600 }).catch(() => undefined)
    return page.evaluate(() => {
      const main = document.querySelector('main') || document.body
      const text = (selector: string) => {
        const nodes = Array.from(main.querySelectorAll(selector)).filter(el => (el as HTMLElement).offsetParent !== null)
        const values = [...new Set(nodes.map(el => el.getAttribute('content') || (el as HTMLElement).innerText.trim()).filter(Boolean))]
        return values.length === 1 ? values[0] : null
      }
      const specs = Array.from(main.querySelectorAll('tr')).map(row => {
        const cells = row.querySelectorAll('th,td')
        return { label: cells[0]?.textContent?.trim() || '', value: cells[1]?.textContent?.trim() || '' }
      }).filter(s => s.label && s.value)
      specs.push(...Array.from(main.querySelectorAll('dl.product-characteristics__row')).map(row => ({ label: row.querySelector('dt')?.textContent?.trim() || '', value: row.querySelector('dd')?.textContent?.trim() || '' })))
      return {
        h1: document.querySelector('h1')?.textContent?.trim() || '',
        scripts: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(el => el.textContent || ''),
        metaPrice: document.querySelector('meta[property="product:price:amount"]')?.getAttribute('content') || null,
        metaCurrency: document.querySelector('meta[property="product:price:currency"]')?.getAttribute('content') || null,
        domPrice: text('.product-price-preview__value') || text('.offer-seller__price') || text('[itemprop="price"], [data-product-price]'),
        oldPrice: text('[data-product-old-price], .product-price del, .product-price s'),
        availability: main.querySelector('[itemprop="availability"]')?.getAttribute('href') || text('[data-product-availability]'), specs,
        seller: text('.shop-info__link'), region: document.querySelector('.button-select-location__selected')?.textContent?.trim() || null,
        category: main.querySelector('a[href*="/cat/mc/"]')?.textContent?.trim() || null,
      }
    })
  }
  /**
   * Searches the PUBLIC 05.ru storefront for a product name. This does not rely
   * on a hidden API or guess undocumented search URL parameters: it uses the
   * site's own search control. No anti-bot bypass, external navigation or
   * third-party price source is allowed.
   */
  async searchProducts(query: string, limit = 12, trace?: FiveRuSearchTrace): Promise<FiveRuResult[]> {
    const text = query.trim().slice(0, 160)
    if (!text || limit < 1 || limit > 12) throw new BadRequestException('Неправильный поисковый запрос')
    const cacheKey = normalize(text) + ':' + limit
    if (trace) Object.assign(trace, { query: text, linksFound: 0, cardsParsed: 0, rejectedCards: [], cached: false })
    const cached = this.queryCache.get(cacheKey)
    if (cached && cached.expires > Date.now()) {
      if (trace) Object.assign(trace, { cardsParsed: cached.results.length, cached: true })
      return cached.results
    }
    try {
      return await this.withBrowser(async browser => {
        const context = await this.context(browser, true)
        try {
          const searchPage = await context.newPage()
          let urls: string[]
          try {
            const home = await searchPage.goto('https://05.ru/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
            if (home && home.status() >= 400) throw new Error(`05.ru ответил HTTP ${home.status()}; обход защиты не выполняется`)
            const input = searchPage.locator('input[type="search"], input[placeholder*="Искать"], input[placeholder*="Поиск"]').first()
            await input.waitFor({ state: 'visible', timeout: 10_000 })
            await input.fill(text)
            await input.press('Enter')
            await searchPage.waitForTimeout(900)
            if (!['05.ru', 'www.05.ru'].includes(new URL(searchPage.url()).hostname)) throw new Error('Поиск перенаправил за пределы 05.ru')
            // Allow a delayed client-side render, but don't impose a fixed
            // multi-second delay after the result links are already present.
            await searchPage.locator('a[href*="/p/"]').first().waitFor({ timeout: 7_000 }).catch(() => undefined)
            const links = await searchPage.locator('a[href*="/p/"]').evaluateAll(nodes =>
              nodes.map(node => ({
                url: (node as HTMLAnchorElement).href,
                title: (node.getAttribute('title') || node.getAttribute('aria-label') ||
                  node.querySelector('img')?.getAttribute('alt') ||
                  (node as HTMLElement).innerText?.trim() ||
                  node.closest('.product-card')?.textContent?.trim() || '').slice(0, 180),
              }))
            )
            const valid = (links as Array<string | { url: string; title: string }>).flatMap(link => {
              const candidate = typeof link === 'string' ? { url: link, title: '' } : link
              try { return [{ url: fiveRuUrl(candidate.url, 'product'), title: candidate.title }] }
              catch { return [] }
            })
            if (trace) trace.linksFound = new Set(valid.map(link => link.url)).size
            urls = rankSearchLinks(valid, text, limit)
          } finally {
            await searchPage.close()
          }
          if (!urls.length) return []
          const slots: Array<FiveRuResult | undefined> = new Array(urls.length)
          let index = 0
          // At most 3 product pages in flight: prevents serial 05.ru latency
          // without generating an unbounded burst of requests.
          const collect = async () => {
            while (index < urls.length) {
              const slot = index++
              const url = urls[slot]
              try {
                const page = await this.open(context, url)
                try {
                  slots[slot] = extractFiveRu(await this.snapshot(page), url)
                  if (trace) trace.cardsParsed++
                } finally { await page.close() }
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error)
                if (trace && trace.rejectedCards.length < 5) trace.rejectedCards.push(url + ': ' + msg.slice(0, 180))
                if (/HTTP (403|429)|проверку доступа|timeout/i.test(msg)) throw error
                // Report unusable pages instead of pretending the catalog had no match.
              }
            }
          }
          const workers = await Promise.allSettled(Array.from({ length: Math.min(3, urls.length) }, () => collect()))
          const failed = workers.find(worker => worker.status === 'rejected')
          if (failed?.status === 'rejected') throw failed.reason
          const results = slots.filter((result): result is FiveRuResult => Boolean(result))
          if (!results.length && urls.length) {
            const firstReason = trace?.rejectedCards[0] || 'структура или цена карточки недоступна'
            throw new Error('Поиск 05.ru нашёл ' + urls.length + ' ссылок, но карточки не прочитаны: ' + firstReason)
          }
          if (results.length) {
            if (this.queryCache.size >= 100) this.queryCache.delete(this.queryCache.keys().next().value!)
            this.queryCache.set(cacheKey, { expires: Date.now() + 5 * 60_000, results })
          }
          return results
        } finally {
          await context.close()
        }
      })
    } catch (error) {
      throw new BadGatewayException(`Автопоиск 05.ru: ${error instanceof Error ? error.message : 'Ошибка'}`)
    }
  }

  async parse(raw: string): Promise<FiveRuResult> {
    const url = fiveRuUrl(raw, 'product')
    let browser: Browser | undefined
    try {
      browser = await this.browser()
      const page = await this.open(await this.context(browser), url)
      return extractFiveRu(await this.snapshot(page), url)
    } catch (error) { throw new BadGatewayException(`Не удалось проверить 05.ru: ${error instanceof Error ? error.message : 'Ошибка'}`) }
    finally { await browser?.close() }
  }
  async discover(raw: string, limit = 100) {
    const url = fiveRuUrl(raw, 'catalog')
    let browser: Browser | undefined
    try {
      browser = await this.browser()
      const page = await this.open(await this.context(browser), url)
      await page.locator('.product-card a[href*="/p/"]').first().waitFor({ timeout: 15000 })
      for (let n = 0; n < 4; n++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(400) }
      const result = await page.evaluate(() => ({
        links: Array.from(document.querySelectorAll('.product-card a[href]')).map(el => (el as HTMLAnchorElement).href),
        next: (document.querySelector('.page-nav__arrow_right:not(.page-nav__arrow_disabled) a[href], a[rel="next"], a[aria-label="Следующая страница"], a[aria-label="Следующая"]') as HTMLAnchorElement | null)?.href || null,
        title: document.querySelector('h1')?.textContent?.trim() || 'Каталог 05.ru',
      }))
      const all = [...new Set(result.links.flatMap(link => { try { return [fiveRuUrl(link, 'product')] } catch { return [] } }))]
      if (!all.length) throw new Error('Не найдены ссылки на товары. Возможно, сайт изменил разметку или показал проверку доступа.')
      let next: string | null = null
      if (result.next) { try { next = fiveRuUrl(result.next, 'catalog') } catch {} }
      const truncated = all.length > limit
      return { urls: all.slice(0, limit), next: truncated ? null : next, truncated, discovered: all.length, title: result.title }
    } catch (error) { throw new BadGatewayException(`Каталог 05.ru: ${error instanceof Error ? error.message : 'Ошибка'}`) }
    finally { await browser?.close() }
  }
}
