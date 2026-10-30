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
    const combined = normalize(title + ' ' + slug)
    const parsed = identity({ name: combined })
    const slugVariant = identity({ name: slug })
    // Search for 256 GB must not open a 1 TB or 512 GB variant just
    // because it appears earlier in the storefront results.
    if (requestedStorage && ((parsed.storage && parsed.storage !== requestedStorage)
      || (slugVariant.storage && slugVariant.storage !== requestedStorage))) return null
    // Do not spend the limited card-read budget on unrelated models or phone accessories.
    // Missing model text in a search tile is not proof of a mismatch.
    // Keep that candidate for the product-page H1/specification check.
    if (requested.model && parsed.model && parsed.model !== requested.model) return null
    // Keep product families separate: a phone is not a match for its case.
    if (requested.kind && parsed.kind && requested.kind !== parsed.kind) return null
    if (requested.model && /(?:^|\s)(?:чехол|стекло|пленка|бампер|кабель|адаптер|зарядное|защитное|case|cover|protector)(?=\s|$)/.test(combined)
      && !/(?:^|\s)(?:чехол|стекло|пленка|case|cover)(?=\s|$)/.test(normalize(query))) return null
    const words = new Set(combined.split(' '))
    let score = 0
    if (requested.model && parsed.model) score += requested.model === parsed.model ? 100 : -100
    else if (requested.model) score += 8
    if (requestedStorage && parsed.storage) score += requestedStorage === parsed.storage ? 35 : -35
    if (requested.color && parsed.color) score += requested.color === parsed.color ? 20 : -20
    for (const word of queryWords) if (words.has(word)) score += 5
    return { ...candidate, score }
  }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit)).map(candidate => candidate.url)
}
