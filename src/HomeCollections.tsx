import { CategoryIllustration } from './CategoryDrawer'
import { productImage } from './store-utils'
import type { Product } from './types'
import { categorySelection, categoryMenuRoot, childrenAtPath, type OneCNode } from './onec-category-tree'
import { storefrontPath, browseLabel } from './catalog-navigation'
import { ProductImage } from './ProductImage'
import { Icon } from './Icon'
export function HomeCollections({ products, roots, onSelect }: { products: Product[]; roots: OneCNode[]; onSelect: (selection: string) => void }) {
  const root = categoryMenuRoot(roots)
  const categories = childrenAtPath(roots, root.path).slice(0, 6)
  if (categories.length < 2) return null
  return <section className="home-collections" aria-label="Категории магазина"><div className="home-section-label"><span>НАЙДИТЕ СВОЁ</span><span>КАТАЛОГ / TEXHORU</span></div><div className="home-collections__grid">{categories.map((node, index) => {
    const cover = products.find(p => { const path = storefrontPath(p.category, p.name); return (path === node.path || path.startsWith(node.path + ' / ')) && !/\/products\/(?:phone(?:-alt)?|iphone-cut-[\w-]+)\.svg(?:[?#]|$)/.test(productImage(p)) })
    return <button key={node.path} onClick={() => onSelect(categorySelection(node.path))}><span className="home-collection-no">0{index + 1}</span><div className="home-collection-image">{cover ? <ProductImage name={cover.name} image={cover.image} alt="" /> : <CategoryIllustration title={node.title} />}</div><div className="home-collection-caption"><strong>{browseLabel(node.title)}</strong><Icon name="arrow" /></div></button>
  })}</div></section>
}
