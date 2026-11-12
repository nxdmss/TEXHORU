import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { IntegrationsService } from './integrations.service'
import { RemoteBatchDto, RemoteJobDto, RemoteKnownDto, RemotePollDto } from './remote-catalog.dto'
const OPEN = ['QUEUED', 'RUNNING', 'PAUSED']
const ZERO = '00000000-0000-0000-0000-000000000000'
@Injectable()
export class RemoteCatalogService {
  constructor(private readonly db: PrismaService, private readonly integrations: IntegrationsService) {}
  private base() {
    const id = process.env.ONE_C_PRODUCTION_BASE_ID?.trim()
    if (process.env.ONE_C_BASE_KIND !== 'PRODUCTION' || !id) throw new ForbiddenException('Настройте профиль основной базы 1С и ONE_C_PRODUCTION_BASE_ID')
    return id
  }
  async dashboard(parent: string, search: string, page: number) {
    const configured = process.env.ONE_C_BASE_KIND === 'PRODUCTION' && Boolean(process.env.ONE_C_PRODUCTION_BASE_ID?.trim())
    if (!configured) return { configured: false, groups: [], jobs: [], agent: null, total: 0, page: 0 }
    const baseId = this.base()
    page = Number.isSafeInteger(page) ? Math.max(0, Math.min(page, 100000)) : 0
    const where = { baseId, active: true, ...(search.trim() ? { searchName: { contains: search.trim().slice(0, 100).toLocaleLowerCase('ru-RU') } } : { parentId: parent.slice(0, 100) }) }
    const [agent, groups, total, activeJobs, history] = await Promise.all([
      this.db.oneCCatalogAgent.findUnique({ where: { baseId } }),
      this.db.oneCRemoteGroup.findMany({ where, orderBy: [{ name: 'asc' }, { oneCId: 'asc' }], take: 100, skip: page * 100 }),
      this.db.oneCRemoteGroup.count({ where }),
      this.db.oneCCatalogJob.findMany({ where: { baseId, status: { in: [...OPEN, 'FAILED'] } }, orderBy: { createdAt: 'desc' }, take: 200, omit: { leaseToken: true, lastHash: true, agentId: true } }),
      this.db.oneCCatalogJob.findMany({ where: { baseId, status: { notIn: [...OPEN, 'FAILED'] } }, orderBy: { createdAt: 'desc' }, take: 50, omit: { leaseToken: true, lastHash: true, agentId: true } }),
    ])
    return { configured: true, baseId, agent: agent ? { ...agent, online: agent.lastSeenAt.getTime() > Date.now() - 150000 } : null, groups, total, page, jobs: [...activeJobs, ...history].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()) }
  }
  async tree() {
    const baseId = this.base()
    const [groups, itemCount] = await Promise.all([
      this.db.oneCRemoteGroup.findMany({
        where: { baseId, active: true },
        orderBy: [{ name: 'asc' }, { oneCId: 'asc' }],
        select: { oneCId: true, parentId: true, name: true, itemCount: true, lastReceivedAt: true },
        take: 50000,
      }),
      this.db.oneCNomenclatureItem.count({ where: { baseId, active: true } }),
    ])
    return { groups, itemCount }
  }
  async nomenclature(group: string, search: string, page: number) {
    const baseId = this.base()
    page = Number.isSafeInteger(page) ? Math.max(0, Math.min(page, 100000)) : 0
    const query = search.trim().slice(0, 150).toLocaleLowerCase('ru-RU')
    const where = {
      baseId,
      active: true,
      ...(query ? { searchText: { contains: query } } : { parentId: group.slice(0, 100) }),
    }
    const [items, total, children, groupRow] = await Promise.all([
      this.db.oneCNomenclatureItem.findMany({ where, orderBy: [{ code: 'asc' }, { name: 'asc' }, { oneCId: 'asc' }], skip: page * 100, take: 100 }),
      this.db.oneCNomenclatureItem.count({ where }),
      this.db.oneCRemoteGroup.findMany({ where: { baseId, active: true, ...(query ? { searchName: { contains: query } } : { parentId: group.slice(0, 100) }) }, orderBy: [{ name: 'asc' }, { oneCId: 'asc' }], take: 1000 }),
      group ? this.db.oneCRemoteGroup.findUnique({ where: { baseId_oneCId: { baseId, oneCId: group } }, select: { oneCId: true, parentId: true, name: true } }) : Promise.resolve(null),
    ])
    return { items, total, children, group: groupRow, page, pageSize: 100, search: query }
  }
  async create(dto: RemoteJobDto) {
    const baseId = this.base()
    return this.db.$transaction(async tx => {
      if (await tx.oneCCatalogJob.count({ where: { baseId, status: { in: [...OPEN, 'FAILED'] } } }) >= 200) throw new ConflictException('В очереди уже 200 заданий')
      const groupId = dto.kind === 'CATALOG' ? dto.groupId || '' : ''
      const group = groupId ? await tx.oneCRemoteGroup.findUnique({ where: { baseId_oneCId: { baseId, oneCId: groupId } } }) : null
      if (groupId && !group?.active) throw new BadRequestException('Обновите список групп и выберите существующую группу')
      const same = await tx.oneCCatalogJob.findFirst({ where: { baseId, kind: dto.kind, groupId, status: { in: [...OPEN, 'FAILED'] } } })
      if (same) return { id: same.id }
      const row = await tx.oneCCatalogJob.create({ data: { id: randomUUID(), baseId, kind: dto.kind, groupId, mode: dto.mode, groupName: dto.kind === 'GROUPS' ? 'Обновление групп' : group?.name || 'Весь каталог' } })
      await tx.auditLog.create({ data: { action: 'ONEC_CATALOG_QUEUE', entity: 'OneCCatalogJob', entityId: row.id, details: { kind: row.kind, groupId, mode: row.mode, baseId } } })
      return { id: row.id }
    })
  }
  async action(id: string, action: string) {
    const baseId = this.base()
    return this.db.$transaction(async tx => {
      const row = await tx.oneCCatalogJob.findUnique({ where: { id } })
      if (!row || row.baseId !== baseId) throw new NotFoundException('Задание не найдено')
      const allowed: Record<string, string[]> = { pause: ['QUEUED', 'RUNNING'], resume: ['PAUSED'], cancel: [...OPEN, 'FAILED'], retry: ['FAILED'] }
      if (!allowed[action]?.includes(row.status)) throw new ConflictException('Состояние задания уже изменилось')
      const status = { pause: 'PAUSED', resume: 'QUEUED', cancel: 'CANCELLED', retry: 'QUEUED' }[action]!
      await tx.oneCCatalogJob.update({ where: { id }, data: { status, leaseToken: null, leaseUntil: null, error: null, finishedAt: status === 'CANCELLED' ? new Date() : null } })
      if (action === 'cancel') await tx.catalogImportSession.updateMany({ where: { id }, data: { status: 'CANCELLED', activeKey: null, finishedAt: new Date() } })
      await tx.auditLog.create({ data: { action: 'ONEC_CATALOG_' + action.toUpperCase(), entity: 'OneCCatalogJob', entityId: id } })
      return { ok: true }
    })
  }
  async poll(dto: RemotePollDto) {
    const baseId = this.base(), now = new Date()
    await this.db.oneCCatalogAgent.upsert({ where: { baseId }, create: { baseId, agentId: dto.agentId, state: dto.state, error: dto.error, lastSeenAt: now }, update: { agentId: dto.agentId, state: dto.state, error: dto.error || null, lastSeenAt: now } })
    // Discover groups initially, then refresh five minutes after the last completed snapshot.
    const lastGroups = await this.db.oneCCatalogJob.findFirst({ where: { baseId, kind: 'GROUPS' }, orderBy: { createdAt: 'desc' } })
    if (!lastGroups || lastGroups.status === 'COMPLETED' && lastGroups.finishedAt && lastGroups.finishedAt.getTime() < Date.now() - 300000) await this.create({ kind: 'GROUPS', mode: 'FULL' })
    // Once the group tree exists, build the mirror automatically and keep it
    // fresh. A single durable job is resumed by subsequent one-minute ticks.
    if (lastGroups?.status === 'COMPLETED') {
      const blockingCatalog = await this.db.oneCCatalogJob.findFirst({ where: { baseId, kind: 'CATALOG', status: { in: [...OPEN, 'FAILED'] } } })
      if (!blockingCatalog) {
        const latestRoot = await this.db.oneCCatalogJob.findFirst({ where: { baseId, kind: 'CATALOG', groupId: '' }, orderBy: { createdAt: 'desc' } })
        if (!latestRoot) await this.create({ kind: 'CATALOG', mode: 'FULL' })
        else if (latestRoot.status === 'COMPLETED' && latestRoot.finishedAt && latestRoot.finishedAt.getTime() < Date.now() - 45000) await this.create({ kind: 'CATALOG', mode: 'DELTA' })
      }
    }
    const job = await this.db.$transaction(async tx => {
      const active = await tx.catalogImportSession.findUnique({ where: { activeKey: 'catalog' } })
      const row = active
        ? await tx.oneCCatalogJob.findFirst({ where: { id: active.id, baseId, status: { in: ['RUNNING', 'QUEUED'] } } })
        : await tx.oneCCatalogJob.findFirst({ where: { baseId, status: { in: ['RUNNING', 'QUEUED'] } }, orderBy: { createdAt: 'asc' } })
      if (!row || row.leaseUntil && row.leaseUntil > now && row.agentId !== dto.agentId) return null
      if (dto.state === 'error') {
        if (row.agentId === dto.agentId && row.status === 'RUNNING') await tx.oneCCatalogJob.update({ where: { id: row.id }, data: { status: 'FAILED', error: dto.error || 'CATALOG_READ', leaseToken: null, leaseUntil: null } })
        return null
      }
      if (!active) await tx.catalogImportSession.upsert({ where: { id: row.id }, create: { id: row.id, clientId: baseId, mode: row.mode, activeKey: 'catalog' }, update: { activeKey: 'catalog', status: 'RUNNING', finishedAt: null } })
      const leaseToken = row.leaseToken && row.leaseUntil && row.leaseUntil > now ? row.leaseToken : randomUUID()
      return tx.oneCCatalogJob.update({ where: { id: row.id }, data: { status: 'RUNNING', agentId: dto.agentId, leaseToken, leaseUntil: new Date(Date.now() + 120000) } })
    })
    if (job) { const { lastHash, ...safe } = job; return { job: safe, pauseMs: 3000 } }
    return { job: null, pauseMs: 5000 }
  }
  async known(dto: RemoteKnownDto) {
    const baseId = this.base(), ids = dto.hashes.map(h => h.oneCId)
    const [hashes, products] = await Promise.all([
      this.db.oneCCatalogHash.findMany({ where: { baseId, oneCId: { in: ids } } }),
      this.db.product.findMany({ where: { oneCId: { in: ids } }, select: { oneCId: true } }),
    ])
    const known = new Map(hashes.map(h => [h.oneCId, h.hash])), present = new Set(products.map(p => p.oneCId))
    return { needed: dto.hashes.filter(h => known.get(h.oneCId) !== h.hash || !present.has(h.oneCId)).map(h => h.oneCId) }
  }
  private async lock(tx: Prisma.TransactionClient, id: string, token: string) {
    const row = await tx.oneCCatalogJob.findUnique({ where: { id } })
    if (!row || row.baseId !== this.base()) throw new NotFoundException('Задание не найдено')
    if (row.status !== 'RUNNING' || row.leaseToken !== token || !row.leaseUntil || row.leaseUntil.getTime() < Date.now()) throw new ConflictException('Задание приостановлено или передано другому агенту')
    return row
  }
  async batch(id: string, dto: RemoteBatchDto) {
    const baseId = this.base(), hash = createHash('sha256').update(JSON.stringify({ ...dto, leaseToken: '' })).digest('hex')
    if (Buffer.byteLength(JSON.stringify(dto)) > 512 * 1024) throw new PayloadTooLargeException('Не более 512 КБ в пакете')
    if (dto.products.length > 50 || dto.categories.length > 50 || dto.scanned === 0 || !/^[0-9a-f-]{36}$/i.test(dto.cursor) || dto.cursor === ZERO) throw new BadRequestException('Неверный курсор или размер пакета')
    const row = await this.db.oneCCatalogJob.findUnique({ where: { id } })
    if (!row || row.baseId !== baseId) throw new NotFoundException('Задание не найдено')
    // Lost acknowledgement: replay is harmless even after pause or lease renewal.
    if (row.nextBatch === dto.batch + 1 && row.lastHash === hash) return { ok: true, nextBatch: row.nextBatch }
    const before = async (tx: Prisma.TransactionClient) => {
      const locked = await this.lock(tx, id, dto.leaseToken)
      if (locked.nextBatch !== dto.batch || locked.cursor === dto.cursor) throw new ConflictException('Неверный номер пакета или курсор')
      if (locked.kind === 'GROUPS' ? dto.products.length || dto.categories.length || dto.hashes.length || dto.groups.length !== dto.scanned
        : dto.groups.length || dto.hashes.length !== dto.scanned || dto.products.some(p => !dto.hashes.some(h => h.oneCId === p.oneCId))) throw new BadRequestException('Пакет не соответствует заданию')
      if (new Set(dto.hashes.map(h => h.oneCId)).size !== dto.hashes.length || new Set(dto.groups.map(g => g.oneCId)).size !== dto.groups.length) throw new BadRequestException('Повторяющиеся GUID')
    }
    const after = async (tx: Prisma.TransactionClient, result: { products: number; skippedDuplicates: number }) => {
      for (const group of dto.groups) {
        if (group.parentId && !/^[0-9a-f-]{36}$/i.test(group.parentId) || group.parentId === group.oneCId || !group.name.trim()) throw new BadRequestException('Неверная группа')
        await tx.oneCRemoteGroup.upsert({ where: { baseId_oneCId: { baseId, oneCId: group.oneCId } }, create: { ...group, baseId, generation: id, searchName: group.name.toLocaleLowerCase('ru-RU') }, update: { ...group, generation: id, active: true, searchName: group.name.toLocaleLowerCase('ru-RU') } })
      }
      if (row.kind === 'CATALOG') await tx.oneCRemoteGroup.updateMany({ where: { baseId, oneCId: { in: dto.categories.map(c => c.oneCId) } }, data: { lastReceivedAt: new Date() } })
      if (row.kind === 'CATALOG') {
        const receivedAt = new Date()
        for (const product of dto.products) {
          const source = {
            parentId: product.categoryOneCId,
            code: product.sourceCode?.trim() || '',
            article: product.sourceArticle?.trim() || product.mpn?.trim() || '',
            name: product.name.trim(),
            fullName: product.sourceFullName?.trim() || product.name.trim(),
            itemKind: product.sourceKind?.trim() || 'Товар',
            unitName: product.sourceUnit?.trim() || '',
            retailPrice: product.price,
            purchasePrice: product.costPrice ?? null,
            stockQty: product.stockQty,
            deletionMark: product.isDeleted === true,
            active: true,
            generation: id,
            sourceChangedAt: product.sourceChangedAt ? new Date(product.sourceChangedAt) : null,
            receivedAt,
            searchText: [product.sourceCode, product.sourceArticle, product.mpn, product.name, product.sourceFullName, product.sourceKind, product.sourceUnit].filter(Boolean).join(' ').toLocaleLowerCase('ru-RU'),
          }
          await tx.oneCNomenclatureItem.upsert({
            where: { baseId_oneCId: { baseId, oneCId: product.oneCId } },
            create: { baseId, oneCId: product.oneCId, ...source },
            update: source,
          })
        }
        await tx.oneCCatalogAgent.update({ where: { baseId }, data: { nomenclatureUpdatedAt: receivedAt } })
      }
      for (const h of dto.hashes) await tx.oneCCatalogHash.upsert({ where: { baseId_oneCId: { baseId, oneCId: h.oneCId } }, create: { ...h, baseId }, update: { hash: h.hash } })
      await tx.oneCCatalogJob.update({ where: { id }, data: { cursor: dto.cursor, lastHash: hash, nextBatch: { increment: 1 }, scanned: { increment: dto.scanned }, processed: { increment: result.products }, skipped: { increment: result.skippedDuplicates }, leaseUntil: new Date(Date.now() + 120000) } })
    }
    if (row.kind === 'GROUPS') return this.db.$transaction(async tx => {
      await before(tx)
      const session = await tx.catalogImportSession.findUnique({ where: { id } })
      if (session?.status !== 'RUNNING' || session.nextBatch !== dto.batch) throw new ConflictException('Сеанс групп уже закрыт')
      await after(tx, { products: 0, skippedDuplicates: 0 })
      await tx.catalogImportSession.update({ where: { id }, data: { nextBatch: { increment: 1 }, lastBatchHash: hash } })
      return { ok: true }
    })
    return this.integrations.importCatalog({ categories: dto.categories, products: dto.products }, { sessionId: id, batch: dto.batch, hash }, { before, after })
  }
  async finish(id: string, token: string) {
    return this.db.$transaction(async tx => {
      const existing = await tx.oneCCatalogJob.findUnique({ where: { id } })
      if (existing?.baseId === this.base() && existing.status === 'COMPLETED' && existing.leaseToken === token) return { ok: true }
      const row = await this.lock(tx, id, token)
      if (row.kind === 'GROUPS') {
        await tx.oneCRemoteGroup.updateMany({ where: { baseId: row.baseId, generation: { not: id } }, data: { active: false } })
        await tx.oneCCatalogAgent.update({ where: { baseId: row.baseId }, data: { groupsUpdatedAt: new Date() } })
      }
      if (row.kind === 'CATALOG') {
        if (row.mode === 'FULL' && !row.groupId) await tx.oneCNomenclatureItem.updateMany({ where: { baseId: row.baseId, generation: { not: id } }, data: { active: false } })
        await tx.oneCCatalogAgent.update({ where: { baseId: row.baseId }, data: { nomenclatureUpdatedAt: new Date() } })
      }
      await tx.oneCCatalogJob.update({ where: { id }, data: { status: 'COMPLETED', finishedAt: new Date(), leaseUntil: null } })
      await tx.catalogImportSession.update({ where: { id }, data: { status: 'COMPLETED', activeKey: null, finishedAt: new Date() } })
      // Bounded history: keep at most the latest 1000 completed/cancelled jobs.
      const old = await tx.oneCCatalogJob.findMany({ where: { baseId: row.baseId, status: { in: ['COMPLETED', 'CANCELLED'] } }, orderBy: { createdAt: 'desc' }, skip: 1000, take: 100, select: { id: true } })
      await tx.oneCCatalogJob.deleteMany({ where: { id: { in: old.map(j => j.id) } } })
      await tx.catalogImportSession.deleteMany({ where: { id: { in: old.map(j => j.id) }, activeKey: null } })
      return { ok: true }
    })
  }
}
