import { Injectable, NotFoundException } from '@nestjs/common'
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
    const item = await this.prisma.promoBanner.create({ data: { ...dto, tone: dto.tone ?? 'light', sortOrder: dto.sortOrder ?? 0, isActive: dto.isActive ?? true } })
    await this.audit.log(userId, 'CREATE_PROMO', 'PromoBanner', item.id, { title: item.title })
    return item
  }

  async update(id: string, dto: UpdatePromoDto, userId?: string) {
    const current = await this.prisma.promoBanner.findUnique({ where: { id } })
    if (!current) throw new NotFoundException('Баннер не найден')
    const item = await this.prisma.promoBanner.update({ where: { id }, data: dto })
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
}
