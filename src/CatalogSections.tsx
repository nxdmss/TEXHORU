import { catalogBranches, type CatalogEntry } from './catalog-groups'

export function CatalogSections({ items, selection, onSelect }: { items: CatalogEntry[]; selection: string; onSelect: (value: string) => void; searching?: boolean }) {
  const branches = catalogBranches(items)
  const branch = branches.find(item => selection === item.id || selection.startsWith(item.id + '/'))
  return <div className="catalog-strip">
    <nav className="catalog-strip__sections" aria-label="Разделы каталога"><button aria-pressed={!selection} className={!selection ? 'active' : ''} onClick={() => onSelect('')}>Все товары</button>{branches.map(item => <button key={item.id} aria-pressed={branch?.id === item.id} className={branch?.id === item.id ? 'active' : ''} onClick={() => onSelect(item.id)}>{item.title}<span>{item.count}</span></button>)}</nav>
    {branch && branch.children.length > 1 && <nav className="catalog-strip__subsections" aria-label="Подразделы"><button aria-pressed={selection === branch.id} className={selection === branch.id ? 'active' : ''} onClick={() => onSelect(branch.id)}>Все в разделе</button>{branch.children.map(item => <button key={item.id} aria-pressed={selection === item.id} className={selection === item.id ? 'active' : ''} onClick={() => onSelect(item.id)}>{item.title}</button>)}</nav>}
  </div>
}
