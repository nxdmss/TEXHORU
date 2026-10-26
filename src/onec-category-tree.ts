// The full 1C category path is stored as one category label (e.g. "Телефоны / Смартфоны / Apple").
// This avoids schema migrations during the test while retaining arbitrary nesting in the storefront.
export type OneCNode = { title: string; path: string; count: number; children: OneCNode[] }
export const ONEC_PATH_PREFIX = 'onec-path:'
export const ALL_CATALOG = 'catalog-all'

export function categorySegments(name: string): string[] {
  return (name || 'Без категории').split(' / ').map(segment => segment.trim()).filter(Boolean)
}
export function categorySelection(path: string): string {
  return ONEC_PATH_PREFIX + path
}
export function selectedCategoryPath(selection: string): string | null {
  return selection.startsWith(ONEC_PATH_PREFIX) ? selection.slice(ONEC_PATH_PREFIX.length) : null
}
export function matchesCategoryPath(category: string, selectedPath: string): boolean {
  return category === selectedPath || category.startsWith(selectedPath + ' / ')
}
const topPriority = /смартфон|телефон|iphone|xiaomi|samsung|apple|ноутбук|планшет|компьютер/i
export function categoryTree(categoryNames: string[]): OneCNode[] {
  const roots: OneCNode[] = []
  const seen = new Map<string, OneCNode>()
  for (const raw of categoryNames) {
    let parent: OneCNode | undefined
    let prefix = ''
    for (const title of categorySegments(raw)) {
      prefix = prefix ? prefix + ' / ' + title : title
      let node = seen.get(prefix)
      if (!node) {
        node = { title, path: prefix, count: 0, children: [] }
        if (parent) parent.children.push(node)
        else roots.push(node)
        seen.set(prefix, node)
      }
      node.count += 1
      parent = node
    }
  }
  const order = (nodes: OneCNode[]) => {
    nodes.sort((a, b) => Number(topPriority.test(b.title)) - Number(topPriority.test(a.title)) || a.title.localeCompare(b.title, 'ru'))
    nodes.forEach(node => order(node.children))
  }
  order(roots)
  return roots
}
export function childrenAtPath(roots: OneCNode[], path: string): OneCNode[] {
  if (!path) return roots
  let nodes = roots
  for (const segment of categorySegments(path)) {
    const found = nodes.find(node => node.title === segment)
    if (!found) return []
    nodes = found.children
  }
  return nodes
}
export function isFeaturedCatalogProduct(item: { name: string; brand?: string; category?: string }): boolean {
  const name = item.name.toLowerCase()
  if (/чехол|стекл|кабел|зарядк|адаптер|переходник|держател/.test(name)) return false
  return /\biphone\b|айфон|смартфон|телефон|\bxiaomi\b|\bredmi\b|\bpoco\b|\bsamsung\b|\bgalaxy\b/i.test(name + ' ' + (item.brand || ''))
}
