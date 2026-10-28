import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { ProductStatus, StockState } from '@prisma/client'
import { AuditService } from '../audit/audit.service'
import { PrismaService } from '../prisma/prisma.service'
import { CreateCategoryDto, UpdateCategoryDto, UpdateProductDto, UpsertProductDto } from './products.dto'
import { uniquePhoneProducts } from './phone-uniqueness'

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list() {
    const rows = await this.prisma.product.findMany({ where: { status: ProductStatus.ACTIVE }, include: { category: true }, orderBy: [{ category: { sortOrder: 'asc' } }, { id: 'asc' }] })
    const visible = rows.filter(item => !item.oneCId
      || !/(?:смартфон|smartphone)/i.test(item.category.name)
      || item.stockQty > item.reservedQty)
    // Older 1C imports may already contain duplicate GUIDs for the exact
    // same variant. Show one public card; keep all original records intact.
    return uniquePhoneProducts(visible).map((item) => {
      const available = Math.max(0, item.stockQty - item.reservedQty)
      const stockState = item.stockState === StockState.PREORDER ? StockState.PREORDER : available <= 0 ? StockState.OUT_OF_STOCK : available <= 3 ? StockState.LOW : StockState.IN_STOCK
      return { ...item, stockQty: available, stockState }
    })
  }

  async get(id: number) {
    const product = await this.prisma.product.findFirst({ where: { id, status: ProductStatus.ACTIVE }, include: { category: true } })
    if (!product || (product.oneCId && /(?:смартфон|smartphone)/i.test(product.category.name)
      && product.stockQty <= product.reservedQty)) throw new NotFoundException('Товар не найден')
    const available = Math.max(0, product.stockQty - product.reservedQty)
    const stockState = product.stockState === StockState.PREORDER ? StockState.PREORDER : available <= 0 ? StockState.OUT_OF_STOCK : available <= 3 ? StockState.LOW : StockState.IN_STOCK
    return { ...product, stockQty: available, stockState }
  }

  categories() { return this.prisma.category.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }) }
  adminCategories() { return this.prisma.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }) }
  adminList() { return this.prisma.product.findMany({ include: { category: true }, orderBy: { updatedAt: 'desc' } }) }

  async createCategory(dto: CreateCategoryDto, userId?: string) {
    const item = await this.prisma.category.create({ data: { ...dto, sortOrder: dto.sortOrder ?? 0 } })
    await this.audit.log(userId, 'CREATE_CATEGORY', 'Category', item.id, { name: item.name, slug: item.slug })
    return item
  }

  async updateCategory(id: string, dto: UpdateCategoryDto, userId?: string) {
    const existing = await this.prisma.category.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Категория не найдена')
    const item = await this.prisma.category.update({ where: { id }, data: dto })
    await this.audit.log(userId, 'UPDATE_CATEGORY', 'Category', item.id, { name: item.name, fields: Object.keys(dto) })
    return item
  }

  async create(dto: UpsertProductDto, userId?: string) {
    const item = await this.prisma.product.create({ data: { ...dto, stockState: (dto.stockState ?? 'IN_STOCK') as StockState, specs: dto.specs ?? [] } })
    await this.audit.log(userId, 'CREATE_PRODUCT', 'Product', String(item.id), { sku: item.sku, name: item.name })
    return item
  }

  async update(id: number, dto: UpdateProductDto, userId?: string) {
    await this.getAdmin(id)
    const item = await this.prisma.product.update({ where: { id }, data: { ...dto, stockState: dto.stockState as StockState | undefined, specs: dto.specs } })
    await this.audit.log(userId, 'UPDATE_PRODUCT', 'Product', String(item.id), { sku: item.sku, fields: Object.keys(dto) })
    return item
  }

  async archive(id: number, userId?: string) {
    await this.getAdmin(id)
    const item = await this.prisma.product.update({ where: { id }, data: { status: ProductStatus.ARCHIVED } })
    await this.audit.log(userId, 'ARCHIVE_PRODUCT', 'Product', String(item.id), { sku: item.sku, name: item.name })
    return item
  }

  async restore(id: number, userId?: string) {
    await this.getAdmin(id)
    const item = await this.prisma.product.update({ where: { id }, data: { status: ProductStatus.ACTIVE } })
    await this.audit.log(userId, 'RESTORE_PRODUCT', 'Product', String(item.id), { sku: item.sku, name: item.name })
    return item
  }

  async removePermanently(id: number, userId?: string) {
    const existing = await this.getAdmin(id)
    const orderItems = await this.prisma.orderItem.count({ where: { productId: id } })
    if (orderItems > 0) {
      throw new ConflictException('Товар уже есть в истории заказов. Его можно скрыть, но удалить навсегда нельзя.')
    }
    await this.prisma.product.delete({ where: { id } })
    await this.audit.log(userId, 'DELETE_PRODUCT', 'Product', String(id), { sku: existing.sku, name: existing.name })
    return { ok: true, id }
  }

  private async getAdmin(id: number) {
    const product = await this.prisma.product.findUnique({ where: { id } })
    if (!product) throw new NotFoundException('Товар не найден')
    return product
  }
}
