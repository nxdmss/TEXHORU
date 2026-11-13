export type StorefrontBlockType = 'collections' | 'promo' | 'products' | 'smartphones' | 'text'
export type StorefrontBlockWidth = 4 | 6 | 8 | 12

export type StorefrontBlock = {
  id: string
  type: StorefrontBlockType
  width: StorefrontBlockWidth
  visible: boolean
  title?: string
  eyebrow?: string
  body?: string
  ctaLabel?: string
  category?: string
}

export type StorefrontLayout = { version: 1; blocks: StorefrontBlock[] }

export const defaultStorefrontLayout = (): StorefrontLayout => ({
  version: 1,
  blocks: [
    { id: 'home-collections', type: 'collections', width: 12, visible: true, title: 'Категории' },
    { id: 'home-promos', type: 'promo', width: 12, visible: true, title: 'Акции' },
    { id: 'home-products', type: 'products', width: 12, visible: true, title: 'Популярные товары' },
  ],
})

export const normalizeStorefrontLayout = (value?: Partial<StorefrontLayout> | null): StorefrontLayout => {
  if (!Array.isArray(value?.blocks) || !value.blocks.length) return defaultStorefrontLayout()
  return { version: 1, blocks: value.blocks.map((block) => ({ ...block, visible: block.visible !== false })) }
}
