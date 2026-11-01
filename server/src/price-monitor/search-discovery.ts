import { canonicalModel, identity, normalize, type Identity } from './product-matching'

export type SearchLink = string | { url: string; title?: string }

// Rank broadly before opening product pages. Only a clear product-family/model
// conflict is discarded here; variant differences are scored for manual review.
export function rankSearchLinks(input: SearchLink[], query: string, limit = 18): string[] {
  const requested = identity({ name: query })
  const queryWords = new Set(normalize(query).split(' ').filter(word => word.length > 1))
  const requestedStorage = requested.storage || normalize(query).match(/\b(128|256|512|1024)\b/)?.[1]
  const unique = new Map<string, { url: string; title: string; index: number }>()

  for (const [index, entry] of input.entries()) {
    const url = typeof entry === 'string' ? entry : entry.url
    if (!url || unique.has(url)) continue
    unique.set(url, { url, title: typeof entry === 'string' ? '' : entry.title || '', index })
  }

  const stopWords = new Set([
    'iphone', 'apple', 'samsung', 'galaxy', 'xiaomi', 'smartphone', 'смартфон',
    'ноутбук', 'laptop', 'для', 'the', 'and', 'with', 'гб', 'gb', 'тб', 'tb',
  ])
  const codeFamily = (value?: string) => value?.split(/[-_]/)[0]

  return [...unique.values()].map(candidate => {
    let rawSlug = ''
    try {
      rawSlug = decodeURIComponent(new URL(candidate.url).pathname.split('/p/').at(-1) || '')
        .replace(/-\d+\/?$/, '').replace(/_/g, ' ')
    } catch { /* The caller validates every URL against 05.ru. */ }

    const slug = rawSlug.replace(/-/g, ' ')
    const title = candidate.title || slug
    const combined = normalize(title + ' ' + slug)

    // Do not concatenate title and slug before parsing: the same 128/256 GB
    // value is commonly present twice and can be mistaken for RAM + storage.
    const fromTitle = identity({ name: candidate.title || '' })
    const fromSlug = identity({ name: rawSlug })
    // The product URL slug is the strongest source for the phone model and
    // variant. The extracted "title" can be the whole surrounding card (or a
    // nested sibling), so its model/storage/colour must not override the slug.
    // Keep product type and manufacturer from the title: accessory slugs often
    // contain a compatible iPhone model but do not name the accessory maker.
    const parsed = { ...fromTitle } as Identity
    const slugVariantFields: Array<keyof Identity> = [
      'model', 'storage', 'ram', 'color', 'sim', 'productCode', 'mpn', 'gtin',
    ]
    for (const key of slugVariantFields) {
      const value = fromSlug[key]
      if (value !== undefined && value !== '') (parsed as Record<string, unknown>)[key] = value
    }
    if (!parsed.kind && fromSlug.kind) parsed.kind = fromSlug.kind
    if (!parsed.brand && fromSlug.brand) parsed.brand = fromSlug.brand
    if (!parsed.compatibleBrand && fromSlug.compatibleBrand) parsed.compatibleBrand = fromSlug.compatibleBrand
    // A product slug that explicitly says "smartfon" is authoritative for
    // the item type; accessory slugs may mention iPhone only as compatibility.
    if (/\b(?:smartfon|smartphone)\b/.test(normalize(rawSlug))) parsed.kind = 'smartphone'

    const sameModel = Boolean(requested.model && parsed.model
      && canonicalModel(requested.model) === canonicalModel(parsed.model))
    const sameCode = Boolean(requested.productCode && parsed.productCode
      && requested.productCode === parsed.productCode)
    const sameCodeFamily = Boolean(requested.kind === 'laptop' && requested.productCode && parsed.productCode
      && codeFamily(requested.productCode) === codeFamily(parsed.productCode))
    const sameCpu = Boolean(requested.cpu && parsed.cpu && requested.cpu === parsed.cpu)
    const sameGpu = Boolean(requested.gpu && parsed.gpu && requested.gpu === parsed.gpu)
    const brandMatch = Boolean(requested.brand && parsed.brand && requested.brand === parsed.brand)
    const compatibleMatch = Boolean(requested.compatibleBrand && parsed.compatibleBrand
      && requested.compatibleBrand === parsed.compatibleBrand)

    if (requested.kind && parsed.kind && requested.kind !== parsed.kind) return null
    if (requested.model && parsed.model && !sameModel) return null
    // A smartphone query with a known model must never fall back to another
    // Apple/Samsung/etc. model, or to a card whose model is not identifiable.
    // That fallback was opening iPhone Air / iPhone 17 Pro for iPhone 13 queries.
    if (requested.kind === 'smartphone' && requested.model && !parsed.model) return null

    // Never send a phone search to accessory cards or another phone brand.
    if (requested.kind === 'smartphone' && /(?:^|\s)(?:чехол|стекло|пленка|бампер|кабель|адаптер|зарядное|защитное|case|cover|protector)(?=\s|$)/.test(combined)) return null
    if (requested.kind === 'smartphone' && requested.brand && parsed.brand && requested.brand !== parsed.brand) return null
    if (requested.kind === 'laptop' && requested.brand && parsed.brand && requested.brand !== parsed.brand) return null
    if (requested.compatibleBrand && parsed.compatibleBrand && !compatibleMatch) return null

    // A different laptop SKU in the same family is worth opening for review.
    // A completely different product code family is still discarded.
    if (requested.kind === 'laptop' && requested.productCode && parsed.productCode
      && requested.productCode !== parsed.productCode && !sameCodeFamily && !sameModel) return null

    const words = new Set(combined.split(' '))
    const meaningfulOverlap = [...queryWords].filter(word => words.has(word) && !stopWords.has(word)).length
    const sameKind = Boolean(requested.kind && parsed.kind && requested.kind === parsed.kind)
    const phoneFallbackAnchor = requested.kind === 'smartphone'
      && (brandMatch || meaningfulOverlap >= 1)
    const hasAnchor = sameModel || sameCode || sameCodeFamily || sameCpu || sameGpu
      || (brandMatch && requested.model && !parsed.model && requested.kind !== 'smartphone')
      || (brandMatch && meaningfulOverlap >= 2) || meaningfulOverlap >= 3 || phoneFallbackAnchor
    if (!hasAnchor) return null

    let score = 0
    if (requested.model) score += sameModel ? 120 : parsed.model ? (requested.kind === 'smartphone' ? -70 : -100) : 12
    if (requested.productCode) score += sameCode ? 160 : sameCodeFamily ? 55 : parsed.productCode ? -35 : 12
    if (requested.brand && parsed.brand) score += brandMatch ? 45 : -60
    if (requested.compatibleBrand && parsed.compatibleBrand) score += compatibleMatch ? 45 : -60
    if (requested.kind && parsed.kind) score += sameKind ? 30 : -30
    if (requested.cpu && parsed.cpu) score += requested.cpu === parsed.cpu ? 45 : -20
    if (requested.gpu && parsed.gpu) score += requested.gpu === parsed.gpu ? 25 : -12
    if (requested.ram && parsed.ram) score += requested.ram === parsed.ram ? 18 : -10
    if (requestedStorage && parsed.storage) score += requestedStorage === parsed.storage ? 28 : -14
    if (requested.screenSize && parsed.screenSize) score += requested.screenSize === parsed.screenSize ? 14 : -8
    if (requested.color && parsed.color) score += requested.color === parsed.color ? 10 : -5
    if (requested.sim && parsed.sim) score += requested.sim === parsed.sim ? 10 : -5
    for (const word of queryWords) if (words.has(word) && !stopWords.has(word)) score += 4

    return { ...candidate, score, sameModel, parsedModel: parsed.model, brandMatch, meaningfulOverlap }
  }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .filter(candidate => requested.kind !== 'smartphone' || !requested.model || candidate.sameModel)
    .slice(0, Math.max(0, limit)).map(candidate => candidate.url)
}
