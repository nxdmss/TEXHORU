import { useEffect, useMemo, useRef, useState } from 'react'
import { CategoryIllustration } from './CategoryDrawer'
import { ProductImage } from './ProductImage'
import { productImage } from './store-utils'
import type { Product } from './types'

type BrandFamily = {
  id: string
  label: string
  match: RegExp
  model: (name: string) => string
}

const matched = (name: string, pattern: RegExp, fallback: string) => name.match(pattern)?.[1]?.replace(/\s+/g, ' ').trim() || fallback

const families: BrandFamily[] = [
  { id: 'iphone', label: 'iPhone', match: /\biphone\b/i, model: name => matched(name, /\b(iPhone\s*\d{1,2}(?:\s*(?:Pro\s*Max|Pro|Plus|Air|Mini|e))?)/i, 'iPhone') },
  { id: 'xiaomi', label: 'Xiaomi', match: /\b(?:xiaomi|redmi|poco)\b/i, model: name => matched(name, /\b((?:Xiaomi|Redmi|POCO)\s+[A-Z0-9]+(?:\s+(?:Pro\s*Max|Pro|Ultra|Max|Plus|Lite|5G))?)/i, 'Xiaomi') },
  { id: 'samsung', label: 'Samsung', match: /\b(?:samsung|galaxy)\b/i, model: name => matched(name, /\b((?:Samsung\s+)?Galaxy\s+[SAZ]\d{2,3}(?:\s+(?:Ultra|Plus|FE|Fold|Flip))?)/i, 'Samsung Galaxy') },
  { id: 'honor', label: 'HONOR', match: /\bhonor\b/i, model: name => matched(name, /\b(HONOR\s+(?:X\d+[A-Z]*|\d+)(?:\s+Pro)?)/i, 'HONOR') },
  { id: 'huawei', label: 'HUAWEI', match: /\bhuawei\b/i, model: name => matched(name, /\b(Huawei\s+(?:Nova\s+\d+(?:\s+Max)?|Mate\s+\w+|Pura\s+\w+))/i, 'HUAWEI') },
  { id: 'playstation', label: 'PlayStation', match: /\b(?:playstation|ps\s*[45]|ps[45])\b/i, model: name => /(?:playstation|ps\s*5|ps5)/i.test(name) ? 'PlayStation 5' : 'PlayStation 4' },
  { id: 'macbook', label: 'MacBook', match: /\bmacbook\b/i, model: name => matched(name, /\b(MacBook\s+(?:Air|Pro)(?:\s+\d{2})?(?:\s+M\d(?:\s+(?:Pro|Max))?)?)/i, 'MacBook') },
  { id: 'matebook', label: 'MateBook', match: /\bmatebook\b/i, model: name => matched(name, /\b((?:Huawei\s+)?MateBook\s+[A-Z0-9-]+(?:\s+\d{4})?)/i, 'HUAWEI MateBook') },
  { id: 'vivobook', label: 'ASUS', match: /\b(?:asus|vivobook|zenbook)\b/i, model: name => matched(name, /\b((?:ASUS\s+)?(?:VivoBook|ZenBook)\s+[A-Z0-9-]+)/i, 'ASUS') },
  { id: 'acer', label: 'Acer', match: /\b(?:acer|aspire)\b/i, model: name => matched(name, /\b((?:Acer\s+)?Aspire\s+[A-Z0-9-]+)/i, 'Acer Aspire') },
  { id: 'xbook', label: 'Infinix XBOOK', match: /\b(?:infinix\s+)?xbook\b/i, model: name => matched(name, /\b((?:Infinix\s+)?XBOOK\s+[A-Z0-9-]+)/i, 'Infinix XBOOK') },
  { id: 'realme', label: 'realme', match: /\brealme\b/i, model: name => matched(name, /\b(realme\s+[A-Z0-9]+(?:\s+Pro)?)/i, 'realme') },
  { id: 'tecno', label: 'TECNO', match: /\btecno\b/i, model: name => matched(name, /\b(TECNO\s+[A-Z]+\s+\d+(?:\s+Ultra)?)/i, 'TECNO') },
  { id: 'pixel', label: 'Google Pixel', match: /\b(?:google\s+)?pixel\b/i, model: name => matched(name, /\b((?:Google\s+)?Pixel\s+\d+(?:\s+Pro)?)/i, 'Google Pixel') },
  { id: 'oppo', label: 'OPPO', match: /\boppo\b/i, model: name => matched(name, /\b(OPPO\s+[A-Z]+\d+(?:\s+(?:Pro|5G))?)/i, 'OPPO') },
  { id: 'vivo', label: 'vivo', match: /\bvivo\b/i, model: name => matched(name, /\b(vivo\s+[A-Z]\d+(?:\s+Pro)?)/i, 'vivo') },
  { id: 'infinix', label: 'Infinix', match: /\binfinix\b/i, model: name => matched(name, /\b(Infinix\s+[A-Z]+(?:\s+\d+)?(?:\s+Pro)?)/i, 'Infinix') },
  { id: 'nintendo', label: 'Nintendo', match: /\bnintendo\b/i, model: name => matched(name, /\b(Nintendo\s+Switch(?:\s+(?:OLED|Lite))?)/i, 'Nintendo Switch') },
  { id: 'xbox', label: 'Xbox', match: /\bxbox\b/i, model: name => matched(name, /\b(Xbox\s+Series\s+[XS])/i, 'Xbox') },
  { id: 'jbl', label: 'JBL', match: /\bjbl\b/i, model: name => matched(name, /\b(JBL\s+[A-Z0-9-]+)/i, 'JBL') },
]

