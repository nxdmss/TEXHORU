import { identity, normalize } from './product-matching'

export type SearchLink = string | { url: string; title?: string }

// Rank the complete discovery set before spending requests on product pages.
// Model, product family, brand and explicit variant attributes outrank raw word overlap.
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
    } catch { /* The caller validates every URL against 05.ru. */ }

    const title = candidate.title || slug
    const combined = normalize(title + ' ' + slug)
    const parsed = identity({ name: combined })
    const slugVariant = identity({ name: slug })

    // A requested capacity must agree with both the visible title and URL slug.
    if (requestedStorage && (
      (parsed.storage && parsed.storage !== requestedStorage)
      || (slugVariant.storage && slugVariant.storage !== requestedStorage)
    )) return null

    // Do not read another product family or a different explicit model.
    if (requested.model && parsed.model && requested.model !== parsed.model) return null
    if (requested.kind && parsed.kind && requested.kind !== parsed.kind) return null

    // A phone search should not waste page reads on accessories whose category
    // text is too generic for productKind() to classify.
    if (requested.model && /(?:^|\s)(?:чехол|стекло|пленка|бампер|кабель|адаптер|зарядное|защитное|case|cover|protector)(?=\s|$)/.test(combined)
      && !/(?:^|\s)(?:чехол|стекло|пленка|case|cover)(?=\s|$)/.test(normalize(query))) return null

    // If both sides expose a brand, a different brand is a hard rejection.
    // Missing brand on a search tile is not proof of a mismatch; the product
    // page will be opened and checked before a candidate can be suggested.
    if (requested.brand && parsed.brand && requested.brand !== parsed.brand) return null
    if (requested.color && parsed.color && requested.color !== parsed.color) return null

    const words = new Set(combined.split(' '))
    let score = 0
    if (requested.model && parsed.model) score += requested.model === parsed.model ? 100 : -100
    else if (requested.model) score += 8
    if (requested.brand && parsed.brand) score += requested.brand === parsed.brand ? 60 : -60
    if (requested.kind && parsed.kind) score += requested.kind === parsed.kind ? 30 : -30
    if (requestedStorage && parsed.storage) score += requestedStorage === parsed.storage ? 35 : -35
    if (requested.color && parsed.color) score += requested.color === parsed.color ? 20 : -20
    for (const word of queryWords) if (words.has(word)) score += 5

    return { ...candidate, score }
  }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit)).map(candidate => candidate.url)
}
