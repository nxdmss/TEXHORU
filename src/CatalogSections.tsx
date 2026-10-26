import { ALL_CATALOG, categorySelection, categorySegments, categoryTree, childrenAtPath, selectedCategoryPath } from './onec-category-tree'
import { catalogBranches, type CatalogEntry } from './catalog-groups'

export function CatalogSections({ items, selection, onSelect, hierarchical = false }: { items: CatalogEntry[]; selection: string; onSelect: (value: string) => void; searching?: boolean; hierarchical?: boolean }) {
  if (hierarchical) return <OneCCatalogSections items={items} selection={selection} onSelect={onSelect} />
  const branches = catalogBranches(items)
  const branch = branches.find(item => selection === item.id || selection.startsWith(item.id + '/'))
  return <div className="catalog-strip">
    <nav className="catalog-strip__sections" aria-label="Разделы каталога"><button aria-pressed={!selection} className={!selection ? 'active' : ''} onClick={() => onSelect('')}>Все товары</button>{branches.map(item => <button key={item.id} aria-pressed={branch?.id === item.id} className={branch?.id === item.id ? 'active' : ''} onClick={() => onSelect(item.id)}>{item.title}<span>{item.count}</span></button>)}</nav>
    {branch && branch.children.length > 1 && <nav className="catalog-strip__subsections" aria-label="Подразделы"><button aria-pressed={selection === branch.id} className={selection === branch.id ? 'active' : ''} onClick={() => onSelect(branch.id)}>Все в разделе</button>{branch.children.map(item => <button key={item.id} aria-pressed={selection === item.id} className={selection === item.id ? 'active' : ''} onClick={() => onSelect(item.id)}>{item.title}</button>)}</nav>}
  </div>
}


function OneCCatalogSections({ items, selection, onSelect }: { items: CatalogEntry[]; selection: string; onSelect: (value: string) => void }) {
  const roots = categoryTree(items.map(item => item.categoryName || 'Без категории'))
  const selectedPath = selectedCategoryPath(selection)
  const segments = selectedPath ? categorySegments(selectedPath) : []
  const currentRoot = segments[0] || ''
  let prefix = ''
  return <div className="catalog-strip">
    <nav className="catalog-strip__sections" aria-label="Основные категории">
      <button className={!selection ? 'active' : ''} aria-pressed={!selection} onClick={() => onSelect('')}>Популярное</button>
      <button className={selection === ALL_CATALOG ? 'active' : ''} aria-pressed={selection === ALL_CATALOG} onClick={() => onSelect(ALL_CATALOG)}>Все товары</button>
      {roots.map(node => <button key={node.path} className={currentRoot === node.title ? 'active' : ''} aria-pressed={currentRoot === node.title} onClick={() => onSelect(categorySelection(node.path))}>{node.title}<span>{node.count}</span></button>)}
    </nav>
    {segments.map((segment, index) => {
      prefix = segments.slice(0, index + 1).join(' / ')
      const children = childrenAtPath(roots, prefix)
      return children.length ? <nav key={prefix} className="catalog-strip__subsections" aria-label={`Подразделы: ${segment}`}>
        <button aria-pressed={selectedPath === prefix} className={selectedPath === prefix ? 'active' : ''} onClick={() => onSelect(categorySelection(prefix))}>Все: {segment}</button>
        {children.map(node => <button key={node.path} className={selectedPath === node.path ? 'active' : ''} aria-pressed={selectedPath === node.path} onClick={() => onSelect(categorySelection(node.path))}>{node.title}<span>{node.count}</span></button>)}
      </nav> : null
    })}
  </div>
}
