import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { OneCAgentHeartbeatDto, PriceSyncReceiptsDto, PriceSyncScopeDto } from './price-sync.dto'

/**
 * Restricted, pull-based retail price exchange.
 * 1C is not publicly reachable; its agent pushes catalog prices and polls for
 * site-originated changes. No updates to 1C happen from the web server itself.
 */
@Injectable()
export class OneCPriceSyncService {
  constructor(private readonly prisma: PrismaService) {}

  async configureScope(dto: PriceSyncScopeDto) {
    return this.prisma.$transaction(async tx => {
      const active = await tx.product.findMany({ where: { oneCId: { in: dto.oneCIds }, status: 'ACTIVE' } })
      if (active.length !== dto.oneCIds.length) throw new BadRequestException('Некоторые товары ещё не загружены из 1С или скрыты')
      // Explicitly approved product GUIDs only. The pilot can cover different
      // categories, but never changes products that 1C did not opt into.
      if (active.some(p => !p.oneCId || p.price < 1 || p.price > 5_000_000)) {
        throw new BadRequestException('Каждый выбранный товар должен иметь GUID 1С и допустимую розничную цену')
      }
      const pending = await tx.oneCPriceChange.count({ where: { status: 'PENDING' } })
      if (pending) throw new ConflictException('Есть незавершённая передача цены в 1С. Сначала выполни обмен')
      await tx.product.updateMany({ where: { priceSyncEnabled: true }, data: { priceSyncEnabled: false } })
      const updated = await tx.product.updateMany({
        where: { id: { in: active.map(p => p.id) } }, data: { priceSyncEnabled: true },
      })
      await tx.syncLog.create({ data: {
        direction: 'FROM_1C', entity: 'PRICE_SYNC_SCOPE', status: 'SUCCESS',
        message: `Включено товаров: ${updated.count}`,
      } })
      return { ok: true, count: updated.count, items: active.map(p => ({ oneCId: p.oneCId, siteProductId: p.id, name: p.name, price: p.price })) }
    })
  }

  /** Add explicitly selected TEST products without removing the existing scope or its pending work. */
  async addScope(dto: PriceSyncScopeDto) {
    try {
      return await this.prisma.$transaction(async tx => {
        const active = await tx.product.findMany({ where: { oneCId: { in: dto.oneCIds }, status: 'ACTIVE' } })
        if (active.length !== dto.oneCIds.length || active.some(p => p.price < 1 || p.price > 5_000_000)) {
          throw new BadRequestException('Выбери загруженные из 1С активные товары с допустимой ценой')
        }
        const additions = active.filter(p => !p.priceSyncEnabled)
        const existing = await tx.product.count({ where: { priceSyncEnabled: true } })
        if (existing + additions.length > 30) {
          throw new BadRequestException(`В TEST разрешено до 30 товаров. Сейчас включено ${existing}, свободно ${Math.max(0, 30 - existing)}.`)
        }
        if (additions.length) {
          await tx.product.updateMany({ where: { id: { in: additions.map(p => p.id) } }, data: { priceSyncEnabled: true } })
          await tx.auditLog.create({ data: { action: 'ADD_TEST_PRICE_SCOPE', entity: 'Product',
            details: { productIds: additions.map(p => p.id), oneCIds: additions.map(p => p.oneCId) } } })
          await tx.syncLog.create({ data: { direction: 'TO_1C', entity: 'PRICE_SYNC_SCOPE', status: 'SUCCESS',
            message: `Для TEST-обмена дополнительно разрешено товаров: ${additions.length}. Цены не изменялись.` } })
        }
        return { ok: true, added: additions.length, count: existing + additions.length }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('Список разрешённых товаров изменился. Обнови сведения и повтори выбор.')
      }
      throw error
    }
  }

  /** Small, read-only lookup for a single approved TEST candidate: avoids pulling the whole public catalog into 1C. */
  async productByOneCId(oneCId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(oneCId)) {
      throw new BadRequestException('Неверный формат GUID 1С')
    }
    const product = await this.prisma.product.findFirst({
      where: { oneCId, status: 'ACTIVE' },
      select: { oneCId: true, name: true, price: true, stockQty: true },
    })
    if (!product) throw new NotFoundException('Активный товар с указанным GUID 1С на сайте не найден')
    return product
  }

  async scope() {
    return this.prisma.product.findMany({
      where: { priceSyncEnabled: true }, select: { id: true, oneCId: true, name: true, price: true, stockQty: true },
      orderBy: { id: 'asc' },
    })
  }

