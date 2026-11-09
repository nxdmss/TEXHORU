import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'

/** Bounded cleanup of operational data, never catalog, users, orders, prices,
 * unresolved errors or 1C receipts. Keep the newest two price observations per link. */
export async function pruneOperationalData(db: PrismaService, now = new Date(), days = 30, batch = 500) {
  if (!Number.isInteger(days) || days < 7 || days > 365 || !Number.isInteger(batch) || batch < 1 || batch > 1000) {
    throw new Error('Invalid retention bounds')
  }
  const cutoff = new Date(now.getTime() - days * 86400_000)
  return db.$transaction(async tx => {
    const jobs = await tx.monitorJob.findMany({ where: { id: { not: 'test-price-update-current' },
      status: { in: ['COMPLETED', 'CANCELLED'] }, finishedAt: { lt: cutoff } }, select: { id: true }, take: batch })
    const logs = await tx.syncLog.findMany({ where: { id: { not: 'onec-agent-status' }, status: 'SUCCESS', createdAt: { lt: cutoff } }, select: { id: true }, take: batch })
    const notifications = await tx.notification.findMany({ where: { isRead: true, createdAt: { lt: cutoff } }, select: { id: true }, take: batch })
    const deliveries = await tx.monitorDelivery.findMany({ where: { status: { in: ['DELIVERED', 'CANCELLED'] }, createdAt: { lt: cutoff } }, select: { id: true }, take: batch })
    const index = await tx.competitorCatalogEntry.findMany({ where: { lastSeenAt: { lt: cutoff } }, select: { id: true }, take: batch })
    const remove = (rows: Array<{ id: string }>) => ({ id: { in: rows.map(row => row.id) } })
    await tx.monitorJob.deleteMany({ where: remove(jobs) })
    await tx.syncLog.deleteMany({ where: remove(logs) })
    await tx.notification.deleteMany({ where: remove(notifications) })
    await tx.monitorDelivery.deleteMany({ where: remove(deliveries) })
    await tx.competitorCatalogEntry.deleteMany({ where: remove(index) })
    // EXISTS avoids collecting every catalog ID into memory/SQLite parameters.
    const history = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT h.id FROM "CompetitorPriceHistory" h
      WHERE h."createdAt" < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM "MonitorDelivery" d WHERE d."historyId" = h.id)
        AND (SELECT COUNT(*) FROM "CompetitorPriceHistory" n
          WHERE n."competitorProductId" = h."competitorProductId"
            AND (n."checkedAt" > h."checkedAt" OR (n."checkedAt" = h."checkedAt" AND n.id > h.id))) >= 2
      LIMIT ${batch}`)
    await tx.competitorPriceHistory.deleteMany({ where: remove(history) })
    // Audit rejection records affect future proposals; never remove them here.
    // OneCPriceChange IDs remain available for receipt deduplication/recovery.
    return { jobs: jobs.length, logs: logs.length, notifications: notifications.length,
      deliveries: deliveries.length, index: index.length, history: history.length }
  }, { timeout: 15000 })
}

@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private first?: NodeJS.Timeout
  private timer?: NodeJS.Timeout
  private running = false
  constructor(private readonly db: PrismaService) {}
  onModuleInit() {
    if (process.env.DATA_RETENTION_ENABLED !== 'true') return
    const run = () => { void this.clean() }
    this.first = setTimeout(run, 5 * 60000); this.first.unref()
    this.timer = setInterval(run, 86400_000); this.timer.unref()
  }
  async clean() {
    if (this.running) return
    this.running = true
    try {
      // Give the only worker/SQLite writer priority; retry at the next interval.
      if (await this.db.monitorJob.count({ where: { status: { in: ['QUEUED', 'RUNNING', 'CHECKING', 'QUEUING', 'WAITING'] } } })) return
      const days = Number(process.env.DATA_RETENTION_DAYS || 30)
      const result = await pruneOperationalData(this.db, new Date(), days)
      if (Object.values(result).some(Boolean)) console.log('Operational cleanup:', result)
    } catch (error) { console.error('Operational cleanup failed:', error instanceof Error ? error.message : 'unknown error') }
    finally { this.running = false }
  }
  onModuleDestroy() { clearTimeout(this.first); clearInterval(this.timer) }
}
