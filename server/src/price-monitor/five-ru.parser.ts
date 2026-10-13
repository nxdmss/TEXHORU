import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

type JsonObject = Record<string, unknown>

type CatalogCard = {
  url: string
  name: string
  cardText: string
  priceTexts: string[]
  inStock: boolean | null
}

export type FiveRuResult = {
  name: string
  price: number
  oldPrice: number | null
  inStock: boolean
  externalSku: string | null
  categoryName: string
  brand: string
  url: string
}

export type FiveRuCatalogResult = {
  sourceCategoryName: string
  discoveredLinks: number
  products: FiveRuResult[]
  errors: Array<{ url: string; message: string }>
}

@Injectable()
export class FiveRuParser {
  private assertUrl(rawUrl: string, mode: 'product' | 'catalog') {
    let url: URL
    try { url = new URL(rawUrl.trim()) } catch { throw new BadRequestException('Некорректная ссылка') }
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || !['05.ru', 'www.05.ru'].includes(host)) {
      throw new BadRequestException('Сейчас мониторинг разрешён только для 05.ru')
    }
    if (mode === 'product' && !/\/cat\/[^/]+\/p\//.test(url.pathname)) {
      throw new BadRequestException('Нужна ссылка на карточку товара 05.ru')
    }
    if (mode === 'catalog' && (!url.pathname.startsWith('/cat/') || /\/p\//.test(url.pathname))) {
      throw new BadRequestException('Нужна ссылка на раздел каталога 05.ru')
    }
    return url.toString()
  }

