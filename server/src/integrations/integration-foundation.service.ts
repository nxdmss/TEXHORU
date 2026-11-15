import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { AuditService } from '../audit/audit.service'
import { PrismaService } from '../prisma/prisma.service'
import { IntegrationCommandActionDto, UpdateIntegrationPolicyDto } from './integration-foundation.dto'

const SETTINGS_ID = 'primary'

@Injectable()
export class IntegrationFoundationService {
  constructor(private readonly db: PrismaService, private readonly audit: AuditService) {}

  settings() {
    return this.db.oneCIntegrationSettings.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID }, update: {} })
  }

  async dashboard() {
    const [settings, devices, commandCounts, eventCounts, commands, events] = await Promise.all([
      this.settings(),
      this.db.oneCAgentDevice.findMany({ orderBy: { lastSeenAt: 'desc' }, take: 50 }),
      this.db.integrationCommand.groupBy({ by: ['status'], _count: { _all: true } }),
      this.db.integrationEvent.groupBy({ by: ['status'], _count: { _all: true } }),
      this.db.integrationCommand.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
      this.db.integrationEvent.findMany({ orderBy: { receivedAt: 'desc' }, take: 100 }),
    ])
    return {
      settings,
      serverKillSwitches: {
        orderWrites: process.env.ONE_C_ORDER_WRITES_ENABLED === 'true',
        priceWrites: process.env.ONE_C_PRODUCTION_PRICE_SYNC_ENABLED === 'true' || process.env.ONE_C_TEST_PRICE_SYNC_ENABLED === 'true',
        policyChanges: process.env.ONE_C_ALLOW_WRITE_CONFIGURATION === 'true',
      },
      devices,
      commandCounts: Object.fromEntries(commandCounts.map(row => [row.status, row._count._all])),
      eventCounts: Object.fromEntries(eventCounts.map(row => [row.status, row._count._all])),
      commands,
      events,
    }
  }

  async updatePolicy(dto: UpdateIntegrationPolicyDto, userId: string) {
    const current = await this.settings()
    const next = { ...current, ...dto }
    const requestsWrites = next.mode === 'ENABLED' || next.allowOrderWrites || next.allowPriceWrites
    if (requestsWrites) {
      if (process.env.ONE_C_ALLOW_WRITE_CONFIGURATION !== 'true') {
        throw new ForbiddenException('Серверный рубильник изменения 1С выключен')
      }
      if (dto.confirmation !== 'ENABLE_1C_WRITES') throw new BadRequestException('Нужно явное подтверждение ENABLE_1C_WRITES')
    }
    const data = {
      mode: dto.mode ?? current.mode,
      requireSignedRequests: dto.requireSignedRequests ?? current.requireSignedRequests,
      allowCatalogRead: dto.allowCatalogRead ?? current.allowCatalogRead,
      allowOrderWrites: dto.allowOrderWrites ?? current.allowOrderWrites,
      allowPriceWrites: dto.allowPriceWrites ?? current.allowPriceWrites,
      allowOrderStatusRead: dto.allowOrderStatusRead ?? current.allowOrderStatusRead,
      updatedBy: userId,
    }
    if (data.mode === 'READ_ONLY' && (data.allowOrderWrites || data.allowPriceWrites)) {
      throw new BadRequestException('В режиме READ_ONLY исходящие записи должны быть выключены')
    }
    const updated = await this.db.oneCIntegrationSettings.update({ where: { id: SETTINGS_ID }, data })
    await this.audit.log(userId, 'ONEC_POLICY_UPDATE', 'OneCIntegrationSettings', SETTINGS_ID, {
      mode: updated.mode, requireSignedRequests: updated.requireSignedRequests, allowCatalogRead: updated.allowCatalogRead,
      allowOrderWrites: updated.allowOrderWrites, allowPriceWrites: updated.allowPriceWrites, allowOrderStatusRead: updated.allowOrderStatusRead,
    })
    return updated
  }

  async commandAction(id: string, dto: IntegrationCommandActionDto, userId: string) {
    const command = await this.db.integrationCommand.findUnique({ where: { id } })
    if (!command) throw new NotFoundException('Задание обмена не найдено')
    let data: Prisma.IntegrationCommandUpdateInput
    if (dto.action === 'approve') {
      if (!['WAITING_APPROVAL', 'FAILED'].includes(command.status)) throw new ConflictException('Задание уже обработано')
      data = { status: 'APPROVED', approvedBy: userId, approvedAt: new Date(), lastError: null, availableAt: new Date() }
    } else if (dto.action === 'cancel') {
      if (['SUCCEEDED', 'CANCELLED'].includes(command.status)) throw new ConflictException('Задание уже завершено')
      data = { status: 'CANCELLED', leaseToken: null, leaseUntil: null, completedAt: new Date(), lastError: dto.reason || null }
    } else {
      if (command.status !== 'FAILED') throw new ConflictException('Повтор возможен только после ошибки')
      data = { status: command.requiresApproval ? 'WAITING_APPROVAL' : 'APPROVED', leaseToken: null, leaseUntil: null, lastError: null, availableAt: new Date(), completedAt: null }
    }
    const updated = await this.db.integrationCommand.update({ where: { id }, data })
    await this.audit.log(userId, `ONEC_COMMAND_${dto.action.toUpperCase()}`, 'IntegrationCommand', id, { kind: command.kind, entity: command.entity, entityId: command.entityId, reason: dto.reason })
    return updated
  }

  async assertOrderDeliveryEnabled() {
    const settings = await this.settings()
    if (process.env.ONE_C_ORDER_WRITES_ENABLED !== 'true' || settings.mode !== 'ENABLED' || !settings.allowOrderWrites) {
      throw new ForbiddenException('Передача заказов в 1С выключена. Задания остаются в безопасной очереди.')
    }
    return settings
  }

  async approvedOrderIds() {
    await this.assertOrderDeliveryEnabled()
    const rows = await this.db.integrationCommand.findMany({
      where: { kind: 'ORDER_CREATE', entity: 'ORDER', status: 'APPROVED', availableAt: { lte: new Date() } },
      select: { entityId: true }, orderBy: { createdAt: 'asc' }, take: 100,
    })
    return rows.map(row => row.entityId).filter((id): id is string => Boolean(id))
  }

  async completeOrderCommand(orderId: string, externalId: string) {
    await this.db.integrationCommand.updateMany({ where: { kind: 'ORDER_CREATE', entity: 'ORDER', entityId: orderId, status: { in: ['APPROVED', 'LEASED'] } }, data: { status: 'SUCCEEDED', externalId, completedAt: new Date(), leaseToken: null, leaseUntil: null } })
  }

  async beginEvent(input: { idempotencyKey: string; source: string; kind: string; entity: string; entityId?: string; payloadHash: string; payload: Prisma.InputJsonValue }) {
    try { return { duplicate: false, event: await this.db.integrationEvent.create({ data: input }) } }
    catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error
      return { duplicate: true, event: await this.db.integrationEvent.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } }) }
    }
  }

  finishEvent(id: string, status: 'PROCESSED' | 'FAILED', error?: string) {
    return this.db.integrationEvent.update({ where: { id }, data: { status, error: error || null, processedAt: new Date() } })
  }
}
