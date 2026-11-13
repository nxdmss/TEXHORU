import { CategoryIllustration } from './CategoryDrawer'
import { ProductImage } from './ProductImage'
import { Icon } from './Icon'
import { productImage } from './store-utils'
import { ALL_CATALOG, categorySelection, categoryMenuRoot, type OneCNode } from './onec-category-tree'
import { storefrontPath, browseLabel } from './catalog-navigation'
import type { Product } from './types'

export function HomeCollections({ products, roots, onSelect, onSmartphones, title }: {
  products: Product[]
  roots: OneCNode[]
  onSelect: (selection: string) => void
  onSmartphones: () => void
  title?: string
}) {
  const categories = categoryMenuRoot(roots).nodes.slice(0, 6)
  if (!categories.length) return null
  return <section className="home-collections" aria-label="Категории магазина">
    <header className="home-collections__head">
      <h2>{title || 'Категории'}</h2>
      <button type="button" onClick={() => onSelect(ALL_CATALOG)}>Весь каталог <Icon name="arrow" /></button>
    </header>
    <div className="home-collections__grid">{categories.map((node, index) => {
      const cover = products.find(product => {
        const path = storefrontPath(product.category, product.name)
        return (path === node.path || path.startsWith(node.path + ' / '))
          && !/\/products\/(?:phone(?:-alt)?|iphone-cut-[\w-]+)\.svg(?:[?#]|$)/.test(productImage(product))
      })
      const title = browseLabel(node.title)
      return <button type="button" key={node.path} aria-label={`Открыть категорию ${title}`}
        style={{ animationDelay: `${index * 45}ms` }}
        onClick={() => /^смартфоны?$/i.test(node.title) ? onSmartphones() : onSelect(categorySelection(node.path))}>
        <div className="home-collection-image">{cover
          ? <ProductImage name={cover.name} image={cover.image} alt="" />
          : <CategoryIllustration title={node.title} />}</div>
        <div className="home-collection-caption"><strong>{title}</strong><Icon name="arrow" /></div>
      </button>
    })}</div>
  </section>
}
