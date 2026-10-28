import { BadRequestException, Injectable } from '@nestjs/common'
import { StockState } from '@prisma/client'
import { OrdersService } from '../orders/orders.service'
import { PrismaService } from '../prisma/prisma.service'
import { OneCCatalogDto, OneCOrderStatusDto } from './integrations.dto'
import { OneCPriceSyncService } from './price-sync.service'

@Injectable()
export class IntegrationsService {
  constructor(private readonly prisma: PrismaService, private readonly orders: OrdersService) {}

  async importCatalog(dto: OneCCatalogDto) {
    try {
      return await this.prisma.$transaction(async tx => {
        if (new Set(dto.categories.map(c => c.oneCId)).size !== dto.categories.length || new Set(dto.products.map(p => p.oneCId)).size !== dto.products.length) throw new BadRequestException('Повторяющиеся идентификаторы в пакете 1С')
        const categoryIdByIncomingOneCId = new Map<string, string>()

        for (const category of dto.categories) {
          const incomingName = category.name.trim()

          // The incoming category name is the full 1C hierarchy path.
          // Always prefer the immutable 1C GUID, so a group rename does not duplicate it.
          const sameOneCId = await tx.category.findFirst({ where: { oneCId: category.oneCId } })
          const sameName = await tx.category.findFirst({ where: { name: incomingName } })
          const sameIncomingSlug = await tx.category.findFirst({ where: { slug: category.slug } })
          let resolvedCategory

          if (sameOneCId) {
            resolvedCategory = await tx.category.update({
              where: { id: sameOneCId.id },
              data: { name: incomingName, isActive: true },
            })
          } else if (sameName && !sameName.oneCId) {
            resolvedCategory = await tx.category.update({
              where: { id: sameName.id },
              data: { oneCId: category.oneCId, isActive: true },
            })
          } else {
            const fallbackSlugBase = `1c-${this.categoryNameKey(category.oneCId)}`
            let resolvedSlug = !sameIncomingSlug ? category.slug : fallbackSlugBase
            let suffix = 2
            while (await tx.category.findFirst({ where: { slug: resolvedSlug } })) {
              resolvedSlug = `${fallbackSlugBase}-${suffix}`
              suffix += 1
            }
            resolvedCategory = await tx.category.create({
              data: { oneCId: category.oneCId, name: incomingName, slug: resolvedSlug, isActive: true },
            })
          }

          categoryIdByIncomingOneCId.set(category.oneCId, resolvedCategory.id)
        }

        for (const item of dto.products) {
          const categoryId = categoryIdByIncomingOneCId.get(item.categoryOneCId)
          const category = categoryId
            ? await tx.category.findUnique({ where: { id: categoryId } })
            : await tx.category.findFirst({ where: { oneCId: item.categoryOneCId } })

          if (!category) {
            throw new Error(`Категория товара из 1С не найдена: categoryOneCId=${item.categoryOneCId}`)
          }

          const matches = await tx.product.findMany({
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
          // The site may have just approved a new price that has not reached 1C yet.
          // Do not undo it when the 1C poll pushes the previous catalog snapshot.
          const incomingPrice = existing?.priceSyncEnabled
            ? await OneCPriceSyncService.incomingPrice(tx, existing.id, existing.price, item.price)
            : item.price
          const productData = {
            oneCId: item.oneCId,
            gtin: item.gtin, mpn: item.mpn, costPrice: item.costPrice,
            attributes: item.attributes ? { ...item.attributes } : undefined,
            sku: item.sku,
            slug: item.slug,
            name: item.name,
            brand: item.brand,
            categoryId: category.id,
            price: incomingPrice,
            oldPrice: item.oldPrice,
            stockQty: item.stockQty,
            stockState,
            status: 'ACTIVE' as const,
          }

          const updated = existing
            ? await tx.product.update({ where: { id: existing.id }, data: productData })
            : await tx.product.create({ data: productData })

          const crossedLowStock = item.stockQty <= 3 && (!existing || existing.stockQty > 3)
          if (crossedLowStock) {
            await tx.notification.create({ data: {
              type: 'LOW_STOCK', title: `Мало товара: ${updated.name}`, body: `Остаток по 1С: ${item.stockQty} шт.`,
              metadata: { productId: updated.id, oneCId: item.oneCId },
            } })
          }
        }

        await tx.syncLog.create({
          data: {
            direction: 'FROM_1C',
            entity: 'CATALOG',
            status: 'SUCCESS',
            message: `Категорий: ${dto.categories.length}; товаров: ${dto.products.length}`,
          },
        })

        return { ok: true, categories: dto.categories.length, products: dto.products.length }
      }, { timeout: 180000 })
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
