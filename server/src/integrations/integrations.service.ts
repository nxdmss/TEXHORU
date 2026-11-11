import { refreshCatalogIndexes } from '../products/catalog-index'
import { storefrontPath, isSmartphonePath } from '../products/storefront-path'
import { BadRequestException, ConflictException, HttpException, Injectable } from '@nestjs/common'
import { Prisma, StockState } from '@prisma/client'
import { OrdersService } from '../orders/orders.service'
import { PrismaService } from '../prisma/prisma.service'
import { OneCCatalogDto, OneCOrderStatusDto } from './integrations.dto'
import { OneCPriceSyncService } from './price-sync.service'
import { phoneVariantIndex } from '../products/phone-uniqueness'
import { automaticTestCatalogScope } from './test-catalog-policy'

@Injectable()
export class IntegrationsService {
  constructor(private readonly prisma: PrismaService, private readonly orders: OrdersService) {}

  private importing = false

  // Import grants eligibility in an enabled TEST deployment, never queues prices.
  async importCatalog(dto: OneCCatalogDto, checkpoint?: { sessionId: string; batch: number; hash: string }) {
    if (dto.products.length > 100 || dto.categories.length > 500) throw new BadRequestException('Не более 100 товаров и 500 категорий в пакете')
    if (this.importing) throw new HttpException('Другой пакет уже обрабатывается. Повторите через 2 секунды.', 429)
    this.importing = true
    const automaticScope = automaticTestCatalogScope()
    try {
      if (!checkpoint && await this.prisma.catalogImportSession.findFirst({ where: { activeKey: 'catalog', status: 'RUNNING', updatedAt: { gt: new Date(Date.now() - 86400000) } }, select: { id: true } })) {
        throw new HttpException('Идёт полная выгрузка каталога. Повторите старый обмен позже.', 429)
      }
      await refreshCatalogIndexes(this.prisma)
      return await this.prisma.$transaction(async tx => {
        if (checkpoint) {
          const session = await tx.catalogImportSession.findUnique({ where: { id: checkpoint.sessionId } })
          if (!session) throw new BadRequestException('Сеанс выгрузки не найден')
          if (session.nextBatch === checkpoint.batch + 1 && session.lastBatchHash === checkpoint.hash) return session.lastResult as Prisma.JsonObject
          if (session.status !== 'RUNNING' || session.nextBatch !== checkpoint.batch) throw new ConflictException('Номер или содержимое пакета не совпадает с прогрессом сервера')
          if (session.updatedAt.getTime() < Date.now() - 86400000) throw new ConflictException('Сеанс устарел. Начните выгрузку заново.')
        }
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

          if (sameOneCId && sameOneCId.name !== incomingName) {
            let after = 0
            while (true) {
              const affected = await tx.product.findMany({ where: { categoryId: resolvedCategory.id, id: { gt: after } },
                select: { id: true, name: true, brand: true, gtin: true, mpn: true, attributes: true, updatedAt: true }, orderBy: { id: 'asc' }, take: 200 })
              if (!affected.length) break
              for (const row of affected) await tx.product.update({ where: { id: row.id }, data: {
                importVariantKey: phoneVariantIndex({ ...row, categoryName: incomingName }), isPhone: isSmartphonePath(incomingName), browsePath: storefrontPath(incomingName, row.name), updatedAt: row.updatedAt,
              } })
              after = affected.at(-1)!.id
            }
          }
          categoryIdByIncomingOneCId.set(category.oneCId, resolvedCategory.id)
        }

        // Existing 1C GUIDs remain authoritative. A second GUID representing
        // precisely the same identifiable phone variant must not create a new card.
        // Keep all old rows, orders and price-monitor associations untouched.
        const incomingKeys = dto.products.map(item => {
          const category = dto.categories.find(c => c.oneCId === item.categoryOneCId)
          return category ? phoneVariantIndex({ ...item, categoryName: category.name }) : null
        }).filter((key): key is string => Boolean(key && key !== '-'))
        // Resolve categories not resent in a legacy batch without reading any products.
        for (const item of dto.products.filter(p => !categoryIdByIncomingOneCId.has(p.categoryOneCId))) {
          const category = await tx.category.findUnique({ where: { oneCId: item.categoryOneCId } })
          if (category) {
            const key = phoneVariantIndex({ ...item, categoryName: category.name })
            if (key !== '-') incomingKeys.push(key)
          }
        }
        const occupiedVariants = new Map<string, { oneCId: string | null; id: number }>()
        // At most one indexed representative per incoming variant (<=100).
        for (const key of new Set(incomingKeys)) {
          const row = await tx.product.findFirst({ where: { importVariantKey: key, status: 'ACTIVE' }, select: { id: true, oneCId: true }, orderBy: { id: 'asc' } })
          if (row) occupiedVariants.set(key, row)
        }
        let skippedDuplicates = 0
        const duplicateExamples: string[] = []
        let newlyEnabled = 0

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
          const variantKey = phoneVariantIndex({
            name: item.name, brand: item.brand, gtin: item.gtin, mpn: item.mpn,
            attributes: item.attributes, categoryName: category.name,
          })
          if (existing?.oneCId && existing.oneCId !== item.oneCId) {
            // A reused SKU or slug does not authorise changing a previously
            // imported 1C GUID: it would break the external inventory link.
            if (variantKey !== '-' && phoneVariantIndex({ ...existing, categoryName: category.name }) === variantKey) {
              skippedDuplicates++
              if (duplicateExamples.length < 12) duplicateExamples.push(item.name)
              continue
            }
            throw new Error('Конфликт идентификаторов 1С: SKU/slug уже принадлежит другому GUID. ' + item.name)
          }
          const occupied = variantKey !== '-' && occupiedVariants.get(variantKey)
          if (occupied && occupied.id !== existing?.id) {
            // Never merge two different immutable 1C IDs or sum their stock
            // blindly: the source's records may differ for business reasons.
            skippedDuplicates++
            if (duplicateExamples.length < 12) duplicateExamples.push(item.name)
            continue
          }
          const stockState: StockState = item.stockQty <= 0 ? StockState.OUT_OF_STOCK : item.stockQty <= 3 ? StockState.LOW : StockState.IN_STOCK
          // The site may have just approved a new price that has not reached 1C yet.
          // Do not undo it when the 1C poll pushes the previous catalog snapshot.
          const incomingPrice = existing && (existing.priceSyncEnabled || automaticScope)
            ? await OneCPriceSyncService.incomingPrice(tx, existing.id, existing.price, item.price)
            : item.price
          const productData = {
            oneCId: item.oneCId,
            // Older 1C export processors send no cost price. A repeat import
            // must not silently wipe the independently verified cost already saved.
            gtin: item.gtin, mpn: item.mpn, costPrice: item.costPrice ?? existing?.costPrice ?? null,
            attributes: item.attributes ? { ...item.attributes } : undefined,
            sku: item.sku,
            slug: item.slug,
            name: item.name,
            brand: item.brand,
            categoryId: category.id,
            price: incomingPrice,
            oldPrice: item.oldPrice,
            stockQty: item.isDeleted ? 0 : item.stockQty,
            stockState,
            importVariantKey: variantKey,
            isPhone: isSmartphonePath(category.name),
            browsePath: storefrontPath(category.name, item.name),
            searchText: `${item.name} ${item.brand} ${item.sku} ${existing?.shortSpec || ''}`.toLocaleLowerCase('ru-RU'),
            status: item.isDeleted ? 'ARCHIVED' as const : 'ACTIVE' as const,
            ...(automaticScope ? { priceSyncEnabled: true } : {}),
          }

          const updated = existing
            ? await tx.product.update({ where: { id: existing.id }, data: productData })
            : await tx.product.create({ data: productData })
          if (variantKey !== '-') occupiedVariants.set(variantKey, { oneCId: updated.oneCId, id: updated.id })
          if (automaticScope && !existing?.priceSyncEnabled) newlyEnabled++

          const crossedLowStock = item.stockQty <= 3 && (!existing || existing.stockQty > 3)
          if (crossedLowStock) {
            await tx.notification.create({ data: {
              type: 'LOW_STOCK', title: `Мало товара: ${updated.name}`, body: `Остаток по 1С: ${item.stockQty} шт.`,
              metadata: { productId: updated.id, oneCId: item.oneCId },
            } })
          }
        }

        let autoPriceScope: { enabled: number; newlyEnabled: number; skippedByLimit: number } | null = null
        if (automaticScope) {
          autoPriceScope = { enabled: await tx.product.count({ where: { oneCId: { not: null }, status: 'ACTIVE', priceSyncEnabled: true } }),
            newlyEnabled, skippedByLimit: 0 }
          if (newlyEnabled) await tx.syncLog.create({ data: {
            direction: 'FROM_1C', entity: 'PRICE_SYNC_SCOPE', status: 'SUCCESS',
            message: `TEST: автоматически подключено товаров: ${newlyEnabled}. Цены не изменялись.`,
          } })
        }

        await tx.syncLog.create({
          data: {
            direction: 'FROM_1C',
            entity: 'CATALOG',
            status: 'SUCCESS',
            message: `Категорий: ${dto.categories.length}; новых/обновлённых товаров: ${dto.products.length - skippedDuplicates}; пропущено дублей: ${skippedDuplicates}`,
          },
        })

        const result = { ok: true, categories: dto.categories.length,
          products: dto.products.length - skippedDuplicates,
          skippedDuplicates, duplicateExamples, ...(autoPriceScope ? { autoPriceScope } : {}) }
        if (checkpoint) await tx.catalogImportSession.update({ where: { id: checkpoint.sessionId }, data: {
          nextBatch: { increment: 1 }, processed: { increment: result.products }, skipped: { increment: skippedDuplicates },
          lastBatchHash: checkpoint.hash, lastResult: result,
        } })
        return result
      }, { timeout: 30000 })
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 429) throw error
      await this.prisma.syncLog.create({
        data: {
          direction: 'FROM_1C',
          entity: 'CATALOG',
          status: 'FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      })
      throw error
    } finally { this.importing = false }
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
