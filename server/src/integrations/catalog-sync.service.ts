import { BadRequestException, ConflictException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { IntegrationsService } from './integrations.service'
import { CatalogSyncBatchDto, StartCatalogSyncDto } from './catalog-sync.dto'

@Injectable()
export class CatalogSyncService {
  constructor(private readonly db: PrismaService, private readonly integrations: IntegrationsService) {}
  async start(dto: StartCatalogSyncDto) {
    if (!dto.clientId.trim()) throw new BadRequestException('Укажите идентификатор базы')
    try {
      return await this.db.$transaction(async tx => {
        const existing = await tx.catalogImportSession.findUnique({ where: { id: dto.sessionId } })
        if (existing) {
          if (existing.clientId !== dto.clientId || existing.mode !== dto.mode) throw new ConflictException('Сеанс принадлежит другой выгрузке')
          return this.view(existing)
        }
        await tx.catalogImportSession.updateMany({ where: { activeKey: 'catalog', updatedAt: { lt: new Date(Date.now() - 86400000) } }, data: { activeKey: null, status: 'EXPIRED', finishedAt: new Date() } })
        const row = await tx.catalogImportSession.create({ data: { id: dto.sessionId, clientId: dto.clientId, mode: dto.mode, activeKey: 'catalog' } })
        return this.view(row)
      })
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('Выгрузка уже идёт. Продолжите текущий сеанс или отмените его в управлении магазином.')
      throw error
    }
  }
  async batch(id: string, dto: CatalogSyncBatchDto) {
    const { batch, ...catalog } = dto
    if (catalog.categories.length > 100) throw new BadRequestException('Не более 100 категорий в пакете')
    const serialized = JSON.stringify(catalog)
    if (Buffer.byteLength(serialized) > 512 * 1024) throw new PayloadTooLargeException('Пакет должен быть меньше 512 КБ; изображения отправляются отдельно')
    const result = await this.integrations.importCatalog(catalog, { sessionId: id, batch, hash: createHash('sha256').update(serialized).digest('hex') })
    return { ...result, nextBatch: batch + 1, pauseMs: 1000 }
  }
  async finish(id: string) {
    const row = await this.db.catalogImportSession.findUnique({ where: { id } })
    if (!row) throw new NotFoundException('Сеанс не найден')
    if (row.status === 'COMPLETED') return this.view(row)
    const changed = await this.db.catalogImportSession.updateMany({ where: { id, status: 'RUNNING' }, data: { status: 'COMPLETED', activeKey: null, finishedAt: new Date() } })
    if (!changed.count) throw new ConflictException('Сеанс уже закрыт')
    return this.view(await this.db.catalogImportSession.findUniqueOrThrow({ where: { id } }))
  }
  async cancel(id: string) {
    await this.db.catalogImportSession.updateMany({ where: { id, status: 'RUNNING' }, data: { status: 'CANCELLED', activeKey: null, finishedAt: new Date() } })
    return { ok: true }
  }
  async status() {
    const row = await this.db.catalogImportSession.findFirst({ orderBy: { updatedAt: 'desc' } })
    return { session: row ? this.view(row) : null, batchSize: 50, maxBatchSize: 100, maxPayloadBytes: 524288, parallelism: 1 }
  }
  private view(row: { id: string; clientId: string; mode: string; status: string; nextBatch: number; processed: number; skipped: number; createdAt: Date; updatedAt: Date; finishedAt: Date | null }) {
    const { id, clientId, mode, status, nextBatch, processed, skipped, createdAt, updatedAt, finishedAt } = row
    return { id, clientId, mode, status, nextBatch, processed, skipped, createdAt, updatedAt, finishedAt }
  }
}
