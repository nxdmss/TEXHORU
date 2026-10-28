import { useMemo, useState, type ReactNode } from 'react'
import { categorySegments, categoryTree, type OneCNode } from './onec-category-tree'
import './AdminCategoryTree.css'

type Props = {
  categoryNames: string[]
  productCategoryNames: string[]
  selectedPath: string
  onSelect: (path: string) => void
}

/** Compact folder navigator; database keeps the 1C full category path unchanged. */
export function AdminCategoryTree({ categoryNames, productCategoryNames, selectedPath, onSelect }: Props) {
  const [expanded, setExpanded] = useState<string[]>([])
  const roots = useMemo(() => {
    const tree = categoryTree([...new Set([...categoryNames, ...productCategoryNames])])
    const counts = new Map<string, number>()
    for (const path of productCategoryNames) {
      const segments = categorySegments(path)
      for (let i = 1; i <= segments.length; i++) {
        const key = segments.slice(0, i).join(' / ')
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    }
    const countNodes = (nodes: OneCNode[]) => {
      for (const node of nodes) {
        node.count = counts.get(node.path) || 0
        countNodes(node.children)
      }
    }
    countNodes(tree)
    return tree
  }, [categoryNames, productCategoryNames])

  const isExpanded = (path: string) => expanded.includes(path) || selectedPath.startsWith(path + ' / ')
  const render = (nodes: OneCNode[], depth: number): ReactNode => nodes.map(node => {
    const children = node.children.length > 0
    const opened = children && isExpanded(node.path)
    return <div className="admin-tree-branch" key={node.path}>
      <button type="button" className={'admin-tree-node' + (selectedPath === node.path ? ' active' : '')}
        style={{ paddingLeft: Math.min(depth, 8) * 13 + 10 }}
        onClick={() => {
          onSelect(node.path)
          if (children) setExpanded(values =>
            values.includes(node.path) ? values.filter(x => x !== node.path) : [...values, node.path])
        }}>
        <span className={'admin-tree-chevron' + (opened ? ' is-open' : '')} aria-hidden="true">{children ? '▸' : '·'}</span>
        <span className="admin-tree-label">{node.title}</span>
        <span className="admin-tree-count">{node.count}</span>
      </button>
      {opened && <div className="admin-tree-children">{render(node.children, depth + 1)}</div>}
    </div>
  })

  return <nav className="admin-tree-nav" aria-label="Дерево групп и подгрупп 1С">
    <button type="button" className={'admin-tree-node admin-tree-all' + (!selectedPath ? ' active' : '')} onClick={() => onSelect('')}>
      <span className="admin-tree-chevron" aria-hidden="true">▦</span>
      <span className="admin-tree-label">Все разделы</span>
      <span className="admin-tree-count">{productCategoryNames.length}</span>
    </button>
    {render(roots, 0)}
  </nav>
}
