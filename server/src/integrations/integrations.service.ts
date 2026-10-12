import { Injectable } from '@nestjs/common'
import { StockState } from '@prisma/client'
import { OrdersService } from '../orders/orders.service'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'
import { OneCCatalogDto, OneCOrderStatusDto } from './integrations.dto'

@Injectable()
export class IntegrationsService {
  constructor(private readonly prisma: PrismaService, private readonly orders: OrdersService, private readonly notifications: NotificationsService) {}

  async importCatalog(dto: OneCCatalogDto) {
    try {
      const categoryIdByIncomingOneCId = new Map<string, string>()

      for (const category of dto.categories) {
        const incomingName = category.name.trim()

        // In our test 1C configuration category IDs/slugs may accidentally be reused.
        // The visible category name is therefore the strongest discriminator here.
        const sameName = await this.prisma.category.findFirst({
          where: { name: incomingName },
        })

        const sameOneCId = await this.prisma.category.findFirst({
          where: { oneCId: category.oneCId },
        })

        const sameIncomingSlug = await this.prisma.category.findFirst({
          where: { slug: category.slug },
        })

        let resolvedCategory

        if (sameName) {
          const canAttachOneCId = !sameOneCId || sameOneCId.id === sameName.id
          resolvedCategory = await this.prisma.category.update({
            where: { id: sameName.id },
            data: {
              ...(canAttachOneCId ? { oneCId: category.oneCId } : {}),
              isActive: true,
            },
          })
        } else {
          // Never reuse a slug that currently belongs to a category with another name.
          // Otherwise "Смартфоны" can silently become "Игровые приставки" again.
          const slugIsFree = !sameIncomingSlug
          const fallbackSlugBase = `1c-${this.categoryNameKey(incomingName)}`
          let resolvedSlug = slugIsFree ? category.slug : fallbackSlugBase
          let suffix = 2

          while (await this.prisma.category.findFirst({ where: { slug: resolvedSlug } })) {
            resolvedSlug = `${fallbackSlugBase}-${suffix}`
            suffix += 1
          }

          const canAttachOneCId = !sameOneCId
          resolvedCategory = await this.prisma.category.create({
            data: {
              oneCId: canAttachOneCId ? category.oneCId : null,
              name: incomingName,
              slug: resolvedSlug,
              isActive: true,
            },
          })
        }

        categoryIdByIncomingOneCId.set(category.oneCId, resolvedCategory.id)
      }

      for (const item of dto.products) {
        const categoryId = categoryIdByIncomingOneCId.get(item.categoryOneCId)
        const category = categoryId
          ? await this.prisma.category.findUnique({ where: { id: categoryId } })
          : await this.prisma.category.findFirst({ where: { oneCId: item.categoryOneCId } })

        if (!category) {
          throw new Error(`Категория товара из 1С не найдена: categoryOneCId=${item.categoryOneCId}`)
        }

        const matches = await this.prisma.product.findMany({
          where: {
            OR: [
              { oneCId: item.oneCId },
              { sku: item.sku },
              { slug: item.slug },
            ],
          },
          take: 4,
        })

        const byOneCId = matches.find((product) => product.oneCId === item.oneCId)
        const bySku = matches.find((product) => product.sku === item.sku)
        const bySlug = matches.find((product) => product.slug === item.slug)
        const matchedIds = new Set(matches.map((product) => product.id))

        if (matchedIds.size > 1) {
          throw new Error(`Конфликт товара 1С: oneCId=${item.oneCId}, sku=${item.sku}, slug=${item.slug} указывают на разные товары сайта`)
        }

        const existing = byOneCId ?? bySku ?? bySlug
        const stockState: StockState = item.stockQty <= 0 ? StockState.OUT_OF_STOCK : item.stockQty <= 3 ? StockState.LOW : StockState.IN_STOCK
        const productData = {
          oneCId: item.oneCId,
          sku: item.sku,
          slug: item.slug,
          name: item.name,
          brand: item.brand,
          categoryId: category.id,
          price: item.price,
          oldPrice: item.oldPrice,
          stockQty: item.stockQty,
          stockState,
          status: 'ACTIVE' as const,
        }

        const updated = existing
          ? await this.prisma.product.update({ where: { id: existing.id }, data: productData })
          : await this.prisma.product.create({ data: productData })

        const crossedLowStock = item.stockQty <= 3 && (!existing || existing.stockQty > 3)
        if (crossedLowStock) {
          await this.notifications.create(
            'LOW_STOCK',
            `Мало товара: ${updated.name}`,
            `Остаток по 1С: ${item.stockQty} шт.`,
            { productId: updated.id, oneCId: item.oneCId },
          )
        }
      }

      await this.prisma.syncLog.create({
        data: {
          direction: 'FROM_1C',
          entity: 'CATALOG',
          status: 'SUCCESS',
          message: `Категорий: ${dto.categories.length}; товаров: ${dto.products.length}`,
        },
      })

      return { ok: true, categories: dto.categories.length, products: dto.products.length }
    } catch (error) {
      await this.prisma.syncLog.create({
        data: {
          direction: 'FROM_1C',
          entity: 'CATALOG',
          status: 'FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      })
      throw error
    }
  }


  private categoryNameKey(value: string) {
    let hash = 2166136261
    const normalized = value.trim().toLocaleLowerCase('ru-RU')
    for (let index = 0; index < normalized.length; index += 1) {
      hash ^= normalized.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(36)
  }

  pendingOrders() {
    return this.prisma.order.findMany({ where: { oneCSyncedAt: null, status: { not: 'CANCELLED' } }, include: { items: true }, orderBy: { createdAt: 'asc' }, take: 100 })
  }

  async ackOrder(id: string, oneCId: string) {
    const order = await this.prisma.order.update({ where: { id }, data: { oneCId, oneCSyncedAt: new Date() } })
    await this.prisma.syncLog.create({ data: { direction: 'TO_1C', entity: 'ORDER', entityId: id, status: 'SUCCESS', message: oneCId } })
    return order
  }

  async orderStatus(dto: OneCOrderStatusDto) {
    try {
      const order = await this.orders.updateStatus(dto.siteOrderId, dto.status)
      await this.prisma.syncLog.create({ data: { direction: 'FROM_1C', entity: 'ORDER_STATUS', entityId: dto.siteOrderId, status: 'SUCCESS', message: dto.status } })
      return { ok: true, orderId: order.id, status: order.status }
    } catch (error) {
      await this.prisma.syncLog.create({ data: { direction: 'FROM_1C', entity: 'ORDER_STATUS', entityId: dto.siteOrderId, status: 'FAILED', message: error instanceof Error ? error.message : 'Unknown error' } })
      throw error
    }
  }

  logs() { return this.prisma.syncLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }) }
}
