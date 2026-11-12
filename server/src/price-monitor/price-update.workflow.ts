import { priceSyncEnabled } from '../integrations/test-catalog-policy'
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { OneCPriceSyncService } from '../integrations/price-sync.service'

const CURRENT_ID = 'test-price-update-current'
const ACTIVE = ['CHECKING', 'QUEUING', 'WAITING']
const UNCHANGED = 'Цена уже актуальна'
type ItemState = 'CHECKING' | 'READY' | 'PENDING' | 'APPLIED' | 'SKIPPED' | 'FAILED'
type UpdateItem = {
  productId: number; name: string; categoryPath: string; status: ItemState
  reason: string | null; oldPrice: number; newPrice: number | null
  messageId: string | null; linkId: string | null
}
type Context = { id: string; childId: string | null; items: UpdateItem[]; readySince?: string }
type SnapshotRow = {
  id: string; productId: number | null; oldPrice: number | null; newPrice: number
  blockedReasons: string[]; lastSuccessAt: string | null
}
type Snapshot = { items: SnapshotRow[] }
type Job = { id: string; status: string; visitedUrls: Prisma.JsonValue; createdAt: Date; finishedAt: Date | null; lastError: string | null }
const json = (value: Context) => value as unknown as Prisma.InputJsonValue

/** Durable delivery of existing verified prices. This action never parses
 * storefront pages, discovers matches or changes product permissions. */
