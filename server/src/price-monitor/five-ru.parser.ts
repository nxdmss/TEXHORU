import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { identity, normalize, type Identity } from './product-matching'
import { existsSync } from 'node:fs'

type JsonObject = Record<string, unknown>
export type FiveRuResult = {
  name: string; price: number; oldPrice: number | null; inStock: boolean | null
  externalSku: string | null; categoryName: string; brand: string; url: string
  attributes: Identity; seller: string | null; region: string | null; priceSource: string
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
export class FiveRuParser {
  private async browser() {
    const channel = process.platform === 'win32' && !existsSync(chromium.executablePath()) ? 'msedge' : 'chromium'
    return chromium.launch({ channel, headless: process.env.FIVE_RU_HEADFUL !== 'true' })
  }
  private async context(browser: Browser) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 1000 } })
    await context.route('**/*', route => {
      const u = new URL(route.request().url())
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
      await page.locator('h1').first().waitFor({ timeout: 10_000 })
      await page.waitForTimeout(1000)
      return page
    } catch (error) { await page.close(); throw error }
  }
  private async snapshot(page: Page): Promise<ProductSnapshot> {
    await page.locator('.shop-info__link').first().waitFor({ timeout: 8000 }).catch(() => undefined)
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
