import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AuditService } from '../audit/audit.service'
import { AccountMailService } from '../auth/account-mail.service'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'
import { orderEmail } from './order-email'

@Injectable()
export class OrderOperationsService implements OnModuleInit, OnModuleDestroy {
  private first?: NodeJS.Timeout
  private timer?: NodeJS.Timeout
  private running = false

  constructor(
    private readonly db: PrismaService,
    private readonly mail: AccountMailService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (this.config.get('NODE_ENV') === 'test' || this.config.get('ORDER_OPERATIONS_WORKER_DISABLED') === 'true') return
    this.first = setTimeout(() => void this.tick(), 1500); this.first.unref()
    this.timer = setInterval(() => void this.tick(), 15000); this.timer.unref()
  }

  wake() {
    if (this.config.get('NODE_ENV') !== 'test' && this.config.get('ORDER_OPERATIONS_WORKER_DISABLED') !== 'true') {
      setTimeout(() => void this.tick(), 0).unref()
    }
  }

  async summary() {
    const [messageCounts, pendingReservations] = await Promise.all([
      this.db.customerMessage.groupBy({ by: ['status'], _count: { _all: true } }),
      this.db.order.count({ where: { status: { in: ['NEW', 'AWAITING_PAYMENT'] }, reservationReleasedAt: null } }),
    ])
    return {
      emailConfigured: this.mail.configured(),
      messages: Object.fromEntries(messageCounts.map(row => [row.status, row._count._all])),
      pendingReservations,
      reservationMinutes: Math.min(10080, Math.max(15, Number(this.config.get('ORDER_RESERVATION_MINUTES') || 1440) || 1440)),
    }
  }

  async tick(now = new Date()) {
    if (this.running) return
    this.running = true
    try {
      await this.recoverInterruptedMessages(now)
      await this.expireReservations(now)
      await this.deliverMessages(now)
    } catch (error) {
      console.error('Order operations failed:', error instanceof Error ? error.message : 'unknown error')
    } finally { this.running = false }
  }

  private async recoverInterruptedMessages(now: Date) {
    await this.db.customerMessage.updateMany({
      where: { status: 'SENDING', updatedAt: { lt: new Date(now.getTime() - 5 * 60000) } },
      data: { status: 'FAILED', lastError: 'DELIVERY_INTERRUPTED', availableAt: now },
    })
  }

  private async expireReservations(now: Date) {
    const due = await this.db.order.findMany({
      where: { status: { in: ['NEW', 'AWAITING_PAYMENT'] }, reservationReleasedAt: null, reservationExpiresAt: { lte: now } },
      select: { id: true }, orderBy: { reservationExpiresAt: 'asc' }, take: 50,
    })
    for (const candidate of due) {
      const expired = await this.db.$transaction(async tx => {
        const order = await tx.order.findUnique({ where: { id: candidate.id }, include: { items: true } })
        if (!order || order.reservationReleasedAt || !['NEW', 'AWAITING_PAYMENT'].includes(order.status) || !order.reservationExpiresAt || order.reservationExpiresAt > now) return null
        const claimed = await tx.order.updateMany({
          where: { id: order.id, status: { in: ['NEW', 'AWAITING_PAYMENT'] }, reservationReleasedAt: null },
          data: { status: 'CANCELLED', reservationReleasedAt: now },
        })
        if (!claimed.count) return null
        for (const item of order.items) {
          const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId }, select: { reservedQty: true } })
          await tx.product.update({ where: { id: item.productId }, data: { reservedQty: Math.max(0, product.reservedQty - item.quantity) } })
        }
        await tx.integrationCommand.updateMany({
          where: { entity: 'ORDER', entityId: order.id, status: { in: ['WAITING_APPROVAL', 'APPROVED', 'LEASED'] } },
          data: { status: 'CANCELLED', completedAt: now, leaseToken: null, leaseUntil: null, lastError: 'RESERVATION_EXPIRED' },
        })
        if (order.customerEmail) {
          await tx.customerMessage.updateMany({ where: { orderId: order.id, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'CANCELLED', lastError: 'SUPERSEDED' } })
          await tx.customerMessage.upsert({
            where: { dedupeKey: `order:expired:${order.id}` },
            create: { dedupeKey: `order:expired:${order.id}`, orderId: order.id, kind: 'RESERVATION_EXPIRED', payload: { status: 'CANCELLED' } },
            update: {},
          })
        }
        return order
      })
      if (!expired) continue
      await this.notifications.create('ORDER_RESERVATION_EXPIRED', `Резерв заказа №${expired.number} закончился`, 'Заказ отменён автоматически, товары возвращены в доступный остаток.', { orderId: expired.id })
      await this.audit.log(undefined, 'EXPIRE_ORDER_RESERVATION', 'Order', expired.id, { number: expired.number })
    }
  }

  private async deliverMessages(now: Date) {
    if (!this.mail.configured()) return
    const messages = await this.db.customerMessage.findMany({
      where: { status: { in: ['PENDING', 'FAILED'] }, availableAt: { lte: now } },
      include: { order: { include: { items: true } } }, orderBy: { createdAt: 'asc' }, take: 20,
    })
    for (const message of messages) {
      if (message.attempts >= message.maxAttempts || !message.order.customerEmail) continue
      const claimed = await this.db.customerMessage.updateMany({
        where: { id: message.id, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'SENDING', attempts: { increment: 1 }, lastError: null },
      })
      if (!claimed.count) continue
      const payload = message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload) ? message.payload as Record<string, unknown> : {}
      const status = typeof payload.status === 'string' ? payload.status : message.order.status
      try {
        const content = orderEmail(message.order, message.kind, status, this.config.get<string>('FRONTEND_PUBLIC_URL') || 'http://127.0.0.1:5173')
        await this.mail.sendContent(message.order.customerEmail, content)
        await this.db.customerMessage.update({ where: { id: message.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null } })
      } catch {
        const attempts = message.attempts + 1
        const finalFailure = attempts >= message.maxAttempts
        await this.db.customerMessage.update({ where: { id: message.id }, data: {
          status: 'FAILED', lastError: 'DELIVERY_FAILED', availableAt: new Date(Date.now() + Math.min(60, 2 ** attempts) * 60000),
        } })
        if (finalFailure) await this.notifications.create('ORDER_EMAIL_FAILED', `Не отправлено письмо по заказу №${message.order.number}`, 'Заказ сохранён. Проверьте SMTP и свяжитесь с покупателем вручную.', { orderId: message.order.id, messageId: message.id })
      }
    }
  }

  onModuleDestroy() { clearTimeout(this.first); clearInterval(this.timer) }
}
