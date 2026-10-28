import type { ReactNode } from 'react'
import type { Product } from './types'
import { featuredPhoneImage } from './catalog-navigation'
import './smartphone-journey.css'

export type ShopBrand = { name: string; slug: string; count: number }

const slug = (label: string) => label.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '')

export function isSmartphone(product: Product) {
  const category = product.category.toLowerCase()
  return /смартфон|smartphone/.test(category) && !/аксессуар|чехол|чехлы|защитн|кабель/.test(category)
}

export function brandForProduct(product: Product) {
  const last = product.category.split(' / ').at(-1) || ''
  const categoryBrand = last.replace(/^(смартфоны?|smartphones?)\s+/i, '').trim()
  let brand = categoryBrand && !/^(смартфоны?|smartphones?)$/i.test(categoryBrand)
    ? categoryBrand : product.brand.trim()
  if (!brand || /^(смартфоны?|телефоны?)$/i.test(brand)) {
    brand = product.name.match(/(?:смартфон\s+)?(Apple|Samsung|Xiaomi|Honor|Realme|Poco|Redmi|Tecno|Infinix|Vivo|Oppo|Google)/i)?.[1] || 'Другие'
  }
  if (/^(iPhone|Apple)$/i.test(brand)) return 'Apple'
  if (/^(Redmi|Poco|Xiaomi)$/i.test(brand)) return 'Xiaomi'
  if (/^(Galaxy|Samsung)$/i.test(brand)) return 'Samsung'
  return brand
}

export function shopBrands(products: Product[]): ShopBrand[] {
  const counts = new Map<string, number>()
  for (const product of products.filter(isSmartphone)) {
    const name = brandForProduct(product)
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  return [...counts].map(([name,count])=>({name,slug:slug(name),count}))
    .sort((a,b) => (a.name === 'Apple' ? -1 : b.name === 'Apple' ? 1 : a.name.localeCompare(b.name,'ru')))
}

type OpenAction = (path: string, source?: HTMLElement | null) => void
const photo = featuredPhoneImage('Apple iPhone 17 Pro 256 Гб оранжевый')

export function SmartphonePortal({ onOpen }: { onOpen: OpenAction }) {
  return <section className="phone-portal" aria-label="Смартфоны">
    <button type="button" className="phone-portal__button" onClick={e => onOpen('/catalog/smartphones', e.currentTarget.querySelector('strong'))}>
      <div className="phone-portal__visual">
        <img src={photo} alt="Apple iPhone 17 Pro, настоящий внешний вид смартфона" loading="eager"
          onError={e => { e.currentTarget.src='/products/phone.svg' }} />
      </div>
      <div className="phone-portal__copy"><span className="phone-portal__eyebrow">Каталог / 01</span>
        <strong>СМАРТФОНЫ</strong>
        <span className="phone-portal__link">Открыть раздел <span aria-hidden="true">↗</span></span>
      </div>
    </button>
  </section>
}

export function SmartphoneJourney({ brands, activeBrand, onOpen, children, count }: {
  brands: ShopBrand[]; activeBrand?: ShopBrand; onOpen: OpenAction; children?: ReactNode; count?: number
}) {
  const inBrand = Boolean(activeBrand)
  const heading = activeBrand?.name || 'СМАРТФОНЫ'
  return <section className="phone-journey" key={activeBrand?.slug || 'smartphones'}>
    <nav className="phone-journey__back" aria-label="Путь по каталогу">
      <button onClick={() => onOpen('/')} type="button">Главная</button>
      <span>/</span>
      {inBrand ? <button onClick={() => onOpen('/catalog/smartphones')} type="button">Смартфоны</button>
        : <strong>Смартфоны</strong>}
      {inBrand && <><span>/</span><strong>{heading}</strong></>}
    </nav>
    <header className="phone-journey__intro">
      <p>TEXHORU / КАТАЛОГ</p>
      <h1 className="phone-journey__heading">{heading}</h1>
      {inBrand ? <p className="phone-journey__subheading">Смартфоны {heading} · {count ?? 0} товаров</p>
        : <p className="phone-journey__subheading">Выбери производителя</p>}
    </header>
    {inBrand ? <div className="phone-journey__inventory">{children}</div>
      : <nav className="phone-journey__brands" aria-label="Бренды смартфонов">
        {brands.map(brand => <button className="phone-journey__brand" key={brand.slug} type="button"
          onClick={e => onOpen('/catalog/smartphones/' + encodeURIComponent(brand.slug), e.currentTarget.querySelector('span'))}>
          <span>{brand.name}</span>
          <small>{brand.count}</small>
        </button>)}
        {brands.length === 0 && <p className="phone-journey__empty">Смартфоны появятся после загрузки каталога из 1С.</p>}
      </nav>}
  </section>
}
