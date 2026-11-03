import { canonicalModel, identity, normalize, type Identity } from './product-matching'

export type SearchLink = string | { url: string; title?: string }

// Rank broadly before opening product pages. Only a clear product-family/model
// conflict is discarded here; variant differences are scored for manual review.

/**
 * Recall-first inspection ranking. Unlike rankSearchLinks, this pass does not
 * decide whether a listing is a match. It selects plausible product pages to
 * open when the strict title/slug filter returned nothing. Variant and brand
 * conflicts are checked again against the real product page before linking.
 */
export function rankSearchLinksForInspection(input: SearchLink[], query: string, limit = 18): string[] {
  const requested = identity({ name: query })
  if (requested.kind !== 'smartphone' || !requested.model) return []
  const requestedModel = canonicalModel(requested.model) || ''
  const modelTokens = requestedModel.split(' ').filter(Boolean)
  const stem = (value: string) => value.replace(/^(\d{1,2})[a-z]$/, '$1')
  const requestedStems = modelTokens.map(stem)
  const brandFamily = (value?: string) => value && /^(?:xiaomi|redmi|poco)$/.test(value) ? 'xiaomi' : value
  const stopWords = new Set([
    'iphone', 'apple', 'samsung', 'galaxy', 'xiaomi', 'redmi', 'poco',
    'smartfon', 'smartphone', 'смартфон', 'gb', 'гб', 'tb', 'тб',
  ])
  const unique = new Map<string, { url: string; title: string; index: number }>()
  for (const [index, entry] of input.entries()) {
    const url = typeof entry === 'string' ? entry : entry.url
    if (!url || unique.has(url)) continue
    unique.set(url, { url, title: typeof entry === 'string' ? '' : entry.title || '', index })
  }

  return [...unique.values()].map(candidate => {
    let rawSlug = ''
    try {
      rawSlug = decodeURIComponent(new URL(candidate.url).pathname.split('/p/').at(-1) || '')
        .replace(/-\d+\/?$/, '').replace(/_/g, ' ')
    } catch { return null }
    const title = candidate.title || ''
    const combined = normalize(title + ' ' + rawSlug)
    if (/(?:^|\s)(?:чехол|чехлы|стекло|пленка|бампер|кабель|адаптер|зарядное|case|cover|protector)(?=\s|$)/.test(combined)) return null

    const fromTitle = identity({ name: title })
    const fromSlug = identity({ name: rawSlug })
    const candidateModel = canonicalModel(fromSlug.model || fromTitle.model) || ''
    const candidateTokens = candidateModel.split(' ').filter(Boolean)
    const candidateStems = candidateTokens.map(stem)
    const words = new Set(combined.split(' '))
    const exactModel = candidateModel === requestedModel
    const stemOverlap = requestedStems.filter(token => candidateStems.includes(token)).length
    const wordOverlap = requestedStems.filter(token => words.has(token)).length
    const sameModelFamily = !exactModel && requestedStems.length >= 2
      && stemOverlap >= Math.min(2, requestedStems.length)
    const modelAnchored = exactModel || sameModelFamily
      || (candidateModel ? false : wordOverlap === requestedStems.length)
    if (!modelAnchored) return null

    const candidateBrand = brandFamily(fromTitle.brand || fromSlug.brand)
    const requestedBrand = brandFamily(requested.brand)
    const brandMatch = Boolean(requestedBrand && candidateBrand && requestedBrand === candidateBrand)
    const candidateStorage = fromSlug.storage || fromTitle.storage
    const candidateColor = fromSlug.color || fromTitle.color
    let score = exactModel ? 120 : sameModelFamily ? 72 : 55
    if (brandMatch) score += 24
    else if (requestedBrand && candidateBrand) score -= 8
    if (requested.storage && candidateStorage) score += requested.storage === candidateStorage ? 18 : -2
    if (requested.color && candidateColor) score += requested.color === candidateColor ? 10 : -1
    for (const token of new Set(normalize(query).split(' '))) {
      if (words.has(token) && !stopWords.has(token)) score += 3
    }
    // A real phone product slug is a useful positive signal even if the tile
    // title is incomplete or the page's brand field uses a sub-brand.
    if (/\b(?:smartfon|smartphone|iphone|galaxy|poco|redmi)\b/.test(normalize(rawSlug))) score += 8
    return { url: candidate.url, score, index: candidate.index }
  }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map(candidate => candidate.url)
}

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

    // Some 05.ru search tiles expose only "Apple + 13 + 128 GB" even though
    // the product page itself has the complete iPhone model. Keep such links
    // for a fresh page read and possible manual review; never use this weak
    // anchor for automatic confirmation. A positively parsed different model
    // (iPhone 14, iPhone 13 Pro, etc.) remains a hard rejection.
    const requestedModelParts = requested.model ? normalize(requested.model).split(' ') : []
    const modelNumberIndex = requestedModelParts.findIndex(part => /^\d{1,2}$/.test(part))
    const requestedModelNumber = modelNumberIndex >= 0 ? requestedModelParts[modelNumberIndex] : undefined
    const requestedModelSuffix = modelNumberIndex >= 0 ? requestedModelParts.slice(modelNumberIndex + 1) : []
    const candidateWords = new Set(combined.split(' '))
    const modelAnchor = Boolean(
      requested.kind === 'smartphone' && requested.model && !parsed.model
      // Search tiles sometimes expose only "Apple + model number + capacity"
      // and omit the word "smartphone". Keep that link for a real page read,
      // provided the brand and the complete model suffix are still anchored.
      && brandMatch && requestedModelNumber
      && candidateWords.has(requestedModelNumber)
      && requestedModelSuffix.every(part => candidateWords.has(part))
    )

    if (requested.kind && parsed.kind && requested.kind !== parsed.kind) return null
    if (requested.model && parsed.model && !sameModel) return null
    if (requested.kind === 'smartphone' && requested.model && !parsed.model && !modelAnchor) return null

    // Never send a phone search to accessory cards or another phone brand.
    if (requested.kind === 'smartphone' && /(?:^|\s)(?:чехол|стекло|пленка|бампер|кабель|адаптер|зарядное|защитное|case|cover|protector)(?=\s|$)/.test(combined)) return null
    if (requested.kind === 'smartphone' && requested.brand && parsed.brand && requested.brand !== parsed.brand) return null
    if (requested.kind === 'laptop' && requested.brand && parsed.brand && requested.brand !== parsed.brand) return null
    // Drop confidently wrong SSD variants BEFORE opening their product pages.
    // One terabyte/1000GB/1024GB normalize to the same capacity.
    if (requested.kind === 'laptop' && requestedStorage && parsed.storage
      && requestedStorage !== parsed.storage) return null
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
    const hasAnchor = sameModel || modelAnchor || sameCode || sameCodeFamily || sameCpu || sameGpu
      || (brandMatch && requested.model && !parsed.model && requested.kind !== 'smartphone')
      || (brandMatch && meaningfulOverlap >= 2) || meaningfulOverlap >= 3 || phoneFallbackAnchor
    if (!hasAnchor) return null

    let score = 0
    if (requested.model) score += sameModel ? 120 : modelAnchor ? 90 : parsed.model ? (requested.kind === 'smartphone' ? -70 : -100) : 12
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

    return { ...candidate, score, sameModel, modelAnchor, parsedModel: parsed.model, brandMatch, meaningfulOverlap }
  }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .filter(candidate => requested.kind !== 'smartphone' || !requested.model || candidate.sameModel || candidate.modelAnchor)
    .slice(0, Math.max(0, limit)).map(candidate => candidate.url)
}
