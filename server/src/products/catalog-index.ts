import { PrismaService } from '../prisma/prisma.service'
import { phoneVariantIndex } from './phone-uniqueness'
import { storefrontPath, isSmartphonePath } from './storefront-path'
// One process-wide promise prevents two catalog readers doing the same migration.
const running = new WeakMap<object, Promise<void>>()
export async function refreshCatalogIndexes(db: PrismaService) {
  const pending = running.get(db)
  if (pending) return pending
  const operation = (async () => {
    let after = 0
    while (true) {
      const rows = await db.product.findMany({ where: { id: { gt: after }, OR: [{ importVariantKey: null }, { browsePath: null }, { searchText: null }] },
        select: { id: true, name: true, brand: true, sku: true, shortSpec: true, gtin: true, mpn: true, attributes: true, category: { select: { name: true } }, updatedAt: true }, orderBy: { id: 'asc' }, take: 200 })
      if (!rows.length) return
      await db.$transaction(rows.map(row => db.product.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: {
        importVariantKey: phoneVariantIndex(row), isPhone: isSmartphonePath(row.category.name), browsePath: storefrontPath(row.category.name, row.name), searchText: `${row.name} ${row.brand} ${row.sku} ${row.shortSpec}`.toLocaleLowerCase('ru-RU'), updatedAt: row.updatedAt,
      } })))
      after = rows.at(-1)!.id
    }
  })()
  running.set(db, operation)
  try { await operation } finally { if (running.get(db) === operation) running.delete(db) }
}
