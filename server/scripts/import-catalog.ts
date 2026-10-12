import { config } from 'dotenv'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Prisma, PrismaClient, ProductStatus, StockState } from '@prisma/client'

config({ path: process.env.TEXHORU_ENV_FILE ?? '.env' })

const prisma = new PrismaClient()

type CatalogExport = {
  format: string
  categories: Array<{ oneCId?: string | null; slug: string; name: string; sortOrder: number; isActive: boolean }>
  products: Array<{
    oneCId?: string | null
    sku: string
    slug: string
    name: string
    brand: string
    description: string
    shortSpec: string
    image: string
    price: number
    oldPrice?: number | null
    stockQty: number
    stockState: StockState
    status: ProductStatus
    badge?: string | null
    warranty: string
    deliveryNote: string
    specs: Prisma.JsonValue
    categorySlug: string
  }>
  promos: Array<{
    kicker: string
    title: string
    body: string
    ctaLabel: string
    category: string
    image: string
    tone: string
    sortOrder: number
    isActive: boolean
  }>
}

async function main() {
  const input = process.argv[2]
  if (!input) throw new Error('Usage: npm run data:import -- <path-to-catalog.json>')

  const file = path.resolve(process.cwd(), input)
  const payload = JSON.parse(await readFile(file, 'utf8')) as CatalogExport
  if (payload.format !== 'texhoru-catalog-v1') throw new Error(`Unsupported catalog format: ${payload.format}`)

  for (const category of payload.categories) {
    await prisma.category.upsert({
      where: { slug: category.slug },
      create: category,
      update: category,
    })
  }

  for (const product of payload.products) {
    const category = await prisma.category.findUnique({ where: { slug: product.categorySlug } })
    if (!category) throw new Error(`Category not found for product ${product.sku}: ${product.categorySlug}`)

    const { categorySlug: _categorySlug, specs, ...data } = product
    const normalized = {
      ...data,
      categoryId: category.id,
      reservedQty: 0,
      specs: specs as Prisma.InputJsonValue,
    }

    await prisma.product.upsert({
      where: { sku: product.sku },
      create: normalized,
      update: normalized,
    })
  }

  await prisma.promoBanner.deleteMany()
  if (payload.promos.length) await prisma.promoBanner.createMany({ data: payload.promos })

  console.log(`Catalog imported from ${file}`)
  console.log(`Categories: ${payload.categories.length}, products: ${payload.products.length}, promos: ${payload.promos.length}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
