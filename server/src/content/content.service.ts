import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { AuditService } from '../audit/audit.service'
import { PrismaService } from '../prisma/prisma.service'
import { PromoDto, UpdatePromoDto } from './content.dto'

@Injectable()
export class ContentService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  publicPromos() {
    return this.prisma.promoBanner.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })
  }

  adminPromos() {
    return this.prisma.promoBanner.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })
  }

  async create(dto: PromoDto, userId?: string) {
    const item = await this.prisma.promoBanner.create({ data: { ...dto, blockId: dto.blockId?.trim() || 'home-promos', tone: dto.tone ?? 'light', sortOrder: dto.sortOrder ?? 0, isActive: dto.isActive ?? true } })
    await this.audit.log(userId, 'CREATE_PROMO', 'PromoBanner', item.id, { title: item.title })
    return item
  }

  async update(id: string, dto: UpdatePromoDto, userId?: string) {
    const current = await this.prisma.promoBanner.findUnique({ where: { id } })
    if (!current) throw new NotFoundException('Баннер не найден')
    const data = dto.blockId === undefined ? dto : { ...dto, blockId: dto.blockId.trim() || 'home-promos' }
    const item = await this.prisma.promoBanner.update({ where: { id }, data })
    await this.audit.log(userId, 'UPDATE_PROMO', 'PromoBanner', item.id, { title: item.title })
    return item
  }

  async remove(id: string, userId?: string) {
    const current = await this.prisma.promoBanner.findUnique({ where: { id } })
    if (!current) throw new NotFoundException('Баннер не найден')
    const item = await this.prisma.promoBanner.delete({ where: { id } })
    await this.audit.log(userId, 'DELETE_PROMO', 'PromoBanner', item.id, { title: item.title })
    return item
  }

  private defaultLayout() {
    const desktop = [
      { id: 'home-collections', type: 'collections', width: 12, visible: true, title: 'Категории' },
      { id: 'home-promos', type: 'promo', width: 12, visible: true, title: 'Акции' },
      { id: 'home-products', type: 'products', width: 12, visible: true, title: 'Популярные товары' },
    ]
    return {
      version: 2,
      devices: {
        desktop,
        tablet: [desktop[1], desktop[0], desktop[2]].map((block) => ({ ...block })),
        mobile: [desktop[1], desktop[0], desktop[2]].map((block) => ({ ...block })),
      },
    }
  }

  private normalizeLayout(value: unknown) {
    const source = value && typeof value === 'object' ? value as { blocks?: unknown; devices?: Record<string, unknown> } : {}
    const defaults = this.defaultLayout()
    const allowedTypes = new Set(['collections', 'promo', 'products', 'smartphones', 'text'])
    const allowedWidths = new Set([4, 6, 8, 12])
    const normalizeBlocks = (input: unknown, fallback: Array<Record<string, unknown>>, device: string) => {
      const values = Array.isArray(input) && input.length ? input : fallback
      const ids = new Set<string>()
      const blocks = values.slice(0, 24).map((raw, index) => {
        if (!raw || typeof raw !== 'object') throw new BadRequestException(`Некорректный блок ${index + 1} (${device})`)
        const item = raw as Record<string, unknown>
        const type = String(item.type ?? '')
        if (!allowedTypes.has(type)) throw new BadRequestException(`Неизвестный тип блока: ${type}`)
        let id = String(item.id ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
        if (!id || ids.has(id)) id = `${type}-${index + 1}`
        ids.add(id)
        const text = (field: string, fallbackText = '') => typeof item[field] === 'string' ? String(item[field]).trim().slice(0, 500) : fallbackText
        const width = Number(item.width)
        return {
          id, type, width: allowedWidths.has(width) ? width : 12, visible: item.visible !== false,
          title: text('title'), eyebrow: text('eyebrow'), body: text('body'), ctaLabel: text('ctaLabel'), category: text('category'),
        }
      })
      if (!blocks.length) throw new BadRequestException(`Добавь хотя бы один блок (${device})`)
      return blocks
    }
    const legacy = Array.isArray(source.blocks) ? source.blocks : undefined
    const devices = source.devices && typeof source.devices === 'object' ? source.devices : {}
    return {
      version: 2,
      devices: {
        desktop: normalizeBlocks(devices.desktop ?? legacy, defaults.devices.desktop, 'desktop'),
        tablet: normalizeBlocks(devices.tablet ?? legacy, defaults.devices.tablet, 'tablet'),
        mobile: normalizeBlocks(devices.mobile ?? legacy, defaults.devices.mobile, 'mobile'),
      },
    }
  }

  async publicLayout() {
    const record = await this.prisma.storefrontLayout.findUnique({ where: { id: 'home' } })
    return { layout: this.normalizeLayout(record?.published), publishedAt: record?.publishedAt ?? null }
  }

  async adminLayout() {
    const record = await this.prisma.storefrontLayout.findUnique({ where: { id: 'home' } })
    return {
      draft: this.normalizeLayout(record?.draft),
      published: this.normalizeLayout(record?.published),
      draftUpdatedAt: record?.draftUpdatedAt ?? null,
      publishedAt: record?.publishedAt ?? null,
    }
  }

  async saveLayout(input: unknown, userId?: string) {
    const layout = this.normalizeLayout(input)
    const record = await this.prisma.storefrontLayout.upsert({
      where: { id: 'home' },
      create: { id: 'home', draft: layout as Prisma.InputJsonValue },
      update: { draft: layout as Prisma.InputJsonValue, draftUpdatedAt: new Date() },
    })
    await this.audit.log(userId, 'SAVE_STOREFRONT_DRAFT', 'StorefrontLayout', record.id, { blocks: Object.values(layout.devices).reduce((sum, blocks) => sum + blocks.length, 0) })
    return { draft: layout, draftUpdatedAt: record.draftUpdatedAt, publishedAt: record.publishedAt }
  }

  async publishLayout(input: unknown, userId?: string) {
    const layout = this.normalizeLayout(input)
    const now = new Date()
    const record = await this.prisma.storefrontLayout.upsert({
      where: { id: 'home' },
      create: { id: 'home', draft: layout as Prisma.InputJsonValue, published: layout as Prisma.InputJsonValue, draftUpdatedAt: now, publishedAt: now },
      update: { draft: layout as Prisma.InputJsonValue, published: layout as Prisma.InputJsonValue, draftUpdatedAt: now, publishedAt: now },
    })
    await this.audit.log(userId, 'PUBLISH_STOREFRONT', 'StorefrontLayout', record.id, { blocks: Object.values(layout.devices).reduce((sum, blocks) => sum + blocks.length, 0) })
    return { draft: layout, published: layout, draftUpdatedAt: record.draftUpdatedAt, publishedAt: record.publishedAt }
  }
}
