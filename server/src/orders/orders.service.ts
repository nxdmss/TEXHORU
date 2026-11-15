import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client'
import { AuditService } from '../audit/audit.service'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'
import { CreateOrderDto } from './orders.dto'
import { OrderOperationsService } from './order-operations.service'

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly operations?: OrderOperationsService,
  ) {}

  async create(dto: CreateOrderDto, userId?: string) {
    const existing = await this.prisma.order.findUnique({ where: { idempotencyKey: dto.idempotencyKey }, include: { items: true } })
    if (existing) return existing
    if (!dto.items.length) throw new BadRequestException('Корзина пуста')
    if (dto.paymentMethod === 'ONLINE' && process.env.ONLINE_PAYMENTS_ENABLED !== 'true') {
      throw new BadRequestException('Онлайн-оплата пока выключена. Выберите оплату при получении.')
    }
    const account = userId && !dto.customerEmail ? await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } }) : null
    const customerEmail = dto.customerEmail || (account?.emailVerifiedAt ? account.email : undefined)
    const configuredMinutes = Number(process.env.ORDER_RESERVATION_MINUTES || 1440)
    const reservationMinutes = Number.isFinite(configuredMinutes) ? Math.min(10080, Math.max(15, Math.round(configuredMinutes))) : 1440
    const reservationExpiresAt = new Date(Date.now() + reservationMinutes * 60000)

    const order = await this.prisma.$transaction(async (tx) => {
      const ids = [...new Set(dto.items.map((item) => item.productId))]
      const products = await tx.product.findMany({ where: { id: { in: ids }, status: 'ACTIVE' } })
      if (products.length !== ids.length) throw new BadRequestException('Один из товаров недоступен')

      const rows = dto.items.map((item) => {
        const product = products.find((candidate) => candidate.id === item.productId)!
        const available = Math.max(0, product.stockQty - product.reservedQty)
        if (product.stockState !== 'PREORDER' && available < item.quantity) {
          throw new BadRequestException(`${product.name}: доступно ${available} шт.`)
        }
        return { productId: product.id, sku: product.sku, name: product.name, price: product.price, quantity: item.quantity }
      })
      const total = rows.reduce((sum, item) => sum + item.price * item.quantity, 0)
      const status = dto.paymentMethod === 'ONLINE' ? OrderStatus.AWAITING_PAYMENT : OrderStatus.NEW

      const created = await tx.order.create({
        data: {
          userId,
          idempotencyKey: dto.idempotencyKey,
          customerName: dto.customerName,
          customerPhone: dto.customerPhone,
          customerEmail,
          deliveryMethod: dto.deliveryMethod,
          deliveryAddress: dto.deliveryAddress,
          paymentMethod: dto.paymentMethod,
          comment: dto.comment,
          status,
          paymentStatus: PaymentStatus.NOT_STARTED,
          reservationExpiresAt,
          total,
          items: { create: rows },
        },
        include: { items: true },
      })
      await tx.integrationCommand.create({
        data: {
          dedupeKey: `order:create:${created.id}`,
          kind: 'ORDER_CREATE',
          entity: 'ORDER',
          entityId: created.id,
          status: 'WAITING_APPROVAL',
          requiresApproval: true,
          payload: {
            schemaVersion: 1,
            orderId: created.id,
            number: created.number,
            customer: { name: created.customerName, phone: created.customerPhone, email: created.customerEmail || null },
            delivery: { method: created.deliveryMethod, address: created.deliveryAddress },
            paymentMethod: created.paymentMethod,
            comment: created.comment || null,
            total: created.total,
            items: rows.map(item => ({ oneCProductId: products.find(product => product.id === item.productId)?.oneCId || null, sku: item.sku, name: item.name, price: item.price, quantity: item.quantity })),
          },
        },
      })
      if (customerEmail) await tx.customerMessage.create({
        data: { dedupeKey: `order:created:${created.id}`, orderId: created.id, kind: 'ORDER_CREATED', payload: { status: created.status } },
      })
      for (const item of rows) {
        await tx.product.update({ where: { id: item.productId }, data: { reservedQty: { increment: item.quantity } } })
      }
      return created
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    await this.notifications.create('NEW_ORDER', `Новый заказ №${order.number}`, `${order.customerName} · ${order.total} ₽ · резерв до ${reservationExpiresAt.toLocaleString('ru-RU')}`, { orderId: order.id })
    await this.audit.log(userId, 'CREATE_ORDER', 'Order', order.id, { number: order.number, total: order.total, oneCCommand: 'WAITING_APPROVAL', reservationExpiresAt: reservationExpiresAt.toISOString() })
    this.operations?.wake()
    return order
  }

  async track(trackingToken: string) {
    const order = await this.prisma.order.findUnique({ where: { trackingToken }, include: { items: true } })
    if (!order) throw new NotFoundException('Заказ не найден')
    return {
      number: order.number,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      deliveryMethod: order.deliveryMethod,
      total: order.total,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      reservationExpiresAt: order.reservationExpiresAt,
      stockVerification: order.stockVerifiedAt ? 'VERIFIED' : order.status === 'CANCELLED' ? 'RELEASED' : 'AWAITING_MANAGER',
      items: order.items.map((item) => ({ name: item.name, quantity: item.quantity, price: item.price })),
    }
  }

  customerList(userId: string) { return this.prisma.order.findMany({ where: { userId }, select: { number: true, trackingToken: true, status: true, paymentStatus: true, total: true, deliveryMethod: true, deliveryAddress: true, createdAt: true, items: { select: { name: true, quantity: true, price: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }) }

  adminList() { return this.prisma.order.findMany({ include: { items: true, payments: true }, orderBy: { createdAt: 'desc' }, take: 200 }) }

  async businessReadiness() {
    const [products, integration, commands, orderOperations] = await Promise.all([
      this.prisma.product.findMany({ select: { oneCId: true, importVariantKey: true, status: true, image: true, description: true, shortSpec: true, specs: true, price: true, stockQty: true, reservedQty: true } }),
      this.prisma.oneCIntegrationSettings.upsert({ where: { id: 'primary' }, create: { id: 'primary' }, update: {} }),
      this.prisma.integrationCommand.groupBy({ by: ['status'], _count: { _all: true } }),
      this.operations?.summary() ?? Promise.resolve({ emailConfigured: false, messages: {}, pendingReservations: 0, reservationMinutes: 1440 }),
    ])
    const active = products.filter(product => product.status === 'ACTIVE')
    const variantCounts = new Map<string, number>()
    for (const product of products) if (product.importVariantKey && product.importVariantKey !== '-') variantCounts.set(product.importVariantKey, (variantCounts.get(product.importVariantKey) || 0) + 1)
    const emptySpecs = (value: unknown) => !Array.isArray(value) || value.length === 0
    return {
      launchMode: 'PRELAUNCH',
      payments: { enabled: process.env.ONLINE_PAYMENTS_ENABLED === 'true', mode: 'ON_RECEIPT' },
      oneC: {
        mode: integration.mode,
        orderWritesEnabled: process.env.ONE_C_ORDER_WRITES_ENABLED === 'true' && integration.mode === 'ENABLED' && integration.allowOrderWrites,
        priceWritesEnabled: (process.env.ONE_C_BASE_KIND === 'TEST' && process.env.ONE_C_TEST_PRICE_SYNC_ENABLED === 'true')
          || (process.env.ONE_C_BASE_KIND === 'PRODUCTION' && process.env.ONE_C_PRODUCTION_PRICE_SYNC_ENABLED === 'true'),
        catalogReadEnabled: integration.allowCatalogRead,
      },
      catalog: {
        total: products.length,
        active: active.length,
        available: active.filter(product => product.price > 0 && product.stockQty > product.reservedQty).length,
        fromOneC: products.filter(product => Boolean(product.oneCId)).length,
        missingImage: active.filter(product => !product.image || product.image === '/products/phone.svg').length,
        missingDescription: active.filter(product => !product.description.trim() || !product.shortSpec.trim()).length,
        missingSpecs: active.filter(product => emptySpecs(product.specs)).length,
        duplicates: [...variantCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
      },
      orders: {
        ...orderOperations,
        commands: Object.fromEntries(commands.map(row => [row.status, row._count._all])),
      },
    }
  }

  async updateStatus(id: string, status: OrderStatus, userId?: string) {
    const order = await this.prisma.$transaction(async (tx) => {
      const current = await tx.order.findUniqueOrThrow({ where: { id }, include: { items: true } })
      if (current.status === status) return current
      const transitions: Record<OrderStatus, OrderStatus[]> = {
        NEW: [OrderStatus.AWAITING_PAYMENT, OrderStatus.PAID, OrderStatus.ASSEMBLING, OrderStatus.CANCELLED],
        AWAITING_PAYMENT: [OrderStatus.PAID, OrderStatus.CANCELLED],
        PAID: [OrderStatus.ASSEMBLING, OrderStatus.READY, OrderStatus.CANCELLED],
        ASSEMBLING: [OrderStatus.READY, OrderStatus.CANCELLED],
        READY: [OrderStatus.DELIVERING, OrderStatus.COMPLETED, OrderStatus.CANCELLED],
        DELIVERING: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
        COMPLETED: [],
        CANCELLED: [],
      }
      if (!transitions[current.status].includes(status)) throw new BadRequestException(`Недопустимый переход заказа: ${current.status} → ${status}`)
      const shouldRelease = ['CANCELLED', 'COMPLETED'].includes(status) && !current.reservationReleasedAt
      if (shouldRelease) {
        for (const item of current.items) {
          const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId }, select: { reservedQty: true } })
          await tx.product.update({ where: { id: item.productId }, data: { reservedQty: Math.max(0, product.reservedQty - item.quantity) } })
        }
      }
      const updated = await tx.order.update({ where: { id }, data: {
        status,
        reservationReleasedAt: shouldRelease ? new Date() : current.reservationReleasedAt,
        reservationExpiresAt: ['ASSEMBLING', 'READY', 'DELIVERING', 'COMPLETED'].includes(status) ? null : current.reservationExpiresAt,
        stockVerifiedAt: ['ASSEMBLING', 'READY', 'DELIVERING', 'COMPLETED'].includes(status) ? current.stockVerifiedAt || new Date() : current.stockVerifiedAt,
      }, include: { items: true } })
      if (updated.customerEmail) {
        await tx.customerMessage.updateMany({
          where: { orderId: id, status: { in: ['PENDING', 'FAILED'] }, ...(status === 'CANCELLED' ? {} : { kind: 'STATUS_CHANGED' }) },
          data: { status: 'CANCELLED', lastError: 'SUPERSEDED' },
        })
        await tx.customerMessage.upsert({
          where: { dedupeKey: `order:status:${id}:${status}` },
          create: { dedupeKey: `order:status:${id}:${status}`, orderId: id, kind: 'STATUS_CHANGED', payload: { status } },
          update: {},
        })
      }
      return updated
    })
    await this.notifications.create('ORDER_STATUS', `Заказ №${order.number}`, `Статус изменён: ${status}`, { orderId: id })
    await this.audit.log(userId, 'UPDATE_ORDER_STATUS', 'Order', id, { number: order.number, status })
    if (userId) await this.prisma.integrationCommand.upsert({
      where: { dedupeKey: `order:status:${id}:${status}` },
      create: { dedupeKey: `order:status:${id}:${status}`, kind: 'ORDER_STATUS', entity: 'ORDER', entityId: id, status: 'WAITING_APPROVAL', requiresApproval: true, payload: { schemaVersion: 1, orderId: id, number: order.number, status } },
      update: {},
    })
    this.operations?.wake()
    return order
  }
}
