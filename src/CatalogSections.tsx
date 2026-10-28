import { ALL_CATALOG, categorySelection, categorySegments, categoryTree, childrenAtPath, selectedCategoryPath } from './onec-category-tree'
import { catalogBranches, type CatalogEntry } from './catalog-groups'
import './catalog-navigation.css'

type Props = {
  items: CatalogEntry[]
  selection: string
  onSelect: (value: string) => void
  searching?: boolean
  hierarchical?: boolean
}

export function CatalogSections({ items, selection, onSelect, hierarchical = false, searching = false }: Props) {
  if (hierarchical) return <OneCCatalogSections items={items} selection={selection} onSelect={onSelect} searching={searching} />
  const branches = catalogBranches(items)
  const branch = branches.find(item => selection === item.id || selection.startsWith(item.id + '/'))
  return <div className="catalog-strip">
    <nav className="catalog-strip__sections" aria-label="Разделы каталога"><button aria-pressed={!selection} className={!selection ? 'active' : ''} onClick={() => onSelect('')}>Все товары</button>{branches.map(item => <button key={item.id} aria-pressed={branch?.id === item.id} className={branch?.id === item.id ? 'active' : ''} onClick={() => onSelect(item.id)}>{item.title}<span>{item.count}</span></button>)}</nav>
    {branch && branch.children.length > 1 && <nav className="catalog-strip__subsections" aria-label="Подразделы"><button aria-pressed={selection === branch.id} className={selection === branch.id ? 'active' : ''} onClick={() => onSelect(branch.id)}>Все в разделе</button>{branch.children.map(item => <button key={item.id} className={selection === item.id ? 'active' : ''} onClick={() => onSelect(item.id)}>{item.title}</button>)}</nav>}
  </div>
}

function OneCCatalogSections({ items, selection, onSelect, searching }: Props) {
  const path = selectedCategoryPath(selection) || ''
  const roots = categoryTree(items.map(item => item.categoryName || 'Без категории'))
  const folders = childrenAtPath(roots, path)
  const parts = path ? categorySegments(path) : []
  const title = parts.at(-1) || 'Категории'
  const count = (next: string) => items.filter(item =>
    item.categoryName === next || item.categoryName?.startsWith(next + ' / ')).length
  if (searching) return null
  return <section className="store-category-browser" key={path || 'root'} aria-label="Навигация по категориям">
    {path && <nav className="store-category-crumbs" aria-label="Путь по каталогу">
      <button type="button" onClick={() => onSelect(ALL_CATALOG)}>Каталог</button>
      {parts.map((part, index) => {
        const next = parts.slice(0, index + 1).join(' / ')
        return <span key={next}><span aria-hidden="true">/</span><button type="button"
          aria-current={index === parts.length - 1 ? 'page' : undefined}
          onClick={() => onSelect(categorySelection(next))}>{part}</button></span>
      })}
    </nav>}
    <div className="store-category-heading">
      <div><p className="eyebrow">{path ? 'Раздел каталога' : 'Выбери категорию'}</p>
        <h3>{title}</h3>
        <p>{path ? 'В разделе ' + count(path) + ' товаров. Открой подкатегорию или выбери модель.'
          : 'Открывай разделы последовательно. Все группы загружаются из каталога магазина.'}</p>
      </div>
      {path && <button type="button" className="store-category-back" onClick={() =>
        onSelect(parts.length === 1 ? ALL_CATALOG : categorySelection(parts.slice(0, -1).join(' / ')))}>← Назад</button>}
    </div>
    {!!folders.length && <div className="store-category-folders">
      {folders.map(folder => <button type="button" className="store-category-folder" key={folder.path}
        onClick={() => onSelect(categorySelection(folder.path))}>
        <span className="store-category-folder__icon" aria-hidden="true">▣</span>
        <strong>{folder.title}</strong>
        <small>{count(folder.path)} товаров</small>
        <span className="store-category-folder__arrow" aria-hidden="true">↗</span>
      </button>)}
    </div>}
    {path && !folders.length && <div className="store-category-leaf">Модели и цены — ниже.</div>}
  </section>
}
