import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { ProductStatus, StockState } from '@prisma/client'
import { AuditService } from '../audit/audit.service'
import { PrismaService } from '../prisma/prisma.service'
import { CreateCategoryDto, UpdateCategoryDto, UpdateProductDto, UpsertProductDto } from './products.dto'
import { phoneVariantKey, uniquePhoneProducts } from './phone-uniqueness'
import { OneCPriceSyncService } from '../integrations/price-sync.service'

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list() {
    const rows = await this.prisma.product.findMany({ where: { status: ProductStatus.ACTIVE }, include: { category: true }, orderBy: [{ category: { sortOrder: 'asc' } }, { id: 'asc' }] })
    // A 1C item is public only if it has a sellable price and free stock.
    // This applies to every category (laptops, accessories, phones), not just smartphones.
    const visible = rows.filter(item => !item.oneCId
      || (item.price > 0 && item.stockQty > item.reservedQty))
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
    if (!product || (product.oneCId && (product.price <= 0
      || product.stockQty <= product.reservedQty))) throw new NotFoundException('Товар не найден')
    const available = Math.max(0, product.stockQty - product.reservedQty)
    const stockState = product.stockState === StockState.PREORDER ? StockState.PREORDER : available <= 0 ? StockState.OUT_OF_STOCK : available <= 3 ? StockState.LOW : StockState.IN_STOCK
    return { ...product, stockQty: available, stockState }
  }

  categories() { return this.prisma.category.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }) }
  adminCategories() { return this.prisma.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }) }
  async adminList() {
    const rows = await this.prisma.product.findMany({ include: { category: true }, orderBy: { updatedAt: 'desc' } })
    const preferred = [...rows].sort((a, b) =>
      Number(a.stockQty <= a.reservedQty) - Number(b.stockQty <= b.reservedQty) || a.id - b.id)
    const keeper = new Map<string, number>()
    const duplicateOf = new Map<number, number>()
    for (const row of preferred) {
      if (row.status !== ProductStatus.ACTIVE) continue
      const key = phoneVariantKey(row)
      if (!key) continue
      const existing = keeper.get(key)
      if (existing !== undefined) duplicateOf.set(row.id, existing)
      else keeper.set(key, row.id)
    }
    // Records with orders / 05.ru associations stay in DB; admin can still
    // inspect the duplicates instead of silently deleting them.
    return rows.map(row => ({ ...row, duplicateOf: duplicateOf.get(row.id) || null }))
  }

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
    // Editing the retail price on the site MUST use the same durable 1C queue
    // as an approved monitor recommendation. Never silently update only the
    // website for a 1C-owned item without an enabled 1C exchange scope.
    return this.prisma.$transaction(async tx => {
      const existing = await tx.product.findUnique({ where: { id } })
      if (!existing) throw new NotFoundException('Товар не найден')
      if (existing.oneCId && dto.oneCId !== undefined && dto.oneCId !== existing.oneCId) {
        throw new BadRequestException('GUID товара из 1С нельзя менять из админки')
      }
      const priceChanged = dto.price !== undefined && dto.price !== existing.price
      let changeId: string | null = null
      if (priceChanged && existing.oneCId) {
        if (!existing.priceSyncEnabled) {
          throw new BadRequestException('Цена принадлежит 1С. Сначала включи товар в подтверждённую группу обмена 1С → TEXHORU → 1С.')
        }
        if (dto.price! < 1 || dto.price! > 5_000_000) {
          throw new BadRequestException('Для обмена с 1С цена должна быть от 1 до 5 000 000 ₽')
        }
        const queued = await OneCPriceSyncService.queue(tx, existing, dto.price!, null)
        changeId = queued?.id || null
        if (!changeId) throw new ConflictException('Не удалось поставить изменение цены в очередь 1С')
      }
      const changed = await tx.product.updateMany({
        where: { id, price: existing.price },
        data: { ...dto, stockState: dto.stockState as StockState | undefined, specs: dto.specs },
      })
      if (changed.count !== 1) throw new ConflictException('Цена изменилась параллельно. Обнови страницу')
      const item = await tx.product.findUniqueOrThrow({ where: { id } })
      await tx.auditLog.create({ data: {
        userId, action: priceChanged && changeId ? 'UPDATE_PRODUCT_PRICE_1C_QUEUED' : 'UPDATE_PRODUCT',
        entity: 'Product', entityId: String(item.id),
        details: { sku: item.sku, fields: Object.keys(dto), previousPrice: existing.price,
          newPrice: item.price, oneCMessageId: changeId, oneCQueued: Boolean(changeId) },
      } })
      return item
    })
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
