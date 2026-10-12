import { config } from 'dotenv'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

config({ path: process.env.TEXHORU_ENV_FILE ?? '.env' })

const prisma = new PrismaClient()

async function main() {
  const categories = await prisma.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
  const products = await prisma.product.findMany({ include: { category: true }, orderBy: { id: 'asc' } })
  const promos = await prisma.promoBanner.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })

  const payload = {
    format: 'texhoru-catalog-v1',
    exportedAt: new Date().toISOString(),
    categories: categories.map(({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...item }) => item),
    products: products.map(({ id: _id, categoryId: _categoryId, category, createdAt: _createdAt, updatedAt: _updatedAt, reservedQty: _reservedQty, ...item }) => ({
      ...item,
      categorySlug: category.slug,
      specs: item.specs,
    })),
    promos: promos.map(({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...item }) => item),
  }

  const dir = path.resolve(process.cwd(), 'backups')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `catalog-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await writeFile(file, JSON.stringify(payload, null, 2), 'utf8')
  console.log(`Catalog exported: ${file}`)
  console.log(`Categories: ${payload.categories.length}, products: ${payload.products.length}, promos: ${payload.promos.length}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
