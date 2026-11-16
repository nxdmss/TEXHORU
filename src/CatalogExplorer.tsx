import type { CSSProperties } from 'react'
import { Icon } from './Icon'
import { browseLabel } from './catalog-navigation'
import { categorySegments, childrenAtPath, type OneCNode } from './onec-category-tree'

type Props = {
  roots: OneCNode[]
  selectedPath: string
  total: number
  onSelect: (path: string) => void
  onReset: () => void
}

const formatCount = new Intl.NumberFormat('ru-RU')

export function CatalogExplorer({ roots, selectedPath, total, onSelect, onReset }: Props) {
  const parts = categorySegments(selectedPath).filter(part => selectedPath || part !== 'Без категории')
  const children = childrenAtPath(roots, selectedPath)
  const title = parts.at(-1) || 'Каталог'

  return <section className="catalog-explorer" aria-labelledby="catalog-explorer-title">
    <div className="catalog-explorer__intro">
      <div>
        <p className="eyebrow">TEXHORU · каталог</p>
        <h1 id="catalog-explorer-title">{browseLabel(title)}</h1>
      </div>
      <span className="catalog-explorer__total">{formatCount.format(selectedPath ? rootsCount(roots, selectedPath) : total)} товаров</span>
    </div>

    {selectedPath && <nav className="catalog-explorer__crumbs" aria-label="Путь по каталогу">
      <button type="button" onClick={onReset}>Все категории</button>
      {parts.map((part, index) => {
        const path = parts.slice(0, index + 1).join(' / ')
        const current = index === parts.length - 1
        return <span key={path}><Icon name="chevronRight" /><button type="button" aria-current={current ? 'page' : undefined} onClick={() => onSelect(path)}>{browseLabel(part)}</button></span>
      })}
    </nav>}

    {!!children.length && <div className="catalog-explorer__grid">
      {children.map((node, index) => <button type="button" className="catalog-explorer__card" key={node.path}
        style={{ '--catalog-index': index } as CSSProperties} onClick={() => onSelect(node.path)}>
        <span className="catalog-explorer__card-index">{String(index + 1).padStart(2, '0')}</span>
        <span className="catalog-explorer__card-copy"><strong>{browseLabel(node.title)}</strong><small>{formatCount.format(node.count)} товаров</small></span>
        <Icon name="arrow" />
      </button>)}
    </div>}
  </section>
}

function rootsCount(roots: OneCNode[], path: string): number {
  let nodes = roots
  let found: OneCNode | undefined
  for (const part of categorySegments(path)) {
    found = nodes.find(node => node.title === part)
    if (!found) return 0
    nodes = found.children
  }
  return found?.count || 0
}