  private asNumber(value: unknown) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
    if (typeof value !== 'string') return null
    const normalized = value.replace(/[^0-9.,]/g, '').replace(',', '.')
    const result = Number(normalized)
    return Number.isFinite(result) && result > 0 ? Math.round(result) : null
  }

  private priceNumbers(text: string) {
    const matches = [
      ...text.matchAll(/(\d{1,3}(?:[\s\u00A0]\d{3})+|\d{4,7})\s*(?:₽|руб(?:\.|лей)?)/gi),
    ]
    const values = matches
      .map((match) => this.asNumber(match[1]))
      .filter((value): value is number => Boolean(value && value >= 1_000 && value <= 5_000_000))
    return [...new Set(values)]
  }

  private flattenLd(value: unknown, out: JsonObject[] = []) {
    if (Array.isArray(value)) {
      for (const item of value) this.flattenLd(item, out)
      return out
    }
    if (!value || typeof value !== 'object') return out
    const object = value as JsonObject
    out.push(object)
    for (const nested of Object.values(object)) {
      if (nested && typeof nested === 'object') this.flattenLd(nested, out)
    }
    return out
  }

  private readLdObjects(scripts: string[]) {
    const all: JsonObject[] = []
    for (const text of scripts) {
      try { this.flattenLd(JSON.parse(text), all) } catch {}
    }
    return all
  }

  private findByType(all: JsonObject[], expected: string) {
    return all.find((item) => {
      const type = item['@type']
      return type === expected || (Array.isArray(type) && type.includes(expected))
    })
  }

  private offerFromProduct(product: JsonObject | undefined) {
    const offers = product?.offers
    if (Array.isArray(offers)) return (offers.find((item) => item && typeof item === 'object') ?? null) as JsonObject | null
    return offers && typeof offers === 'object' ? offers as JsonObject : null
  }

  private productBrand(product: JsonObject | undefined, name: string) {
    const brand = product?.brand
    if (typeof brand === 'string' && brand.trim()) return brand.trim()
    if (brand && typeof brand === 'object') {
      const value = String((brand as JsonObject).name ?? '').trim()
      if (value) return value
    }
    const known = ['Apple', 'Samsung', 'Xiaomi', 'TECNO', 'Infinix', 'Honor', 'POCO', 'Realme', 'Huawei', 'OnePlus', 'Google', 'Nothing']
    return known.find((item) => new RegExp(`\\b${item}\\b`, 'i').test(name)) ?? 'Без бренда'
  }

  private productCategory(product: JsonObject | undefined, all: JsonObject[], productName: string) {
    const category = product?.category
    if (typeof category === 'string' && category.trim()) return category.trim()
    if (category && typeof category === 'object') {
      const value = String((category as JsonObject).name ?? '').trim()
      if (value) return value
    }

    const breadcrumb = this.findByType(all, 'BreadcrumbList')
    const entries = Array.isArray(breadcrumb?.itemListElement) ? breadcrumb?.itemListElement as unknown[] : []
    const names = entries.map((entry) => {
      if (!entry || typeof entry !== 'object') return ''
      const object = entry as JsonObject
      const direct = String(object.name ?? '').trim()
      if (direct) return direct
      const item = object.item
      return item && typeof item === 'object' ? String((item as JsonObject).name ?? '').trim() : ''
    }).filter(Boolean)
      .filter((value) => !/^(главная|каталог)$/i.test(value) && value !== productName)

    return names.at(-1) || 'Товары 05.ru'
  }

  private async newContext(browser: Browser) {
    return browser.newContext({
      locale: 'ru-RU',
      viewport: { width: 1440, height: 1000 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'upgrade-insecure-requests': '1',
      },
    })
  }

  private async parseProductPage(context: BrowserContext, rawUrl: string, fallbackCategory = 'Товары 05.ru'): Promise<FiveRuResult> {
    const url = this.assertUrl(rawUrl, 'product')
    let page: Page | undefined
    try {
      page = await context.newPage()
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (response && response.status() >= 400) throw new Error(`05.ru ответил HTTP ${response.status()}`)
      await page.waitForTimeout(900)

      const scripts = await page.locator('script[type="application/ld+json"]').allTextContents().catch(() => [])
      const allLd = this.readLdObjects(scripts)
      const product = this.findByType(allLd, 'Product')
      const offer = this.offerFromProduct(product)

      const h1 = (await page.locator('h1').first().innerText().catch(() => '')).trim()
      const name = String(product?.name ?? h1).trim()

      const metaPrice = await page.locator('meta[property="product:price:amount"]').first().getAttribute('content').catch(() => null)
      const itemPropPrice = await page.locator('[itemprop="price"]').first().getAttribute('content').catch(() => null)
      const bodyText = await page.locator('body').innerText().catch(() => '')
      const bodyPrices = this.priceNumbers(bodyText)

      const price = [offer?.price, offer?.lowPrice, metaPrice, itemPropPrice]
        .map((value) => this.asNumber(value))
        .find((value): value is number => Boolean(value)) ?? bodyPrices[0] ?? null

      if (!name || !price) throw new Error('Не удалось прочитать название или цену товара')

      const priceSpecification = offer?.priceSpecification && typeof offer.priceSpecification === 'object'
        ? offer.priceSpecification as JsonObject
        : null
      const explicitOld = [offer?.highPrice, priceSpecification?.price]
        .map((value) => this.asNumber(value))
        .find((value): value is number => Boolean(value && value > price)) ?? bodyPrices.find((value) => value > price) ?? null

      const availability = String(offer?.availability ?? '').toLowerCase()
      const inStock = availability
        ? !availability.includes('outofstock') && !availability.includes('soldout')
        : /в корзину|в наличии/i.test(bodyText) && !/распродано|нет в наличии/i.test(bodyText)

      const sku = String(product?.sku ?? product?.mpn ?? '').trim() || this.externalIdFromUrl(url)
      const categoryName = this.productCategory(product, allLd, name) || fallbackCategory
      const brand = this.productBrand(product, name)
      return { name, price, oldPrice: explicitOld, inStock, externalSku: sku, categoryName, brand, url }
    } finally {
      await page?.close().catch(() => undefined)
    }
  }

  private externalIdFromUrl(rawUrl: string) {
    try {
      const pathname = new URL(rawUrl).pathname.replace(/\/+$/, '')
      const tail = pathname.split('/').at(-1) ?? ''
      const numeric = tail.match(/-(\d{3,})$/)?.[1]
      return numeric || null
    } catch {
      return null
    }
  }

  private async extractCatalogCards(page: Page) {
    return page.locator('a[href]').evaluateAll((nodes) => {
      const normalize = (value: string | null | undefined) => String(value || '').replace(/\s+/g, ' ').trim()
      const seen = new Map<string, CatalogCard>()

      for (const rawNode of nodes) {
        const anchor = rawNode as HTMLAnchorElement
        let href = ''
        try { href = new URL(anchor.href, window.location.href).toString() } catch { continue }
        let parsed: URL
        try { parsed = new URL(href) } catch { continue }
        if (!['05.ru', 'www.05.ru'].includes(parsed.hostname.toLowerCase()) || !/\/cat\/[^/]+\/p\//.test(parsed.pathname)) continue
        if (seen.has(href)) continue

        let container: HTMLElement = anchor
        let cursor: HTMLElement | null = anchor
        for (let depth = 0; depth < 7 && cursor; depth += 1) {
          const text = normalize(cursor.innerText)
          if (/₽|руб(?:\.|лей)?/i.test(text) && text.length < 2500) {
            container = cursor
            break
          }
          cursor = cursor.parentElement
        }

        const cardText = normalize(container.innerText)
        const priceTexts = Array.from(container.querySelectorAll('[class*="price"], [data-price], [itemprop="price"]'))
          .map((node) => {
            const element = node as HTMLElement
            return normalize(element.getAttribute('content') || element.getAttribute('data-price') || element.innerText)
          })
          .filter(Boolean)
          .slice(0, 12)

        const titleCandidates = [
          anchor.getAttribute('title'),
          anchor.getAttribute('aria-label'),
          (container.querySelector('h2, h3, h4, [class*="title"], [class*="name"]') as HTMLElement | null)?.innerText,
          (anchor.querySelector('img') as HTMLImageElement | null)?.alt,
          (container.querySelector('img') as HTMLImageElement | null)?.alt,
          anchor.innerText,
        ].map(normalize).filter((value) => value && value.length >= 5 && !/^\d[\d\s]*[₽р]/i.test(value))

        const name = titleCandidates.sort((a, b) => b.length - a.length)[0]?.slice(0, 300) || ''
        const inStock = /распродано|нет в наличии|под заказ/i.test(cardText)
          ? false
          : /в корзину|купить|в наличии/i.test(cardText)
            ? true
            : null

        seen.set(href, { url: href, name, cardText, priceTexts, inStock })
      }
      return Array.from(seen.values())
    }) as Promise<CatalogCard[]>
  }

  private cardToProduct(card: CatalogCard, sourceCategoryName: string): FiveRuResult | null {
    if (!card.name) return null
    const preferred = card.priceTexts.flatMap((text) => this.priceNumbers(text))
    const fallback = this.priceNumbers(card.cardText)
    const prices = [...new Set([...preferred, ...fallback])]
    const price = prices[0] ?? null
    if (!price) return null
    const oldPrice = prices.find((value) => value > price) ?? null
    return {
      name: card.name,
      price,
      oldPrice,
      inStock: card.inStock ?? true,
      externalSku: this.externalIdFromUrl(card.url),
      categoryName: sourceCategoryName,
      brand: this.productBrand(undefined, card.name),
      url: card.url,
    }
  }

  private async parseInParallel(context: BrowserContext, urls: string[], fallbackCategory: string) {
    const products: FiveRuResult[] = []
    const errors: Array<{ url: string; message: string }> = []
    const queue = [...urls]
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const productUrl = queue.shift()
        if (!productUrl) return
        try {
          products.push(await this.parseProductPage(context, productUrl, fallbackCategory))
        } catch (error) {
          errors.push({ url: productUrl, message: error instanceof Error ? error.message : 'Неизвестная ошибка' })
        }
      }
    })
    await Promise.all(workers)
    return { products, errors }
  }

  async parse(rawUrl: string): Promise<FiveRuResult> {
    let browser: Browser | undefined
    try {
      browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] })
      const context = await this.newContext(browser)
      return await this.parseProductPage(context, rawUrl)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка'
      throw new BadGatewayException(`Не удалось проверить 05.ru: ${message}`)
    } finally {
      await browser?.close().catch(() => undefined)
    }
  }

  async parseCatalog(rawUrl: string, limit: number): Promise<FiveRuCatalogResult> {
    const url = this.assertUrl(rawUrl, 'catalog')
    const safeLimit = Math.min(24, Math.max(1, Math.round(limit || 12)))
    let browser: Browser | undefined
    try {
      browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] })
      const context = await this.newContext(browser)
      const page = await context.newPage()
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (response && response.status() >= 400) throw new Error(`05.ru ответил HTTP ${response.status()}`)
      await page.waitForTimeout(1000)

      for (let index = 0; index < 5; index += 1) {
        const before = (await this.extractCatalogCards(page)).length
        if (before >= safeLimit * 2) break
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined)
        await page.waitForTimeout(300)
      }

      const sourceCategoryName = (await page.locator('h1').first().innerText().catch(() => '')).trim() || 'Каталог 05.ru'
      const cards = await this.extractCatalogCards(page)
      await page.close().catch(() => undefined)

      if (!cards.length) throw new Error('В разделе не нашлись карточки товаров. Возможно, 05.ru поменял разметку.')

      const selected = cards.slice(0, safeLimit)
      const products: FiveRuResult[] = []
      const fallbackUrls: string[] = []

      for (const card of selected) {
        const fastProduct = this.cardToProduct(card, sourceCategoryName)
        if (fastProduct) products.push(fastProduct)
        else fallbackUrls.push(card.url)
      }

      const errors: Array<{ url: string; message: string }> = []
      if (fallbackUrls.length) {
        const fallback = await this.parseInParallel(context, fallbackUrls, sourceCategoryName)
        products.push(...fallback.products)
        errors.push(...fallback.errors)
      }

      if (!products.length) throw new Error(`Нашлось ${cards.length} ссылок, но данные товаров прочитать не удалось`)
      return { sourceCategoryName, discoveredLinks: cards.length, products: products.slice(0, safeLimit), errors }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка'
      throw new BadGatewayException(`Не удалось импортировать раздел 05.ru: ${message}`)
    } finally {
      await browser?.close().catch(() => undefined)
    }
  }
}
