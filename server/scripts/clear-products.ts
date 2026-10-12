import { config } from 'dotenv'
import { PrismaClient } from '@prisma/client'

config({ path: process.env.TEXHORU_ENV_FILE ?? '.env' })
const prisma = new PrismaClient()

async function main() {
  const productCount = await prisma.product.count()
  if (productCount === 0) {
    console.log('Catalog is already empty. Nothing to delete.')
    return
  }

  const linked = await prisma.orderItem.findMany({ select: { orderId: true } })
  const orderIds = [...new Set(linked.map((item) => item.orderId))]

  await prisma.$transaction(async (tx) => {
    if (orderIds.length) {
      await tx.payment.deleteMany({ where: { orderId: { in: orderIds } } })
      await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } })
      await tx.order.deleteMany({ where: { id: { in: orderIds } } })
    }
    await tx.product.deleteMany({})
  })

  console.log(`Deleted ${productCount} products.`)
  if (orderIds.length) console.log(`Also deleted ${orderIds.length} local test orders linked to those products.`)
  console.log('Categories, admin user and promo banners were preserved.')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
