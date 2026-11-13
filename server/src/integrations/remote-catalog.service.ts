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
  private effectiveExcluded(groups: Array<{ oneCId: string; parentId: string; excluded: boolean }>) {
    const excluded = new Set(groups.filter(group => group.excluded).map(group => group.oneCId))
    let changed = true
    while (changed) {
      changed = false
      for (const group of groups) if (!excluded.has(group.oneCId) && excluded.has(group.parentId)) {
        excluded.add(group.oneCId)
        changed = true
      }
    }
    return excluded
  }
  private subtree(groups: Array<{ oneCId: string; parentId: string }>, rootId: string) {
    const ids = new Set([rootId])
    let changed = true
    while (changed) {
      changed = false
      for (const group of groups) if (!ids.has(group.oneCId) && ids.has(group.parentId)) {
        ids.add(group.oneCId)
        changed = true
      }
    }
    return [...ids]
  }
  private async exclusionState(baseId: string) {
    const groups = await this.db.oneCRemoteGroup.findMany({
      where: { baseId, active: true },
      select: { oneCId: true, parentId: true, excluded: true, fullyImportedAt: true },
      take: 50000,
    })
    return { groups, ids: this.effectiveExcluded(groups) }
  }
  async dashboard(parent: string, search: string, page: number) {
    const configured = process.env.ONE_C_BASE_KIND === 'PRODUCTION' && Boolean(process.env.ONE_C_PRODUCTION_BASE_ID?.trim())
    if (!configured) return { configured: false, groups: [], jobs: [], agent: null, total: 0, page: 0 }
    const baseId = this.base()
    page = Number.isSafeInteger(page) ? Math.max(0, Math.min(page, 100000)) : 0
    const excluded = [...(await this.exclusionState(baseId)).ids]
    const where = { baseId, active: true, oneCId: { notIn: excluded }, ...(search.trim() ? { searchName: { contains: search.trim().slice(0, 100).toLocaleLowerCase('ru-RU') } } : { parentId: parent.slice(0, 100) }) }
    const [agent, groups, total, activeJobs, history] = await Promise.all([
      this.db.oneCCatalogAgent.findUnique({ where: { baseId } }),
      this.db.oneCRemoteGroup.findMany({ where, orderBy: [{ name: 'asc' }, { oneCId: 'asc' }], take: 100, skip: page * 100 }),
      this.db.oneCRemoteGroup.count({ where }),
      this.db.oneCCatalogJob.findMany({ where: { baseId, status: { in: [...OPEN, 'FAILED'] } }, orderBy: { createdAt: 'desc' }, take: 200, omit: { leaseToken: true, lastHash: true, agentId: true, itemIds: true } }),
      this.db.oneCCatalogJob.findMany({ where: { baseId, status: { notIn: [...OPEN, 'FAILED'] } }, orderBy: { createdAt: 'desc' }, take: 50, omit: { leaseToken: true, lastHash: true, agentId: true, itemIds: true } }),
    ])
    return { configured: true, baseId, agent: agent ? { ...agent, online: agent.lastSeenAt.getTime() > Date.now() - 150000 } : null, groups, total, page, jobs: [...activeJobs, ...history].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()) }
  }
  async tree() {
    const baseId = this.base()
    const state = await this.exclusionState(baseId)
    const excluded = [...state.ids]
    const [groups, itemCount] = await Promise.all([
      this.db.oneCRemoteGroup.findMany({
        where: { baseId, active: true, oneCId: { notIn: excluded } },
        orderBy: [{ name: 'asc' }, { oneCId: 'asc' }],
        select: { oneCId: true, parentId: true, name: true, itemCount: true, lastReceivedAt: true, fullyImportedAt: true },
        take: 50000,
      }),
      this.db.oneCNomenclatureItem.count({ where: { baseId, active: true, parentId: { notIn: excluded } } }),
    ])
    return { groups, itemCount }
  }
  async nomenclature(group: string, search: string, page: number) {
    const baseId = this.base()
    const excluded = [...(await this.exclusionState(baseId)).ids]
    page = Number.isSafeInteger(page) ? Math.max(0, Math.min(page, 100000)) : 0
    const query = search.trim().slice(0, 150).toLocaleLowerCase('ru-RU')
    if (group && excluded.includes(group)) return { items: [], total: 0, children: [], group: null, page, pageSize: 100, search: query }
    const where = {
      baseId,
      active: true,
      parentId: { notIn: excluded },
      ...(query ? { searchText: { contains: query } } : { parentId: group.slice(0, 100) }),
    }
    const [items, total, children, groupRow] = await Promise.all([
      this.db.oneCNomenclatureItem.findMany({ where, orderBy: [{ code: 'asc' }, { name: 'asc' }, { oneCId: 'asc' }], skip: page * 100, take: 100 }),
      this.db.oneCNomenclatureItem.count({ where }),
      this.db.oneCRemoteGroup.findMany({ where: { baseId, active: true, oneCId: { notIn: excluded }, ...(query ? { searchName: { contains: query } } : { parentId: group.slice(0, 100) }) }, orderBy: [{ name: 'asc' }, { oneCId: 'asc' }], take: 1000 }),
      group && !excluded.includes(group) ? this.db.oneCRemoteGroup.findUnique({ where: { baseId_oneCId: { baseId, oneCId: group } }, select: { oneCId: true, parentId: true, name: true } }) : Promise.resolve(null),
    ])
    const imported = new Set((await this.db.product.findMany({
      where: { oneCId: { in: items.map(item => item.oneCId) }, status: 'ACTIVE' }, select: { oneCId: true },
    })).map(item => item.oneCId))
    return { items: items.map(item => ({ ...item, imported: imported.has(item.oneCId) })), total, children, group: groupRow, page, pageSize: 100, search: query }
  }
  async excludedGroups() {
    const baseId = this.base()
    return this.db.oneCRemoteGroup.findMany({
      where: { baseId, active: true, excluded: true },
      orderBy: [{ name: 'asc' }, { oneCId: 'asc' }],
      select: { oneCId: true, parentId: true, name: true, itemCount: true, lastReceivedAt: true, fullyImportedAt: true },
      take: 1000,
    })
  }
  async excludeGroup(oneCId: string) {
    const baseId = this.base()
    const groups = await this.db.oneCRemoteGroup.findMany({
      where: { baseId, active: true },
      select: { oneCId: true, parentId: true, name: true, excluded: true },
      take: 50000,
    })
    const group = groups.find(row => row.oneCId === oneCId)
    if (!group) throw new NotFoundException('Группа 1С не найдена')
    if (this.effectiveExcluded(groups).has(oneCId)) throw new ConflictException('Эта группа уже исключена')
    const subtree = this.subtree(groups, oneCId)

    // Persist the rule first. Any catalog batch racing this cleanup is then
    // filtered by batch() and cannot recreate excluded rows.
    await this.db.oneCRemoteGroup.update({ where: { baseId_oneCId: { baseId, oneCId } }, data: { excluded: true } })
    let removed = 0
    let productsDeleted = 0
    let productsArchived = 0
    let categoriesDeleted = 0
    for (let offset = 0; offset < subtree.length; offset += 300) {
      const groupIds = subtree.slice(offset, offset + 300)
      while (true) {
        const items = await this.db.oneCNomenclatureItem.findMany({
          where: { baseId, parentId: { in: groupIds } }, select: { oneCId: true }, take: 300,
        })
        if (!items.length) break
        const ids = items.map(item => item.oneCId)
        await this.db.$transaction([
          this.db.oneCCatalogHash.deleteMany({ where: { baseId, oneCId: { in: ids } } }),
          this.db.oneCNomenclatureItem.deleteMany({ where: { baseId, oneCId: { in: ids } } }),
        ])
        removed += ids.length
      }
      const categories = await this.db.category.findMany({ where: { oneCId: { in: groupIds } }, select: { id: true } })
      const categoryIds = categories.map(category => category.id)
      while (categoryIds.length) {
        const products = await this.db.product.findMany({
          where: { categoryId: { in: categoryIds }, orderItems: { none: {} }, oneCPriceChanges: { none: {} } },
          select: { id: true }, take: 300,
        })
        if (!products.length) break
        productsDeleted += (await this.db.product.deleteMany({ where: { id: { in: products.map(product => product.id) } } })).count
      }
      productsArchived += (await this.db.product.updateMany({
        where: { categoryId: { in: categoryIds } },
        data: { status: 'ARCHIVED', stockQty: 0, priceSyncEnabled: false },
      })).count
      // Public catalogue queries require an active category, so this removes
      // already imported cards from the storefront without damaging orders.
      await this.db.category.updateMany({ where: { oneCId: { in: groupIds } }, data: { isActive: false } })
      categoriesDeleted += (await this.db.category.deleteMany({ where: { id: { in: categoryIds }, products: { none: {} } } })).count
    }
    await this.db.auditLog.create({ data: {
      action: 'ONEC_CATALOG_EXCLUDE', entity: 'OneCRemoteGroup', entityId: oneCId,
      details: { baseId, name: group.name, groups: subtree.length, removed, productsDeleted, productsArchived, categoriesDeleted },
    } })
    return { ok: true, name: group.name, groups: subtree.length, removed, productsDeleted, productsArchived, categoriesDeleted }
  }
  async restoreGroup(oneCId: string) {
    const baseId = this.base()
    const groups = await this.db.oneCRemoteGroup.findMany({
      where: { baseId, active: true },
      select: { oneCId: true, parentId: true, name: true, excluded: true },
      take: 50000,
    })
    const group = groups.find(row => row.oneCId === oneCId)
    if (!group?.excluded) throw new NotFoundException('Исключённая группа не найдена')
    const subtree = this.subtree(groups, oneCId)
    await this.db.oneCRemoteGroup.update({ where: { baseId_oneCId: { baseId, oneCId } }, data: { excluded: false } })
    for (let offset = 0; offset < subtree.length; offset += 300) {
      const groupIds = subtree.slice(offset, offset + 300)
      await this.db.$transaction([
        this.db.category.updateMany({ where: { oneCId: { in: groupIds } }, data: { isActive: true } }),
        this.db.oneCRemoteGroup.updateMany({ where: { baseId, oneCId: { in: groupIds } }, data: { fullyImportedAt: null } }),
      ])
    }
    await this.db.auditLog.create({ data: {
      action: 'ONEC_CATALOG_RESTORE', entity: 'OneCRemoteGroup', entityId: oneCId,
      details: { baseId, name: group.name, groups: subtree.length },
    } })
    const stillExcluded = this.effectiveExcluded(groups.map(row => row.oneCId === oneCId ? { ...row, excluded: false } : row)).has(oneCId)
    const job = stillExcluded ? null : await this.create({ kind: 'INDEX', mode: 'FULL', groupId: oneCId })
    return { ok: true, name: group.name, groups: subtree.length, jobId: job?.id || null }
  }
  async create(dto: RemoteJobDto) {
    const baseId = this.base()
    return this.db.$transaction(async tx => {
      if (await tx.oneCCatalogJob.count({ where: { baseId, status: { in: [...OPEN, 'FAILED'] } } }) >= 200) throw new ConflictException('В очереди уже 200 заданий')
      const groupId = ['INDEX', 'IMPORT'].includes(dto.kind) ? dto.groupId || '' : ''
      const group = groupId ? await tx.oneCRemoteGroup.findUnique({ where: { baseId_oneCId: { baseId, oneCId: groupId } } }) : null
      if (groupId && !group?.active) throw new BadRequestException('Обновите список групп и выберите существующую группу')
      if (groupId && this.effectiveExcluded(await tx.oneCRemoteGroup.findMany({ where: { baseId, active: true }, select: { oneCId: true, parentId: true, excluded: true } })).has(groupId)) throw new BadRequestException('Эта группа исключена из загрузки на сайт')
      const itemIds = [...new Set(dto.itemIds || [])]
      const stockOnly = dto.stockOnly === true
      if (dto.kind === 'IMPORT') {
        if (Boolean(groupId) === Boolean(itemIds.length)) throw new BadRequestException('Выберите товары или одну группу')
        if (stockOnly && !groupId) throw new BadRequestException('Фильтр наличия доступен только для загрузки группы')
        if (group?.fullyImportedAt) throw new ConflictException('Эта группа уже полностью загружена на сайт')
        if (itemIds.length) {
          const items = await tx.oneCNomenclatureItem.findMany({ where: { baseId, active: true, oneCId: { in: itemIds } }, select: { oneCId: true, parentId: true, code: true } })
          if (items.length !== itemIds.length) throw new BadRequestException('Часть выбранных товаров больше не найдена в списке 1С')
          if (items.some(item => !item.code.trim())) throw new BadRequestException('У одной из выбранных позиций нет кода 1С; её нельзя однозначно запросить')
          const excluded = this.effectiveExcluded(await tx.oneCRemoteGroup.findMany({ where: { baseId, active: true }, select: { oneCId: true, parentId: true, excluded: true } }))
          if (items.some(item => excluded.has(item.parentId))) throw new BadRequestException('Выбран товар из исключённой группы')
        }
      } else if (itemIds.length || stockOnly) throw new BadRequestException('Список товаров и фильтр наличия разрешены только для загрузки товаров')
      const same = dto.kind === 'IMPORT' ? null : await tx.oneCCatalogJob.findFirst({ where: { baseId, kind: dto.kind, groupId, status: { in: [...OPEN, 'FAILED'] } } })
      if (same) return { id: same.id }
      const groupName = dto.kind === 'GROUPS' ? 'Обновление групп'
        : dto.kind === 'INDEX' ? group?.name ? `Обновление списка: ${group.name}` : 'Обновление списка товаров'
          : group ? `Загрузка группы: ${group.name}${stockOnly ? ' · в наличии' : ''}` : `Загрузка выбранных товаров: ${itemIds.length}`
      const row = await tx.oneCCatalogJob.create({ data: { id: randomUUID(), baseId, kind: dto.kind, groupId, itemIds, stockOnly: dto.kind === 'IMPORT' && stockOnly, mode: dto.kind === 'IMPORT' ? 'FULL' : dto.mode, groupName } })
      await tx.auditLog.create({ data: { action: 'ONEC_CATALOG_QUEUE', entity: 'OneCCatalogJob', entityId: row.id, details: { kind: row.kind, groupId, items: itemIds.length, stockOnly: row.stockOnly, mode: row.mode, baseId } } })
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
    // Retire pre-selective full-catalog jobs. They must never resume and start
    // publishing every 1C card after the deployment of on-demand imports.
    const legacy = await this.db.oneCCatalogJob.findMany({ where: { baseId, kind: 'CATALOG', status: { in: [...OPEN, 'FAILED'] } }, select: { id: true } })
    if (legacy.length) await this.db.$transaction([
      this.db.oneCCatalogJob.updateMany({ where: { id: { in: legacy.map(job => job.id) } }, data: { status: 'CANCELLED', leaseToken: null, leaseUntil: null, finishedAt: now } }),
      this.db.catalogImportSession.updateMany({ where: { id: { in: legacy.map(job => job.id) } }, data: { status: 'CANCELLED', activeKey: null, finishedAt: now } }),
    ])
    // Discover groups initially, then periodically refresh their names only.
    const lastGroups = await this.db.oneCCatalogJob.findFirst({ where: { baseId, kind: 'GROUPS' }, orderBy: { createdAt: 'desc' } })
    if (!lastGroups || lastGroups.status === 'CANCELLED' || lastGroups.status === 'COMPLETED' && lastGroups.finishedAt && lastGroups.finishedAt.getTime() < Date.now() - 1800000) await this.create({ kind: 'GROUPS', mode: 'FULL' })
    // Build the lightweight picker index once. A later full refresh happens
    // only after an explicit admin request; opening a group must never start
    // another scan of every nomenclature item.
    if (lastGroups?.status === 'COMPLETED') {
      const blockingCatalog = await this.db.oneCCatalogJob.findFirst({ where: { baseId, kind: { in: ['INDEX', 'IMPORT'] }, status: { in: [...OPEN, 'FAILED'] } } })
      if (!blockingCatalog) {
        const latestRoot = await this.db.oneCCatalogJob.findFirst({ where: { baseId, kind: 'INDEX', groupId: '' }, orderBy: { createdAt: 'desc' } })
        if (!latestRoot || latestRoot.status === 'CANCELLED') await this.create({ kind: 'INDEX', mode: 'FULL' })
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
    if (job) {
      const { lastHash, itemIds, ...safe } = job
      if (job.kind === 'GROUPS') return { job: safe, pauseMs: 3000 }
      const state = await this.exclusionState(baseId)
      const excludedRoots = state.groups
        .filter(group => group.excluded && !state.ids.has(group.parentId))
        .map(group => group.oneCId)
      let loadedRoots: string[] = []
      if (job.kind === 'IMPORT' && job.groupId) {
        const branch = new Set(this.subtree(state.groups, job.groupId))
        const loaded = new Set(state.groups
          .filter(group => group.oneCId !== job.groupId && branch.has(group.oneCId) && group.fullyImportedAt)
          .map(group => group.oneCId))
        loadedRoots = state.groups
          .filter(group => loaded.has(group.oneCId) && !loaded.has(group.parentId))
          .map(group => group.oneCId)
      }
      const excludedGroupIds = [...new Set([...excludedRoots, ...loadedRoots])].slice(0, 100)
      if (job.kind === 'INDEX') return { job: { ...safe, excludedGroupIds }, pauseMs: 300 }
      const selectedIds = Array.isArray(itemIds) ? itemIds.filter((value): value is string => typeof value === 'string') : []
      const selectedCodes = (await this.db.oneCNomenclatureItem.findMany({
        where: { baseId, active: true, oneCId: { in: selectedIds } }, select: { code: true }, take: 100,
      })).map(item => item.code).filter(Boolean)
      return { job: { ...safe, excludedGroupIds, selectedCodes }, pauseMs: 1000 }
    }
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
    const indexItems = dto.indexItems || []
    if (Buffer.byteLength(JSON.stringify(dto)) > 512 * 1024) throw new PayloadTooLargeException('Не более 512 КБ в пакете')
    if (dto.products.length > 50 || dto.categories.length > 50 || dto.scanned === 0 || !dto.cursor.trim() || /[\u0000-\u001f]/.test(dto.cursor)) throw new BadRequestException('Неверный курсор или размер пакета')
    const row = await this.db.oneCCatalogJob.findUnique({ where: { id } })
    if (!row || row.baseId !== baseId) throw new NotFoundException('Задание не найдено')
    const excludedIds = ['INDEX', 'IMPORT', 'CATALOG'].includes(row.kind) ? (await this.exclusionState(baseId)).ids : new Set<string>()
    const rejectedProductIds = new Set(dto.products.filter(product => excludedIds.has(product.categoryOneCId)).map(product => product.oneCId))
    const acceptedProducts = dto.products.filter(product => !rejectedProductIds.has(product.oneCId))
    const acceptedCategories = dto.categories.filter(category => !excludedIds.has(category.oneCId))
    const acceptedHashes = dto.hashes.filter(item => !rejectedProductIds.has(item.oneCId))
    const acceptedIndexItems = indexItems.filter(item => !excludedIds.has(item.parentId))
    // Lost acknowledgement: replay is harmless even after pause or lease renewal.
    if (row.nextBatch === dto.batch + 1 && row.lastHash === hash) return { ok: true, nextBatch: row.nextBatch }
    const before = async (tx: Prisma.TransactionClient) => {
      const locked = await this.lock(tx, id, dto.leaseToken)
      if (locked.nextBatch !== dto.batch || locked.cursor === dto.cursor) throw new ConflictException('Неверный номер пакета или курсор')
      const valid = locked.kind === 'GROUPS'
        ? !dto.products.length && !dto.categories.length && !dto.hashes.length && !indexItems.length && dto.groups.length === dto.scanned
        : locked.kind === 'INDEX'
          ? !dto.products.length && !dto.categories.length && !dto.hashes.length && !dto.groups.length && indexItems.length === dto.scanned
          : ['IMPORT', 'CATALOG'].includes(locked.kind)
            ? !dto.groups.length && !indexItems.length && dto.hashes.length === dto.scanned && dto.products.every(p => dto.hashes.some(h => h.oneCId === p.oneCId))
            : false
      if (!valid) throw new BadRequestException('Пакет не соответствует заданию')
      if (new Set(dto.hashes.map(h => h.oneCId)).size !== dto.hashes.length || new Set(dto.groups.map(g => g.oneCId)).size !== dto.groups.length || new Set(indexItems.map(item => item.oneCId)).size !== indexItems.length) throw new BadRequestException('Повторяющиеся GUID')
    }
    const after = async (tx: Prisma.TransactionClient, result: { products: number; skippedDuplicates: number }) => {
      for (const group of dto.groups) {
        if (group.parentId && !/^[0-9a-f-]{36}$/i.test(group.parentId) || group.parentId === group.oneCId || !group.name.trim()) throw new BadRequestException('Неверная группа')
        await tx.oneCRemoteGroup.upsert({ where: { baseId_oneCId: { baseId, oneCId: group.oneCId } }, create: { ...group, baseId, generation: id, searchName: group.name.toLocaleLowerCase('ru-RU') }, update: { ...group, generation: id, active: true, searchName: group.name.toLocaleLowerCase('ru-RU') } })
      }
      if (row.kind === 'INDEX') {
        const receivedAt = new Date()
        for (const item of acceptedIndexItems) {
          const basic = {
            parentId: item.parentId, code: item.code.trim(), article: item.article.trim(), name: item.name.trim(),
            deletionMark: item.deletionMark, active: true, generation: id, receivedAt,
            searchText: [item.code, item.article, item.name].filter(Boolean).join(' ').toLocaleLowerCase('ru-RU'),
          }
          await tx.oneCNomenclatureItem.upsert({
            where: { baseId_oneCId: { baseId, oneCId: item.oneCId } },
            create: { baseId, oneCId: item.oneCId, fullName: item.name.trim(), ...basic },
            update: basic,
          })
        }
        await tx.oneCCatalogAgent.update({ where: { baseId }, data: { nomenclatureUpdatedAt: receivedAt } })
      }
      if (['IMPORT', 'CATALOG'].includes(row.kind)) await tx.oneCRemoteGroup.updateMany({ where: { baseId, oneCId: { in: acceptedCategories.map(c => c.oneCId) } }, data: { lastReceivedAt: new Date() } })
      if (['IMPORT', 'CATALOG'].includes(row.kind)) {
        const receivedAt = new Date()
        for (const product of acceptedProducts) {
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
      for (const h of acceptedHashes) await tx.oneCCatalogHash.upsert({ where: { baseId_oneCId: { baseId, oneCId: h.oneCId } }, create: { ...h, baseId }, update: { hash: h.hash } })
      const rejectedIndexItems = indexItems.length - acceptedIndexItems.length
      await tx.oneCCatalogJob.update({ where: { id }, data: { cursor: dto.cursor, lastHash: hash, nextBatch: { increment: 1 }, scanned: { increment: dto.scanned }, processed: { increment: result.products }, skipped: { increment: result.skippedDuplicates + rejectedProductIds.size + rejectedIndexItems }, leaseUntil: new Date(Date.now() + 120000) } })
    }
    if (['GROUPS', 'INDEX'].includes(row.kind)) return this.db.$transaction(async tx => {
      await before(tx)
      const session = await tx.catalogImportSession.findUnique({ where: { id } })
      if (session?.status !== 'RUNNING' || session.nextBatch !== dto.batch) throw new ConflictException('Сеанс чтения уже закрыт')
      const processed = row.kind === 'INDEX' ? acceptedIndexItems.length : 0
      await after(tx, { products: processed, skippedDuplicates: 0 })
      await tx.catalogImportSession.update({ where: { id }, data: { nextBatch: { increment: 1 }, processed: { increment: processed }, skipped: { increment: indexItems.length - acceptedIndexItems.length }, lastBatchHash: hash } })
      return { ok: true }
    })
    return this.integrations.importCatalog({ categories: acceptedCategories, products: acceptedProducts }, { sessionId: id, batch: dto.batch, hash }, { before, after })
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
      if (row.kind === 'INDEX') {
        if (row.mode === 'FULL' && !row.groupId) await tx.oneCNomenclatureItem.updateMany({ where: { baseId: row.baseId, generation: { not: id } }, data: { active: false } })
        await tx.oneCCatalogAgent.update({ where: { baseId: row.baseId }, data: { nomenclatureUpdatedAt: new Date() } })
      }
      if (row.kind === 'IMPORT' && row.groupId && !row.stockOnly) {
        const groups = await tx.oneCRemoteGroup.findMany({
          where: { baseId: row.baseId, active: true },
          select: { oneCId: true, parentId: true, excluded: true },
          take: 50000,
        })
        const excluded = this.effectiveExcluded(groups)
        const imported = this.subtree(groups, row.groupId).filter(oneCId => !excluded.has(oneCId))
        const finishedAt = new Date()
        for (let offset = 0; offset < imported.length; offset += 300) {
          await tx.oneCRemoteGroup.updateMany({
            where: { baseId: row.baseId, oneCId: { in: imported.slice(offset, offset + 300) } },
            data: { fullyImportedAt: finishedAt },
          })
        }
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
