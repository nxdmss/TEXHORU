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
  query: string; linksFound: number; cardsParsed: number; rejectedCards: string[]; cached?: boolean; pageUrl?: string; searchMode?: string
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
  private smartphoneCatalogCache?: { expires: number; links: Array<{ url: string; title: string }> }

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
      // Slow first-party scripts can postpone DOMContentLoaded indefinitely.
      // Accept the main response as soon as it commits, then require a real
      // product heading before extracting any price/availability information.
      const response = await page.goto(url, { waitUntil: 'commit', timeout: 20_000 })
      if (response && response.status() >= 400) throw new Error(`05.ru ответил HTTP ${response.status()}. Проверка остановлена; обход защиты не выполняется.`)
      if (!['05.ru', 'www.05.ru'].includes(new URL(page.url()).hostname)) throw new Error('Карточка перенаправила на другой сайт')
      await page.locator('h1').first().waitFor({ state: 'visible', timeout: 15_000 })
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
   * The public smartphone catalog is an alternative *discovery* channel when
   * the storefront search box does not return product links. It is not a source
   * of prices: all selected URLs still undergo a fresh product-page parse.
   * A bounded multi-page index is shared across queries during a batch.
   */
  private async smartphoneCatalogLinks(context: BrowserContext) {
    const cached = this.smartphoneCatalogCache
    if (cached && cached.expires > Date.now()) return cached.links
    const found = new Map<string, { url: string; title: string }>()
    const visited = new Set<string>()
    let next: string | null = 'https://05.ru/cat/mc/396f7486/smartfony/'
    for (let pageNo = 0; pageNo < 4 && next && found.size < 140; pageNo++) {
      const url = fiveRuUrl(next, 'catalog')
      if (visited.has(url)) break
      visited.add(url)
      const page = await context.newPage()
      try {
        const response = await page.goto(url, { waitUntil: 'commit', timeout: 20_000 })
        if (response && response.status() >= 400) throw new Error('05.ru ответил HTTP ' + response.status() + ' при открытии каталога смартфонов')
        if (!['05.ru', 'www.05.ru'].includes(new URL(page.url()).hostname)) throw new Error('Каталог 05.ru перенаправил на другой сайт')
        await page.locator('a[href*="/p/"]').first().waitFor({ timeout: 8_000 }).catch(() => undefined)
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await page.waitForTimeout(350)
        const data = await page.evaluate(() => ({
          links: Array.from(document.querySelectorAll('a[href*="/p/"]')).map(node => ({
            url: (node as HTMLAnchorElement).href,
            title: (node.getAttribute('title') || node.getAttribute('aria-label') ||
              node.querySelector('img')?.getAttribute('alt') ||
              node.closest('.product-card')?.textContent?.trim() ||
              (node as HTMLElement).innerText?.trim() || '').slice(0, 180),
          })),
          next: (document.querySelector('.page-nav__arrow_right:not(.page-nav__arrow_disabled) a[href], a[rel="next"], a[aria-label="Следующая страница"], a[aria-label="Следующая"]') as HTMLAnchorElement | null)?.href || null,
        }))
        for (const link of data.links) {
          try {
            const productUrl = fiveRuUrl(link.url, 'product')
            if (!found.has(productUrl)) found.set(productUrl, { url: productUrl, title: link.title })
          } catch { /* Product URL outside the official catalog is ignored. */ }
        }
        next = null
        if (data.next) { try { next = fiveRuUrl(data.next, 'catalog') } catch { /* Never follow another host. */ } }
      } finally { await page.close() }
    }
    if (!found.size) throw new Error('05.ru: каталог смартфонов не вернул ссылки на товары. Возможно, сайт не загрузил карточки или ограничил доступ.')
    const links = [...found.values()]
    this.smartphoneCatalogCache = { expires: Date.now() + 15 * 60_000, links }
    return links
  }

  // Read anchors from the *rendered* first-party page. Extracting titles
  // before ranking ensures we never guess competitor variants from a slug.
  private async pageProductLinks(page: Page, waitMs = 12_000) {
    await page.locator('a[href*="/p/"]').first()
      .waitFor({ state: 'attached', timeout: waitMs }).catch(() => undefined)
    const raw = await page.locator('a[href*="/p/"]').evaluateAll(nodes =>
      nodes.map(node => ({
        url: (node as HTMLAnchorElement).href,
        title: (node.getAttribute('title') || node.getAttribute('aria-label') ||
          node.querySelector('img')?.getAttribute('alt') ||
          node.closest('.product-card')?.textContent?.trim() ||
          (node as HTMLElement).innerText?.trim() || '').slice(0, 200),
      }))
    )
    const links = new Map<string, { url: string; title: string }>()
    for (const link of raw) {
      try {
        const url = fiveRuUrl(link.url, 'product')
        if (!links.has(url)) links.set(url, { url, title: link.title })
      } catch { /* Only canonical first-party product links can be opened. */ }
    }
    return [...links.values()]
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
      if (trace) Object.assign(trace, { linksFound: cached.results.length, cardsParsed: cached.results.length, cached: true })
      return cached.results
    }
    try {
      return await this.withBrowser(async browser => {
        const context = await this.context(browser, true)
        try {
          const searchPage = await context.newPage()
          let urls: string[]
          try {
            // Confirmed from the live 05.ru search UI: /search/?q=...&page=1.
            // Opening the homepage and pressing Enter was timing out, even
            // though this route displays product cards in a normal browser.
            const searchUrl = new URL('https://05.ru/search/')
            searchUrl.searchParams.set('q', text)
            searchUrl.searchParams.set('page', '1')
            const response = await searchPage.goto(searchUrl.toString(), {
              waitUntil: 'commit', timeout: 20_000,
            })
            if (response && response.status() >= 400) {
              throw new Error('05.ru ответил HTTP ' + response.status() + ' на странице поиска; обход защиты не выполняется')
            }
            const landed = new URL(searchPage.url())
            if (!['05.ru', 'www.05.ru'].includes(landed.hostname)
              || !['/search', '/search/'].includes(landed.pathname)) {
              throw new Error('05.ru перенаправил поиск на другую страницу: ' + landed.pathname)
            }
            const unique = await this.pageProductLinks(searchPage)
            if (trace) {
              trace.linksFound = unique.length
              trace.pageUrl = landed.toString()
              trace.searchMode = 'direct-search'
            }
            urls = rankSearchLinks(unique, text, limit)
            if (!urls.length) {
              // Direct /search can return a shell with 0 links even while the
              // real storefront works in Chrome. Try its visible search box
              // before concluding that 05.ru has no such product.
              try {
                const home = await searchPage.goto('https://05.ru/', { waitUntil: 'commit', timeout: 20_000 })
                if (home && home.status() >= 400) throw new Error('HTTP ' + home.status())
                if (!['05.ru', 'www.05.ru'].includes(new URL(searchPage.url()).hostname)) throw new Error('Перенаправление с 05.ru')
                const input = searchPage.locator('input[type="search"], input[placeholder*="Искать"], input[placeholder*="Поиск"]').first()
                await input.waitFor({ state: 'visible', timeout: 8_000 })
                await input.fill(text)
                await input.press('Enter')
                const uiLinks = await this.pageProductLinks(searchPage, 12_000)
                urls = rankSearchLinks(uiLinks, text, limit)
                if (trace) {
                  trace.linksFound = Math.max(trace.linksFound, uiLinks.length)
                  trace.searchMode = 'storefront-search-box'
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                if (/HTTP (403|429)|проверку доступа/i.test(message)) throw error
                if (trace && trace.rejectedCards.length < 5) trace.rejectedCards.push('Поисковая строка 05.ru: ' + message.slice(0, 160))
              }
            }
          } finally {
            await searchPage.close()
          }
          if (!urls.length) {
            // Another public, bounded discovery route. The catalog only
            // supplies candidate URLs; prices ALWAYS come from the full
            // product cards and exact model/colour/memory comparison.
            try {
              const catalogLinks = await this.smartphoneCatalogLinks(context)
              urls = rankSearchLinks(catalogLinks, text, limit)
              if (trace) {
                trace.linksFound = Math.max(trace.linksFound, catalogLinks.length)
                trace.searchMode = 'smartphone-catalog-fallback'
              }
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error)
              if (/HTTP (403|429)|проверку доступа/i.test(msg)) throw error
              if (trace && trace.rejectedCards.length < 5) trace.rejectedCards.push('Каталог смартфонов 05.ru: ' + msg.slice(0, 160))
            }
          }
          if (!urls.length) throw new Error(
            '05.ru не предоставил подходящих ссылок ни через /search/, ни через поле поиска, ни через первые страницы каталога смартфонов.' +
            ' Это не доказывает отсутствие товара. Проверь сообщения диагностики или добавь прямую ссылку через «Добавить ссылку».'
          )
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
    try {
      // Reuse Chromium between cards, keeping every request in an isolated
      // context. Launching a fresh browser for each 1C product is expensive.
      return await this.withBrowser(async browser => {
        const context = await this.context(browser)
        try {
          const page = await this.open(context, url)
          try { return extractFiveRu(await this.snapshot(page), url) }
          finally { await page.close() }
        } finally { await context.close() }
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Ошибка'
      const details = /(?:page\.goto:)?\s*Timeout\s+\d+ms exceeded/i.test(reason)
        ? '05.ru не ответил вовремя. Проверь доступность сайта с этого компьютера и повтори попытку.'
        : reason
      throw new BadGatewayException(`Не удалось проверить 05.ru: ${details}`)
    }
  }
  /**
   * Crawl the site's own public seller listing with its observed ?page=N
   * pagination. Unlike a search widget, this works for every 1C category.
   * One page per worker tick: jobs survive application restarts. No bulk
   * price claims are made from search snippets or catalog cards.
   */
  async indexCatalogPage(pageNumber: number): Promise<Array<{ url: string; title: string }>> {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 2200) {
      throw new BadRequestException('Страница публичного каталога вне допустимого диапазона')
    }
    const target = new URL('https://05.ru/cat/seller/05-ru-133/')
    if (pageNumber > 1) target.searchParams.set('page', String(pageNumber))
    try {
      return await this.withBrowser(async browser => {
        const context = await this.context(browser, true)
        try {
          const page = await context.newPage()
          try {
            const response = await page.goto(target.toString(), { waitUntil: 'commit', timeout: 20_000 })
            if (response && response.status() >= 400) {
              throw new Error('05.ru вернул HTTP ' + response.status() + ' при индексации. Ограничения доступа не обходим.')
            }
            if (!['05.ru', 'www.05.ru'].includes(new URL(page.url()).hostname)) {
              throw new Error('Публичный каталог 05.ru перенаправил на другой сайт')
            }
            await page.locator('a[href*="/p/"]').first().waitFor({ timeout: 12_000 }).catch(() => undefined)
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
            await page.waitForTimeout(400)
            const links = await page.locator('a[href*="/p/"]').evaluateAll(nodes =>
              nodes.map(node => ({
                url: (node as HTMLAnchorElement).href,
                title: (node.getAttribute('title') || node.getAttribute('aria-label') ||
                  node.querySelector('img')?.getAttribute('alt') ||
                  node.closest('.product-card')?.textContent?.trim() ||
                  (node as HTMLElement).innerText?.trim() || '').slice(0, 250),
              }))
            )
            const unique = new Map<string, { url: string; title: string }>()
            for (const link of links) {
              try {
                const url = fiveRuUrl(link.url, 'product')
                if (!unique.has(url)) unique.set(url, { url, title: link.title })
              } catch { /* Ignore navigation outside a valid 05.ru product card. */ }
            }
            return [...unique.values()]
          } finally { await page.close() }
        } finally { await context.close() }
      })
    } catch (error) {
      throw new BadGatewayException('Индекс 05.ru, страница ' + pageNumber + ': ' +
        (error instanceof Error ? error.message : String(error)))
    }
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
