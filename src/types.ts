export type Category = 'Все' | 'Смартфоны' | 'Телевизоры' | 'Ноутбуки' | 'Аудио' | 'Для дома'

export type ProductSpec = {
  label: string
  value: string
}

export type Product = {
  id: number
  oneCId?: string
  sku?: string
  slug?: string
  name: string
  category: Exclude<Category, 'Все'>
  brand: string
  price: number
  oldPrice?: number
  badge?: string
  stock: 'В наличии' | 'Мало' | 'Под заказ'
  stockQty?: number
  image: string
  shortSpec: string
  description: string
  specs: ProductSpec[]
  warranty: string
  deliveryNote: string
}

export type CartLine = {
  product: Product
  quantity: number
}

export type OrderStatus = 'Собирается' | 'Готов к выдаче' | 'Доставляется' | 'Получен' | 'Отменён'

export type AccountOrder = {
  id: string
  date: string
  status: OrderStatus
  total: number
  items: string[]
  delivery: string
}
