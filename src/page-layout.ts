export type StorefrontBlockType = 'collections' | 'promo' | 'products' | 'smartphones' | 'text'
export type StorefrontBlockWidth = 4 | 6 | 8 | 12
export type StorefrontDevice = 'desktop' | 'tablet' | 'mobile'

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

export type StorefrontLayouts = Record<StorefrontDevice, StorefrontBlock[]>
export type StorefrontLayout = { version: 2; devices: StorefrontLayouts }

const baseBlocks = (): StorefrontBlock[] => [
  { id: 'home-collections', type: 'collections', width: 12, visible: true, title: 'Категории' },
  { id: 'home-promos', type: 'promo', width: 12, visible: true, title: 'Акции' },
  { id: 'home-products', type: 'products', width: 12, visible: true, title: 'Популярные товары' },
]

const cloneBlocks = (blocks: StorefrontBlock[]) => blocks.map((block) => ({ ...block }))

export const defaultStorefrontLayout = (): StorefrontLayout => {
  const desktop = baseBlocks()
  return {
    version: 2,
    devices: {
      desktop,
      tablet: [desktop[1], desktop[0], desktop[2]].map((block) => ({ ...block })),
      mobile: [desktop[1], desktop[0], desktop[2]].map((block) => ({ ...block })),
    },
  }
}

const normalizeBlocks = (blocks: unknown, fallback: StorefrontBlock[]) => {
  if (!Array.isArray(blocks) || !blocks.length) return cloneBlocks(fallback)
  return blocks.map((block) => ({ ...(block as StorefrontBlock), visible: (block as StorefrontBlock).visible !== false }))
}

export const normalizeStorefrontLayout = (value?: Partial<StorefrontLayout> | { version?: number; blocks?: StorefrontBlock[] } | null): StorefrontLayout => {
  const defaults = defaultStorefrontLayout()
  const legacy = value && 'blocks' in value && Array.isArray(value.blocks) ? normalizeBlocks(value.blocks, defaults.devices.desktop) : null
  const source = value && 'devices' in value ? value.devices : undefined
  return {
    version: 2,
    devices: {
      desktop: normalizeBlocks(source?.desktop, legacy || defaults.devices.desktop),
      tablet: normalizeBlocks(source?.tablet, legacy || defaults.devices.tablet),
      mobile: normalizeBlocks(source?.mobile, legacy || defaults.devices.mobile),
    },
  }
}

export const storefrontBlocksFor = (layout: StorefrontLayout, device: StorefrontDevice) => layout.devices[device]
