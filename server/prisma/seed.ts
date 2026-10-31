import 'dotenv/config'
import { PrismaClient, UserRole } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()
async function main() {
  // Clean installations contain no invented categories, products or promos.
  // The first 1C import supplies the real category names and hierarchy.
  // Keep seeding the admin account only.

  const email = (process.env.ADMIN_EMAIL ?? 'director@texhoru.local').toLowerCase()
  const password = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!'
  const passwordHash = await bcrypt.hash(password, 12)
  await prisma.user.upsert({
    where: { email },
    update: { name: 'Директор TEXHORU', passwordHash, role: UserRole.DIRECTOR },
    create: { email, name: 'Директор TEXHORU', passwordHash, role: UserRole.DIRECTOR },
  })
  const productCount = await prisma.product.count()
  console.log(`Seed ready: ${productCount} products. Categories and promotions come from real imports. Admin: ${email}`)
}

main().finally(() => prisma.$disconnect())