type ModelEntry = { label: string; query: string; product: Product }
type FamilyEntry = BrandFamily & { models: ModelEntry[] }

const hasPhoto = (product: Product) => !/\/products\/phone(?:-alt)?\.svg(?:[?#]|$)/.test(productImage(product))

function familyEntries(products: Product[]): FamilyEntry[] {
  return families.map(family => {
    const models = new Map<string, ModelEntry>()
    for (const product of products) {
      if (!family.match.test(`${product.name} ${product.brand} ${product.category}`)) continue
      const label = family.model(product.name)
      const key = label.toLocaleLowerCase('ru-RU')
      const current = models.get(key)
      if (!current || (!hasPhoto(current.product) && hasPhoto(product))) models.set(key, { label, query: label, product })
    }
    return { ...family, models: [...models.values()].slice(0, 7) }
  }).filter(family => family.models.length)
}

export function BrandNavigation({ products, onSelectModel }: { products: Product[]; onSelectModel: (query: string) => void }) {
  const entries = useMemo(() => familyEntries(products), [products])
  const [activeId, setActiveId] = useState('')
  const closeTimer = useRef<number | null>(null)
  const active = entries.find(entry => entry.id === activeId)

  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const closeSoon = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setActiveId(''), 130)
  }
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setActiveId('') }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape); cancelClose() }
  }, [])

  if (!entries.length) return <div className="brand-navigation brand-navigation--loading" aria-hidden="true" />
  return <nav className="brand-navigation" aria-label="Модельные ряды" onMouseEnter={cancelClose} onMouseLeave={closeSoon}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setActiveId('') }}>
    <div className="brand-navigation__rail">
      {entries.map(entry => <button type="button" key={entry.id} className={activeId === entry.id ? 'is-active' : ''}
        aria-expanded={activeId === entry.id} onMouseEnter={() => setActiveId(entry.id)} onFocus={() => setActiveId(entry.id)}
        onClick={() => setActiveId(entry.id)}>{entry.label}</button>)}
    </div>
    {active && <section className="brand-navigation__panel" aria-label={`Модельный ряд ${active.label}`}>
      <div className="brand-navigation__models">
        {active.models.map(model => <button type="button" key={model.label} aria-label={`Открыть ${model.label}`}
          onClick={() => { setActiveId(''); onSelectModel(model.query) }}>
          <span className="brand-navigation__visual">{hasPhoto(model.product)
            ? <ProductImage name={model.product.name} image={model.product.image} alt="" />
            : <CategoryIllustration title={active.label} />}</span>
          <strong>{model.label}</strong>
        </button>)}
      </div>
    </section>}
  </nav>
}

