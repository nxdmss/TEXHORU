import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { ProductImage } from './ProductImage'
import { productImage } from './store-utils'
import { browseLabel, storefrontPath } from './catalog-navigation'
import { ALL_CATALOG, categoryMenuRoot, categorySelection, categorySegments, childrenAtPath, matchesCategoryPath, type OneCNode } from './onec-category-tree'
import type { Product } from './types'

const categoryPlural = new Intl.PluralRules('ru')
const categoryNouns: Partial<Record<Intl.LDMLPluralRule, string>> = { one: 'товар', few: 'товара', many: 'товаров' }

export function CategoryIllustration({ title }: { title: string }) {
  const name = title.toLowerCase()
  const shape = /наушник|гарнитур|headphone/.test(name)
    ? <><path d="M5 13v-2a7 7 0 0 1 14 0v2"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/></>
    : /кабел|переходник/.test(name)
    ? <><path d="M7 3v5m-2-5h4v5H5zM17 21v-5m-2 5h4v-5h-4zM7 8v5a5 5 0 0 0 10 0V9"/><path d="M17 9V6"/></>
    : /стекл|пл[её]нк|линз/.test(name)
    ? <><rect x="6" y="2" width="12" height="20" rx="2"/><path d="m8 12 8-8M8 17l8-8M10 19h4"/></>
    : /чех|наклад/.test(name)
    ? <><rect x="6" y="2" width="12" height="20" rx="3"/><rect x="8" y="4" width="5" height="6" rx="1"/><circle cx="12" cy="15" r="2"/></>
    : /час|watch/.test(name)
    ? <><path d="m8 7 1-5h6l1 5M8 17l1 5h6l1-5"/><rect x="6" y="7" width="12" height="10" rx="3"/><path d="M12 9v3l2 1"/></>
    : /планшет|tablet|ipad/.test(name)
    ? <><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M7 5h10M11 19h2"/></>
    : /ноутбук|компьютер|монитор/.test(name)
    ? <><rect x="4" y="4" width="16" height="12" rx="1"/><path d="m4 16-2 4h20l-2-4M10 18h4"/></>
    : /роутер|сеть/.test(name)
    ? <><rect x="3" y="12" width="18" height="8" rx="2"/><path d="M6 12V5m12 7V5M7 16h1m3 0h1M8 5a7 7 0 0 1 8 0"/></>
    : /держател|штатив/.test(name)
    ? <><rect x="6" y="2" width="12" height="14" rx="2"/><path d="M12 16v5M6 22h12M10 13h4"/></>
    : /телефон|смартфон|iphone/.test(name)
    ? <><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4M11 19h2"/></>
    : /пзу|power|банк/.test(name)
    ? <><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M10 6h4m-1 3-3 4h4l-3 4"/></>
    : /заряд|сзу|аксессуар/.test(name)
    ? <><path d="M9 2v5m6-5v5"/><rect x="6" y="7" width="12" height="14" rx="3"/><path d="m13 10-3 4h4l-3 4"/></>
    : <><path d="m3 7 9-4 9 4v11l-9 4-9-4zM3 7l9 4 9-4M12 11v11"/></>
  return <svg className="category-menu__illustration" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shape}</svg>
}

export function CategoryDrawer({ products, roots, groups = [], onClose, onSelect, onAccount }: {
  groups?: Array<{ path: string; count: number }>; products: Product[]; roots: OneCNode[]; onClose: () => void; onSelect: (selection: string) => void; onAccount: () => void
}) {
  const [path, setPath] = useState('')
  const root = useMemo(() => categoryMenuRoot(roots), [roots])
  const currentPath = path || root.path
  const atRoot = currentPath === root.path
  const nodes = childrenAtPath(roots, currentPath)
  const current = categorySegments(currentPath).at(-1) || ''
  const panel = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
      if (event.key !== 'Tab') return
      const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
      const first = buttons[0], last = buttons.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => {
      document.body.style.overflow = overflow
      document.removeEventListener('keydown', keyboard)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  function open(node: OneCNode) {
    if (!node.children.length) { onSelect(categorySelection(node.path)); return }
    setPath(node.path)
    requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('.category-menu__back')?.focus())
  }
  function cover(node: OneCNode) {
    return products.find(product => {
      const image = productImage(product)
      return Boolean(image) && matchesCategoryPath(storefrontPath(product.category, product.name), node.path)
        && !/\/products\/(?:phone(?:-alt)?|iphone-cut-[\w-]+)\.svg(?:[?#]|$)/.test(image)
    })
  }
  const count = groups.length ? groups.filter(group => !currentPath || matchesCategoryPath(group.path, currentPath)).reduce((sum, group) => sum + group.count, 0) : products.filter(product => !currentPath || matchesCategoryPath(storefrontPath(product.category, product.name), currentPath)).length
  return <div className="menu-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}>
    <aside className="category-drawer category-menu" id="category-menu" ref={panel} role="dialog" aria-modal="true" aria-label="Каталог товаров">
      <div className="category-drawer__head"><div><span>TEXHORU</span><h2>{atRoot ? 'Категории' : browseLabel(current)}</h2></div>
        <button type="button" ref={closeButton} onClick={onClose} aria-label="Закрыть меню"><Icon name="close" /></button></div>
      <div className="category-menu__body">
        <div className="category-menu__actions">
          {!atRoot && <button type="button" className="category-menu__back" onClick={() => setPath(categorySegments(currentPath).slice(0, -1).join(' / '))}><Icon name="back" />Назад</button>}
          <button type="button" onClick={() => onSelect(atRoot ? ALL_CATALOG : categorySelection(currentPath))}>{atRoot ? 'Все товары' : 'Смотреть товары'}<span>{count}</span><Icon name="arrow" /></button>
        </div>
        <nav className="category-menu__grid" aria-label={atRoot ? 'Категории товаров' : 'Подразделы ' + current}>
          {nodes.map(node => {
            const product = cover(node)
            const total = groups.length ? groups.filter(group => matchesCategoryPath(group.path, node.path)).reduce((sum, group) => sum+group.count, 0) : node.count
            return <button type="button" className="category-menu__tile" key={node.path} onClick={() => open(node)} aria-label={'Открыть раздел ' + node.title}>
              <span className="category-menu__visual">{product ? <ProductImage name={product.name} image={product.image} alt="" /> : <CategoryIllustration title={node.title} />}</span>
              <span className="category-menu__caption"><strong>{browseLabel(node.title)}</strong><small>{total} {categoryNouns[categoryPlural.select(total)] || 'товаров'}</small></span>
              <Icon name="chevronRight" />
            </button>
          })}
        </nav>
        {!nodes.length && <p className="category-menu__empty">Товаров пока нет.</p>}
      </div>
      <div className="category-drawer__footer"><button type="button" onClick={() => onSelect('')}>Популярное<Icon name="arrow" /></button>
        <button type="button" onClick={onAccount}><Icon name="user" />Личный кабинет</button><span>КИЗИЛЮРТ · ДАГЕСТАН</span></div>
    </aside>
  </div>
}
