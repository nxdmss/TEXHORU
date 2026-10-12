import 'dotenv/config'
import { PrismaClient, UserRole } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()
const categorySlugs: Record<string, string> = {
  'Смартфоны': 'smartphones',
  'Телевизоры': 'tvs',
  'Ноутбуки': 'laptops',
  'Аудио': 'audio',
  'Для дома': 'home',
}

const defaultPromos = [
  { kicker: 'НОВИНКА', title: 'iPhone 18 Pro', body: 'Новая Pro-линейка Apple. Большой акцент на камеру, производительность и автономность.', ctaLabel: 'Смотреть смартфоны', category: 'Смартфоны', image: '/products/phone.svg', tone: 'light', sortOrder: 0 },
  { kicker: 'АКЦИИ', title: 'Телевизоры выгоднее', body: 'Подборка моделей со сниженной ценой и предложениями на большие диагонали.', ctaLabel: 'Перейти к акции', category: 'Телевизоры', image: '/products/tv.svg', tone: 'dark', sortOrder: 1 },
  { kicker: 'РАССРОЧКА', title: 'Ноутбук сейчас. Платёж потом.', body: 'MacBook и Windows-ноутбуки в одной подборке без лишних переходов.', ctaLabel: 'Выбрать ноутбук', category: 'Ноутбуки', image: '/products/laptop.svg', tone: 'red', sortOrder: 2 },
]

async function main() {
  const categoryMap = new Map<string, string>()
  for (const [name, slug] of Object.entries(categorySlugs)) {
    const category = await prisma.category.upsert({ where: { slug }, update: { name }, create: { slug, name } })
    categoryMap.set(name, category.id)
  }

  // Catalog intentionally starts empty. Real products are created in the admin panel
  // or imported from 1C. Seed must never recreate demo products.


  if (await prisma.promoBanner.count() === 0) {
    await prisma.promoBanner.createMany({ data: defaultPromos })
  }

  const email = (process.env.ADMIN_EMAIL ?? 'director@texhoru.local').toLowerCase()
  const password = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!'
  const passwordHash = await bcrypt.hash(password, 12)
  await prisma.user.upsert({
    where: { email },
    update: { name: 'Директор TEXHORU', passwordHash, role: UserRole.DIRECTOR },
    create: { email, name: 'Директор TEXHORU', passwordHash, role: UserRole.DIRECTOR },
  })
  const productCount = await prisma.product.count()
  console.log(`Seed ready: ${productCount} existing products preserved, ${defaultPromos.length} promos. Admin: ${email}`)
}

main().finally(() => prisma.$disconnect())
