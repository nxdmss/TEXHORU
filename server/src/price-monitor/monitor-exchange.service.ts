import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { fingerprint, recommendation } from './product-matching'

export const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

@Injectable()
export class MonitorExchangeService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(linkId: string, tx: Prisma.TransactionClient = this.prisma, historyId?: string) {
    const link = await tx.competitorProduct.findUnique({ where: { id: linkId }, include: { product: true, source: true } })
    if (!link?.product?.oneCId || link.product.status !== 'ACTIVE' || link.matchStatus !== 'CONFIRMED' || link.lastError) return null
    if (fingerprint({ name: link.externalName || '', attributes: link.attributes }) !== link.confirmedFingerprint || fingerprint(link.product) !== link.confirmedProductFingerprint) return null
    const history = historyId
      ? await tx.competitorPriceHistory.findUnique({ where: { id: historyId } })
      : await tx.competitorPriceHistory.findFirst({ where: { competitorProductId: linkId }, orderBy: [{ checkedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] })
    if (!history || !link.lastSuccessAt || Date.now() - link.lastSuccessAt.getTime() > 24 * 3600_000) return null
    const payload = jsonValue({
      schemaVersion: 1, historyId: history.id, linkId, oneCId: link.product.oneCId,
      siteProductId: link.product.id, ourSku: link.product.sku, ourName: link.product.name,
      competitor: link.source.name, url: link.externalUrl, name: link.externalName,
      price: history.price, oldPrice: history.oldPrice, inStock: history.inStock,
      checkedAt: history.checkedAt.toISOString(), currency: 'RUB', seller: link.seller,
      region: link.region, attributes: link.attributes, priceSource: link.priceSource,
      ...recommendation(link, link.product),
    })
    return tx.monitorDelivery.upsert({ where: { historyId: history.id }, update: {}, create: { historyId: history.id, linkId, payload } })
  }

  async pending() {
    const rows = await this.prisma.monitorDelivery.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 100 })
    const result: Array<Record<string, unknown>> = []
    for (const row of rows) {
      const link = await this.prisma.competitorProduct.findUnique({ where: { id: row.linkId }, include: { product: true } })
      const payload = row.payload as Record<string, unknown>
      if (!link?.product || link.product.status !== 'ACTIVE' || link.matchStatus !== 'CONFIRMED' || link.product.oneCId !== payload.oneCId || fingerprint(link.product) !== link.confirmedProductFingerprint || fingerprint({ name: link.externalName || '', attributes: link.attributes }) !== link.confirmedFingerprint) {
        await this.prisma.monitorDelivery.update({ where: { id: row.id }, data: { status: 'CANCELLED', lastError: 'Сопоставление изменилось; результат исключён из обмена' } })
        continue
      }
      result.push({ id: row.id, ...payload })
    }
    return { schemaVersion: 1, items: result }
  }

  async ack(id: string, error?: string) {
    return this.prisma.$transaction(async tx => {
      const row = await tx.monitorDelivery.findUnique({ where: { id } })
      if (!row) throw new NotFoundException('Сообщение обмена не найдено')
      if (row.status === 'DELIVERED') return { ok: true, id, status: row.status }
      if (row.status === 'CANCELLED') throw new BadRequestException('Сообщение отменено из-за изменения сопоставления')
      const updated = await tx.monitorDelivery.update({ where: { id }, data: {
        attempts: { increment: 1 }, lastError: error || null, status: error ? 'PENDING' : 'DELIVERED', deliveredAt: error ? null : new Date(),
      } })
      await tx.syncLog.create({ data: { direction: 'TO_1C', entity: 'PRICE_MONITOR', entityId: id, status: error ? 'FAILED' : 'SUCCESS', message: error || '1С подтвердила сохранение результата мониторинга' } })
      return { ok: !error, id, status: updated.status }
    })
  }

  async queueConfirmed() {
    const rows = await this.prisma.competitorProduct.findMany({ where: { matchStatus: 'CONFIRMED', productId: { not: null } }, select: { id: true } })
    let queued = 0
    for (const row of rows) if (await this.enqueue(row.id)) queued++
    return { ok: true, queued }
  }

  deliveries() { return this.prisma.monitorDelivery.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }) }
}
