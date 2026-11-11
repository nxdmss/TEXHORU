import type { CartLine, Product } from './types'
import { featuredPhoneImage } from './catalog-navigation'

const money = new Intl.NumberFormat('ru-RU')
export const formatMoney = (value: number) => money.format(value) + ' ₽'
export const productImage = (product: Pick<Product, 'name' | 'image'>) => /iphone\s*\d+/i.test(product.name)
  ? featuredPhoneImage(product.name, product.image) : product.image
export const cartLimit = (product: Product) => product.stock === 'Под заказ' ? Number.MAX_SAFE_INTEGER
  : Math.max(0, Math.floor(product.stockQty ?? Number.MAX_SAFE_INTEGER))

export function restoreCart(raw: string | null): CartLine[] {
  try {
    const value: unknown = JSON.parse(raw || '[]')
    if (!Array.isArray(value)) return []
    const seen = new Set<number>()
    return value.slice(0, 100).filter((line): line is CartLine => {
      const p = line?.product
      if (!p || !Number.isInteger(p.id) || p.id <= 0 || seen.has(p.id)
        || typeof p.name !== 'string' || typeof p.image !== 'string'
        || !Number.isFinite(p.price) || p.price <= 0 || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) return false
      seen.add(p.id)
      return true
    })
  } catch { return [] }
}
