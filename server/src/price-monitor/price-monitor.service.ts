import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { ProductStatus, StockState } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { CheckCompetitorPriceDto, ImportFiveRuCatalogDto } from './price-monitor.dto'
import { FiveRuParser, type FiveRuResult } from './five-ru.parser'

@Injectable()
export class PriceMonitorService {
  constructor(private readonly prisma: PrismaService, private readonly fiveRu: FiveRuParser) {}

  private recommendedPrice(competitorPrice: number | null | undefined) {
    if (!competitorPrice || competitorPrice <= 0) return null
    return Math.max(1, competitorPrice - 500)
  }

  private withRecommendation<T extends { latestPrice?: number | null }>(item: T) {
    return { ...item, recommendedPrice: this.recommendedPrice(item.latestPrice) }
  }

  private async source() {
    return this.prisma.competitorSource.upsert({
      where: { key: '05ru' },
      update: { name: '05.ru', baseUrl: 'https://05.ru', isActive: true },
      create: { key: '05ru', name: '05.ru', baseUrl: 'https://05.ru' },
    })
  }

  async list() {
    const rows = await this.prisma.competitorProduct.findMany({
      include: { source: true, product: { include: { category: true } } },
      orderBy: [{ lastCheckedAt: 'desc' }, { createdAt: 'desc' }],
    })
    return rows.map((item) => this.withRecommendation(item))
  }

  async check(dto: CheckCompetitorPriceDto) {
    if (dto.productId) {
      const product = await this.prisma.product.findUnique({ where: { id: dto.productId } })
      if (!product) throw new NotFoundException('Товар TEXHORU не найден')
    }

    const source = await this.source()

    try {
      const result = await this.fiveRu.parse(dto.url)
      const link = await this.prisma.competitorProduct.upsert({
        where: { externalUrl: dto.url },
        update: {
          sourceId: source.id,
          productId: dto.productId ?? undefined,
          externalName: result.name,
          externalSku: result.externalSku,
          latestPrice: result.price,
          oldPrice: result.oldPrice,
          inStock: result.inStock,
          lastCheckedAt: new Date(),
          lastError: null,
        },
        create: {
          sourceId: source.id,
          productId: dto.productId,
          externalUrl: dto.url,
          externalName: result.name,
          externalSku: result.externalSku,
          latestPrice: result.price,
          oldPrice: result.oldPrice,
          inStock: result.inStock,
          lastCheckedAt: new Date(),
        },
      })
      await this.prisma.competitorPriceHistory.create({
        data: { competitorProductId: link.id, price: result.price, oldPrice: result.oldPrice, inStock: result.inStock },
      })
      const item = await this.prisma.competitorProduct.findUnique({
        where: { id: link.id },
        include: { source: true, product: { include: { category: true } } },
      })
      return item ? this.withRecommendation(item) : null
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка'
      await this.prisma.competitorProduct.upsert({
        where: { externalUrl: dto.url },
        update: { sourceId: source.id, productId: dto.productId ?? undefined, lastCheckedAt: new Date(), lastError: message },
        create: { sourceId: source.id, productId: dto.productId, externalUrl: dto.url, lastCheckedAt: new Date(), lastError: message },
      })
      throw error
    }
  }

  async applyRecommended(id: string) {
    const link = await this.prisma.competitorProduct.findUnique({ where: { id }, include: { product: true } })
    if (!link) throw new NotFoundException('Позиция мониторинга не найдена')
    if (!link.product) throw new BadRequestException('Сначала сопоставь позицию с товаром TEXHORU')
    if (!link.latestPrice) throw new BadRequestException('Сначала проверь цену конкурента')
    if (link.inStock === false) throw new BadRequestException('У конкурента товар не в наличии. Автоснижение цены заблокировано.')

    const price = this.recommendedPrice(link.latestPrice)
    if (!price) throw new BadRequestException('Не удалось рассчитать рекомендованную цену')

    await this.prisma.product.update({
      where: { id: link.product.id },
      data: {
        price,
        oldPrice: link.product.price !== price ? link.product.price : link.product.oldPrice,
      },
    })

    const updated = await this.prisma.competitorProduct.findUnique({
      where: { id },
      include: { source: true, product: { include: { category: true } } },
    })
    return updated ? this.withRecommendation(updated) : null
  }

  async importFiveRuCatalog(dto: ImportFiveRuCatalogDto) {
    const source = await this.source()
    const scan = await this.fiveRu.parseCatalog(dto.url, dto.limit ?? 12)
    let created = 0
    let updated = 0
    const categories = new Set<string>()

    for (const result of scan.products) {
      const category = await this.ensureTestCategory(result.categoryName || scan.sourceCategoryName)
      categories.add(category.name)
      const sku = this.testSku(result)
      const slug = `test-05ru-${this.key(result.url)}`
      const existing = await this.prisma.product.findUnique({ where: { sku } })
      const stockQty = result.inStock ? 10 : 0
      const stockState = result.inStock ? StockState.IN_STOCK : StockState.OUT_OF_STOCK
      const data = {
        sku,
        slug,
        name: result.name,
        brand: result.brand || 'Без бренда',
        description: `Тестовый импорт для проверки каталога TEXHORU. Источник: ${result.url}`,
        shortSpec: 'Тестовый импорт из 05.ru',
        image: '/products/phone.svg',
        price: result.price,
        oldPrice: result.oldPrice,
        stockQty,
        stockState,
        status: ProductStatus.ACTIVE,
        badge: 'ТЕСТ',
        warranty: '',
        deliveryNote: 'Тестовые данные',
        specs: [{ label: 'Источник', value: '05.ru' }],
        categoryId: category.id,
      }

      const product = existing
        ? await this.prisma.product.update({ where: { id: existing.id }, data })
        : await this.prisma.product.create({ data })
      existing ? updated += 1 : created += 1

      const link = await this.prisma.competitorProduct.upsert({
        where: { externalUrl: result.url },
        update: {
          sourceId: source.id,
          productId: product.id,
          externalName: result.name,
          externalSku: result.externalSku,
          latestPrice: result.price,
          oldPrice: result.oldPrice,
          inStock: result.inStock,
          lastCheckedAt: new Date(),
          lastError: null,
        },
        create: {
          sourceId: source.id,
          productId: product.id,
          externalUrl: result.url,
          externalName: result.name,
          externalSku: result.externalSku,
          latestPrice: result.price,
          oldPrice: result.oldPrice,
          inStock: result.inStock,
          lastCheckedAt: new Date(),
        },
      })
      await this.prisma.competitorPriceHistory.create({
        data: { competitorProductId: link.id, price: result.price, oldPrice: result.oldPrice, inStock: result.inStock },
      })
    }

    return {
      ok: true,
      sourceCategoryName: scan.sourceCategoryName,
      discoveredLinks: scan.discoveredLinks,
      imported: scan.products.length,
      created,
      updated,
      categories: [...categories],
      errors: scan.errors.length,
    }
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