export class PriceUpdateWorkflow {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: (db: PrismaService | Prisma.TransactionClient) => Promise<Snapshot>,
  ) {}

  private enabled() {
    return priceSyncEnabled()
  }
  private assertEnabled() {
    if (!this.enabled()) throw new ForbiddenException('Обратная передача цен отключена: настрой и включи профиль базы 1С')
  }
  private context(job: Job): Context { return job.visitedUrls as unknown as Context }

  private async reconcile(ctx: Context, db: PrismaService | Prisma.TransactionClient = this.prisma) {
    const ids = ctx.items.flatMap(item => item.messageId ? [item.messageId] : [])
    if (!ids.length) return
    const changes = await db.oneCPriceChange.findMany({ where: { id: { in: ids } } })
    const byId = new Map(changes.map(change => [change.id, change]))
    for (const item of ctx.items) {
      if (!item.messageId) continue
      const change = byId.get(item.messageId)
      if (change?.status === 'DELIVERED') { item.status = 'APPLIED'; item.reason = null }
      else if (change?.status === 'PENDING') { item.status = 'PENDING'; item.reason = change.lastError }
      else { item.status = 'FAILED'; item.reason = change?.lastError || 'Передача цены отменена или потеряна' }
    }
  }

  private present(job: Job, ctx: Context) {
    const count = (status: ItemState) => ctx.items.filter(item => item.status === status).length
    return {
      id: ctx.id, state: job.status, total: ctx.items.length,
      checked: ctx.items.length - count('CHECKING'), ready: count('READY'),
      queued: ctx.items.filter(item => item.messageId).length, pending: count('PENDING'),
      applied: count('APPLIED'), failed: count('FAILED'), skipped: count('SKIPPED'),
      items: ctx.items, createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() || null, error: job.lastError,
    }
  }

  async current() {
    const job = await this.prisma.monitorJob.findUnique({ where: { id: CURRENT_ID } })
    if (!job) return null
    const ctx = this.context(job)
    await this.reconcile(ctx)
    const result = this.present(job, ctx)
    const ownIds = new Set(ctx.items.map(item => item.messageId))
    const outside = (await this.prisma.oneCPriceChange.findMany({ where: { status: 'PENDING' }, select: { id: true, lastError: true } }))
      .filter(change => !ownIds.has(change.id))
    const oldError = outside.find(change => change.lastError)?.lastError
    return { ...result, waitingExternal: outside.length,
      error: oldError && ACTIVE.includes(job.status) ? 'Предыдущий обмен с 1С ещё не завершён: ' + oldError : result.error }
  }

  async start(productIds?: number[]) {
    this.assertEnabled()
    if (productIds && (!productIds.length || productIds.length > 5000
      || new Set(productIds).size !== productIds.length
      || productIds.some(id => !Number.isSafeInteger(id) || id < 1))) {
      throw new BadRequestException('Выбери от 1 до 5000 разных товаров')
    }
    try {
      return await this.prisma.$transaction(async tx => {
        const old = await tx.monitorJob.findUnique({ where: { id: CURRENT_ID } })
        if (old && ACTIVE.includes(old.status)) {
          const ctx = this.context(old)
          await this.reconcile(ctx, tx)
          return this.present(old, ctx)
        }
        const products = await tx.product.findMany({
          where: { oneCId: { not: null }, status: 'ACTIVE', ...(productIds ? {} : { priceSyncEnabled: true }), ...(productIds ? { id: { in: productIds } } : {}) },
          include: { category: true }, orderBy: { id: 'asc' }, take: 5001,
        })
        if (!products.length) throw new BadRequestException('Нет разрешённых товаров для обмена с 1С')
        if (products.length > 5000) throw new BadRequestException('Выбери раздел или не больше 5000 товаров')
        if (productIds && products.length !== productIds.length) throw new BadRequestException('Некоторые выбранные товары неактивны или не загружены из 1С')
        const pending = await tx.oneCPriceChange.findMany({ where: { status: 'PENDING', productId: { in: products.map(p => p.id) } } })
        const pendingByProduct = new Map(pending.map(change => [change.productId, change]))
        const snapshot = await this.snapshot(tx)
        const rows = new Map(snapshot.items.map(row => [row.productId, row]))
        const items: UpdateItem[] = products.map(product => {
          const pending = pendingByProduct.get(product.id)
          const row = rows.get(product.id)
          const reason = !product.priceSyncEnabled ? 'Не разрешён обмен с 1С'
            : product.stockQty <= product.reservedQty ? 'Нет свободного остатка товара'
            : !row ? 'Нет новой проверенной цены'
            : row.blockedReasons.join('; ') || null
          return { productId: product.id, name: product.name, categoryPath: product.category.name,
            status: pending ? 'PENDING' : reason ? 'SKIPPED' : 'READY', reason: pending?.lastError || reason,
            oldPrice: pending?.oldPrice ?? product.price, newPrice: pending?.newPrice ?? row?.newPrice ?? null,
            messageId: pending?.id || null, linkId: pending?.sourceLinkId || row?.id || null }
        })
        // Never discover new matches or grant permissions from the update button.
        const id = randomUUID()
        const ctx: Context = { id, childId: null, items }
        const now = new Date()
        const job = await tx.monitorJob.upsert({ where: { id: CURRENT_ID },
          create: { id: CURRENT_ID, kind: 'PRICE_UPDATE', sourceKey: '05ru', status: 'QUEUING', visitedUrls: json(ctx), perPage: items.length },
          update: { status: 'QUEUING', visitedUrls: json(ctx), perPage: items.length, processed: 0, errors: 0,
            createdAt: now, finishedAt: null, leaseUntil: null, lastError: null },
        })
        return this.present(job, ctx)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30000 })
    } catch (error) {
      // A simultaneous duplicate button press must not create another run.
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) {
        const current = await this.current()
        if (current && ACTIVE.includes(current.state)) return current
      }
      throw error
    }
  }

  async cancel(id: string) {
    return this.prisma.$transaction(async tx => {
      const job = await tx.monitorJob.findUnique({ where: { id: CURRENT_ID } })
      if (!job || this.context(job).id !== id) throw new NotFoundException('Обновление не найдено')
      const ctx = this.context(job)
      await this.reconcile(ctx, tx)
      if (ACTIVE.includes(job.status)) {
        for (const item of ctx.items) if (item.status === 'CHECKING' || item.status === 'READY') {
          item.status = 'SKIPPED'; item.reason = 'Остановлено пользователем'
        }
        if (ctx.childId) await tx.monitorJob.updateMany({ where: { id: ctx.childId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED', leaseUntil: null, finishedAt: new Date() } })
        const stopped = await tx.monitorJob.update({ where: { id: CURRENT_ID }, data: { status: 'CANCELLED', visitedUrls: json(ctx), finishedAt: new Date(), leaseUntil: null } })
        return this.present(stopped, ctx)
      }
      return this.present(job, ctx)
    })
  }

  /** Called by the existing single worker before its next matching card.
   * A database lease also prevents overlapping coordinators after a restart. */
  async advance() {
    if (!this.enabled()) return
    const lease = new Date(Date.now() + 180000)
    const claimed = await this.prisma.monitorJob.updateMany({
      where: { id: CURRENT_ID, status: { in: ACTIVE }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
      data: { leaseUntil: lease },
    })
    if (!claimed.count) return
    try {
      const job = await this.prisma.monitorJob.findUniqueOrThrow({ where: { id: CURRENT_ID } })
      const ctx = this.context(job)
      await this.reconcile(ctx)
      // Stop discovery left by an earlier app version, retaining its receipts.
      if (ctx.childId) {
        await this.prisma.monitorJob.updateMany({ where: { id: ctx.childId, status: { in: ['QUEUED', 'RUNNING'] } },
          data: { status: 'CANCELLED', leaseUntil: null, finishedAt: new Date() } })
        ctx.childId = null
      }
      const checking = ctx.items.filter(item => item.status === 'CHECKING')
      if (checking.length) {
        const snapshot = await this.snapshot(this.prisma)
        const rows = new Map(snapshot.items.map(row => [row.productId, row]))
        for (const item of checking) {
          const row = rows.get(item.productId)
          item.status = row && !row.blockedReasons.length ? 'READY' : 'SKIPPED'
          item.reason = row ? row.blockedReasons.join('; ') || null : 'Нет новой проверенной цены'
          if (row) { item.oldPrice = row.oldPrice ?? item.oldPrice; item.newPrice = row.newPrice; item.linkId = row.id }
        }
      }

      // Wait for the current 1C session and pending messages before staging.
      // Existing permissions are retained throughout the operation.
      if (ctx.items.some(item => item.status === 'READY') && !ctx.readySince) ctx.readySince = new Date().toISOString()
      const mayStage = ctx.items.filter(item => item.status === 'READY').length >= 30
        || !ctx.items.some(item => item.status === 'CHECKING')
        || !!ctx.readySince && Date.now() - Date.parse(ctx.readySince) >= 30000
      await this.prisma.$transaction(async tx => {
        const active = await tx.monitorJob.findFirst({ where: { id: CURRENT_ID, status: { in: ACTIVE }, leaseUntil: lease } })
        if (!active) return // cancellation or a newer lease won
        const agent = await tx.syncLog.findUnique({ where: { id: 'onec-agent-status' } })
        const agentState = agent?.payload as { state?: string } | null
        const agentStillRunning = agentState?.state === 'processing' && !!agent && Date.now() - agent.createdAt.getTime() < 5 * 60000
        if (mayStage && !agentStillRunning && !await tx.oneCPriceChange.count({ where: { status: 'PENDING' } })) {
          const candidates = ctx.items.filter(item => item.status === 'READY').slice(0, 30)
          if (candidates.length) {
            const snapshot = await this.snapshot(tx)
            const rows = new Map(snapshot.items.flatMap(row => row.productId === null ? [] : [[row.productId, row] as const]))
            const safe = candidates.filter(item => {
              const row = rows.get(item.productId)
              const reasons = row?.blockedReasons || []
              if (!row || reasons.length) { item.status = 'SKIPPED'; item.reason = row ? reasons.join('; ') : UNCHANGED; return false }
              item.oldPrice = row.oldPrice ?? item.oldPrice; item.newPrice = row.newPrice; item.linkId = row.id
              return true
            })
            if (safe.length) {
              const ids = safe.map(item => item.productId)
              for (const item of safe) {
                const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId } })
                const message = await OneCPriceSyncService.queue(tx, product, item.newPrice!, item.linkId)
                if (!message) throw new Error('Не удалось подготовить область обмена с TEST')
                item.messageId = message.id; item.status = 'PENDING'; item.reason = null
              }
              await tx.auditLog.create({ data: { action: 'QUEUE_TEST_PRICE_UPDATE', entity: 'PriceUpdate', entityId: ctx.id,
                details: { productIds: ids, queued: safe.length, limit: 30, source: '05ru', sitePublished: false } } })
              delete ctx.readySince
            }
          }
        }
        const checking = ctx.items.some(item => item.status === 'CHECKING')
        const pending = ctx.items.some(item => item.status === 'PENDING')
        const ready = ctx.items.some(item => item.status === 'READY')
        const problems = ctx.items.some(item => item.status === 'FAILED' || item.status === 'SKIPPED' && item.reason !== UNCHANGED)
        const state = checking ? 'CHECKING' : pending || ready ? 'WAITING' : problems ? 'PARTIAL' : 'COMPLETED'
        await tx.monitorJob.updateMany({ where: { id: CURRENT_ID, status: { in: ACTIVE }, leaseUntil: lease },
          data: { status: state, visitedUrls: json(ctx), processed: ctx.items.filter(item => item.status !== 'CHECKING').length,
            errors: ctx.items.filter(item => item.status === 'FAILED').length,
            finishedAt: ACTIVE.includes(state) ? null : new Date(), lastError: null },
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30000 })
    } finally {
      await this.prisma.monitorJob.updateMany({ where: { id: CURRENT_ID, leaseUntil: lease }, data: { leaseUntil: null } })
    }
  }
}