  /** An unacknowledged 1C price must not be blindly overwritten by an older catalog snapshot. */
  static async incomingPrice(tx: Prisma.TransactionClient, productId: number, currentSitePrice: number, incomingPrice: number) {
    const pending = await tx.oneCPriceChange.findFirst({
      where: { productId, status: 'PENDING' }, orderBy: { createdAt: 'desc' },
    })
    if (!pending) return incomingPrice
    if (incomingPrice === pending.oldPrice) return currentSitePrice
    if (incomingPrice === pending.newPrice) {
      await tx.oneCPriceChange.update({ where: { id: pending.id },
        data: { status: 'DELIVERED', deliveredAt: new Date(), lastError: null },
      })
      return incomingPrice
    }
    await tx.oneCPriceChange.update({ where: { id: pending.id }, data: {
      status: 'CONFLICT', lastError: `1С изменила цену независимо: ${incomingPrice} ₽`,
    } })
    await tx.syncLog.create({ data: {
      direction: 'FROM_1C', entity: 'PRICE_SYNC_CONFLICT', entityId: pending.id, status: 'FAILED',
      message: `Изменение сайта ${pending.newPrice} ₽ не передано: цена 1С теперь ${incomingPrice} ₽`,
    } })
    return incomingPrice
  }

  async pending() {
    const rows = await this.prisma.oneCPriceChange.findMany({
      where: { status: 'PENDING' }, include: { product: true }, orderBy: { createdAt: 'asc' }, take: 10,
    })
    const items = []
    for (const row of rows) {
      const expectedSitePrice = row.sourceLinkId ? row.oldPrice : row.newPrice
      if (!row.product.priceSyncEnabled || row.product.oneCId !== row.oneCId || row.product.price !== expectedSitePrice) {
        await this.prisma.oneCPriceChange.updateMany({ where: { id: row.id, status: 'PENDING' },
          data: { status: 'CANCELLED', lastError: 'Товар больше не входит в пилот или цена сайта изменилась' },
        })
        continue
      }
      items.push({
        id: row.id, oneCId: row.oneCId, siteProductId: row.productId, name: row.product.name,
        expectedPrice: row.oldPrice, targetPrice: row.newPrice, currency: 'RUB',
        createdAt: row.createdAt.toISOString(),
      })
    }
    return { schemaVersion: 1, items }
  }

  async receipts(dto: PriceSyncReceiptsDto) {
    const results = []
    for (const receipt of dto.items) {
      results.push(await this.prisma.$transaction(async tx => {
        const change = await tx.oneCPriceChange.findUnique({ where: { id: receipt.id }, include: { product: true } })
        if (!change) throw new NotFoundException('Неизвестный идентификатор изменения цены')
        if (change.status === 'DELIVERED') return { id: change.id, status: 'DELIVERED' }
        if (change.status !== 'PENDING') throw new ConflictException('Изменение цены уже закрыто')
        const failed = !!receipt.error || receipt.appliedPrice !== change.newPrice
        const errorMessage = receipt.error || (failed ? '1С не подтвердила точную новую цену' : null)
        if (failed) {
          // Failed writes remain pending so 1C can retry safely after a temporary error.
          await tx.oneCPriceChange.update({
            where: { id: change.id }, data: {
              status: 'PENDING', attempts: { increment: 1 }, lastError: errorMessage, deliveredAt: null,
            },
          })
          await tx.syncLog.create({ data: {
            direction: 'TO_1C', entity: 'RETAIL_PRICE_UPDATE', entityId: change.id,
            status: 'FAILED', message: errorMessage!,
          } })
          return { id: change.id, status: 'PENDING' }
        }

        // The storefront follows 1C: publish the new site price only after
        // the agent confirms that the retail-price document was posted.
        const productStillMatches = change.product.priceSyncEnabled
          && change.product.oneCId === change.oneCId
          && change.product.price === (change.sourceLinkId ? change.oldPrice : change.newPrice)
        const changed = change.sourceLinkId && productStillMatches
          ? await tx.product.updateMany({
              where: { id: change.productId, oneCId: change.oneCId, price: change.oldPrice, priceSyncEnabled: true },
              data: { price: change.newPrice },
            })
          : { count: productStillMatches ? 1 : 0 }
        if (changed.count !== 1) {
          const conflict = 'Цена сайта или разрешённая связь с 1С изменилась до подтверждения'
          await tx.oneCPriceChange.update({
            where: { id: change.id }, data: {
              status: 'CONFLICT', attempts: { increment: 1 }, lastError: conflict, deliveredAt: null,
            },
          })
          await tx.syncLog.create({ data: {
            direction: 'TO_1C', entity: 'RETAIL_PRICE_UPDATE', entityId: change.id,
            status: 'FAILED', message: conflict,
          } })
          return { id: change.id, status: 'CONFLICT' }
        }

        await tx.oneCPriceChange.update({
          where: { id: change.id }, data: {
            status: 'DELIVERED', attempts: { increment: 1 }, lastError: null, deliveredAt: new Date(),
          },
        })
        await tx.auditLog.create({ data: {
          action: 'CONFIRM_1C_PRICE_CHANGE', entity: 'Product', entityId: String(change.productId),
          details: { oneCPriceChangeId: change.id, oneCId: change.oneCId, previousPrice: change.oldPrice, newPrice: change.newPrice },
        } })
        await tx.syncLog.create({ data: {
          direction: 'TO_1C', entity: 'RETAIL_PRICE_UPDATE', entityId: change.id,
          status: 'SUCCESS', message: `Розничная цена ${change.newPrice} ₽ подтверждена в тестовой 1С`,
        } })
        return { id: change.id, status: 'DELIVERED' }
      }))
    }
    return { ok: true, results }
  }

