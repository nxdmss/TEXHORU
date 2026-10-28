import { useMemo } from 'react'
import { categorySegments, categoryTree, childrenAtPath } from './onec-category-tree'
import './AdminCategoryTree.css'

type Props = {
  categoryNames: string[]
  productCategoryNames: string[]
  selectedPath: string
  onSelect: (path: string) => void
}

/**
 * One level at a time instead of an endless expanded 1C tree.
 * Each click enters a folder, with a clear breadcrumb/back path.
 */
export function AdminCategoryTree({ categoryNames, productCategoryNames, selectedPath, onSelect }: Props) {
  const roots = useMemo(() => categoryTree([...new Set([...categoryNames, ...productCategoryNames])]),
    [categoryNames, productCategoryNames])
  const folders = childrenAtPath(roots, selectedPath)
  const parts = categorySegments(selectedPath).filter((_, index, all) => !(all.length === 1 && !selectedPath && index === 0))
  const parent = parts.slice(0, -1).join(' / ')
  const count = (path: string) => productCategoryNames.filter(p => p === path || p.startsWith(path + ' / ')).length
  const total = productCategoryNames.length
  const title = parts.at(-1) || 'Все разделы'

  return <nav className="admin-tree-nav" aria-label="Категории товаров">
    <div className="admin-tree-location">
      {selectedPath && <button className="admin-tree-back" type="button" onClick={() => onSelect(parent)}>← Назад</button>}
      <span className="admin-tree-kicker">Сейчас открыто</span>
      <strong>{title}</strong>
      <small>{selectedPath ? count(selectedPath) : total} товаров</small>
    </div>
    <div className="admin-tree-level" key={selectedPath || 'root'}>
      {folders.map(child => <button key={child.path} type="button" className="admin-tree-node"
        onClick={() => onSelect(child.path)}>
        <span className="admin-tree-icon" aria-hidden="true">▣</span>
        <span className="admin-tree-label">{child.title}</span>
        <span className="admin-tree-count">{count(child.path)}</span>
        <span className="admin-tree-arrow" aria-hidden="true">›</span>
      </button>)}
      {!folders.length && <div className="admin-tree-leaf">В этой папке — товары. Выбери карточку справа.</div>}
    </div>
    {selectedPath && <button type="button" className="admin-tree-root" onClick={() => onSelect('')}>Все категории</button>}
  </nav>
}
