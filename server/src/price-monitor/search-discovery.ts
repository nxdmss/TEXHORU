import { identity, normalize } from './product-matching'

export type SearchLink = string | { url: string; title?: string }

// Search result order is not guaranteed to be relevant: the storefront can
// include recommendations, banners and accessory links before matching phones.
// Rank *all* visible product links before imposing the network budget.
export function rankSearchLinks(input: SearchLink[], query: string, limit = 12): string[] {
  const requested = identity({ name: query })
  const queryWords = new Set(normalize(query).split(' ').filter(word => word.length > 1))
  const requestedStorage = requested.storage || normalize(query).match(/\b(128|256|512|1024)\b/)?.[1]
  const unique = new Map<string, { url: string; title: string; index: number }>()
  for (const [index, entry] of input.entries()) {
    const url = typeof entry === 'string' ? entry : entry.url
    if (!url || unique.has(url)) continue
    unique.set(url, { url, title: typeof entry === 'string' ? '' : entry.title || '', index })
  }
  return [...unique.values()].map(candidate => {
    let slug = ''
    try {
      slug = decodeURIComponent(new URL(candidate.url).pathname.split('/p/').at(-1) || '')
        .replace(/-\d+\/?$/, '').replace(/[-_]/g, ' ')
    } catch { /* Reject malformed URLs at the caller's 05.ru URL validator. */ }
    const title = candidate.title || slug
    const parsed = identity({ name: title + ' ' + slug })
    const words = new Set(normalize(title + ' ' + slug).split(' '))
    let score = 0
    if (requested.model && parsed.model) score += requested.model === parsed.model ? 100 : -100
    if (requestedStorage && parsed.storage) score += requestedStorage === parsed.storage ? 35 : -35
    if (requested.color && parsed.color) score += requested.color === parsed.color ? 20 : -20
    for (const word of queryWords) if (words.has(word)) score += 5
    return { ...candidate, score }
  }).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit)).map(candidate => candidate.url)
}