  async heartbeat(dto: OneCAgentHeartbeatDto) {
    // One bounded row, server time, no secrets or client error strings.
    const data = { direction: 'FROM_1C' as const, entity: 'ONEC_AGENT',
      status: dto.state === 'error' ? 'FAILED' as const : 'SUCCESS' as const,
      payload: { state: dto.state, applied: dto.applied ?? 0, failed: dto.failed ?? 0 }, createdAt: new Date() }
    await this.prisma.syncLog.upsert({ where: { id: 'onec-agent-status' },
      create: { id: 'onec-agent-status', ...data }, update: data })
    return { ok: true }
  }

  async dashboard() {
    const [scope, recent, activity, pending, delivered, needsAttention] = await Promise.all([
      this.scope(),
      this.prisma.oneCPriceChange.findMany({ include: { product: { select: { name: true } } },
        orderBy: { createdAt: 'desc' }, take: 30 }),
      this.prisma.syncLog.findUnique({ where: { id: 'onec-agent-status' } }),
      this.prisma.oneCPriceChange.count({ where: { status: 'PENDING' } }),
      this.prisma.oneCPriceChange.count({ where: { status: 'DELIVERED' } }),
      this.prisma.oneCPriceChange.count({ where: { OR: [
        { status: { in: ['CONFLICT', 'CANCELLED'] } }, { status: 'PENDING', lastError: { not: null } },
      ] } }),
    ])
    const agentData = activity?.payload as { state?: string; applied?: number; failed?: number } | null
    return { scope, summary: { pending, delivered, needsAttention },
      agent: activity ? { lastSeenAt: activity.createdAt.toISOString(),
        online: Date.now() - activity.createdAt.getTime() < 5 * 60_000,
        state: agentData?.state, applied: agentData?.applied ?? 0, failed: agentData?.failed ?? 0 } : null,
      changes: recent.map(c => ({
      id: c.id, name: c.product.name, oneCId: c.oneCId, oldPrice: c.oldPrice,
      newPrice: c.newPrice, status: c.status, error: c.lastError, createdAt: c.createdAt,
      deliveredAt: c.deliveredAt,
    })) }
  }

  // Shared transaction-safe helper for BOTH admin editor and monitor recommendations.
  static async queue(tx: Prisma.TransactionClient, product: { id: number; oneCId: string | null; priceSyncEnabled: boolean; price: number }, targetPrice: number, sourceLinkId: string | null = null) {
    if (!product.priceSyncEnabled) return null
    if (!product.oneCId) throw new BadRequestException('У товара отсутствует идентификатор 1С')
    if (await tx.oneCPriceChange.count({ where: { productId: product.id, status: 'PENDING' } })) {
      throw new ConflictException('Предыдущая цена ещё не передана в 1С')
    }
    return tx.oneCPriceChange.create({ data: {
      productId: product.id, oneCId: product.oneCId, oldPrice: product.price,
      newPrice: targetPrice, sourceLinkId,
    } })
  }
}
