import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PaymentStatus, Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  getStatus() {
    const provider = this.config.get<string>('PAYMENT_PROVIDER') ?? 'mock'
    const mockEnabled = this.config.get<string>('ALLOW_DEV_PAYMENT') === 'true'
    return {
      provider,
      configured: provider === 'mock' ? mockEnabled : false,
      mode: provider === 'mock' ? 'development' : 'adapter-ready',
      message: provider === 'mock'
        ? (mockEnabled ? 'DEV-оплата включена. Не использовать в production.' : 'DEV-оплата выключена.')
        : 'Платёжный адаптер готов к подключению конкретного провайдера.',
    }
  }

  async createSession(trackingToken: string) {
    const order = await this.prisma.order.findUnique({ where: { trackingToken }, include: { payments: true } })
    if (!order) throw new NotFoundException('Заказ не найден')
    if (order.paymentMethod !== 'ONLINE') throw new BadRequestException('Для заказа выбрана оплата при получении')
    if (order.paymentStatus === PaymentStatus.PAID) return { paid: true, orderNumber: order.number }

    const provider = this.config.get<string>('PAYMENT_PROVIDER') ?? 'mock'
    if (provider !== 'mock') {
      throw new ServiceUnavailableException('Платёжный провайдер ещё не настроен')
    }
    if (this.config.get<string>('ALLOW_DEV_PAYMENT') !== 'true') {
      throw new ServiceUnavailableException('DEV-оплата выключена')
    }

    const existing = order.payments.find((item) => item.provider === 'mock' && item.status === PaymentStatus.PENDING)
    const payment = existing ?? await this.prisma.payment.create({
      data: {
        orderId: order.id,
        provider: 'mock',
        externalId: `mock_${randomUUID()}`,
        amount: order.total,
        status: PaymentStatus.PENDING,
        payload: { mode: 'development' },
      },
    })

    const frontend = this.config.get<string>('FRONTEND_PUBLIC_URL') ?? 'http://127.0.0.1:5173'
    return {
      paid: false,
      provider: 'mock',
      paymentId: payment.id,
      checkoutUrl: `${frontend}/payment/mock/${payment.id}?token=${encodeURIComponent(trackingToken)}`,
    }
  }

  async completeMock(paymentId: string, trackingToken: string) {
    if (this.config.get<string>('ALLOW_DEV_PAYMENT') !== 'true') {
      throw new ServiceUnavailableException('DEV-оплата выключена')
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { order: true } })
      if (!payment || payment.provider !== 'mock' || payment.order.trackingToken !== trackingToken) {
        throw new NotFoundException('Платёж не найден')
      }
      if (payment.status === PaymentStatus.PAID) return payment

      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.PAID, payload: { mode: 'development', completedAt: new Date().toISOString() } },
      })
      await tx.order.update({
        where: { id: payment.orderId },
        data: { paymentStatus: PaymentStatus.PAID, status: 'PAID' },
      })
      return updated
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: result.orderId } })
    await this.notifications.create('PAYMENT_PAID', `Оплачен заказ №${order.number}`, `${order.customerName} · ${order.total} ₽`, { orderId: order.id })
    return { ok: true, orderNumber: order.number, trackingToken: order.trackingToken }
  }
}
