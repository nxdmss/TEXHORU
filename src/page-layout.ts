export type StorefrontBlockType = 'promo' | 'products' | 'text'
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
      tablet: cloneBlocks(desktop),
      mobile: cloneBlocks(desktop),
    },
  }
}

const normalizeBlocks = (blocks: unknown, fallback: StorefrontBlock[]) => {
  if (!Array.isArray(blocks) || !blocks.length) return cloneBlocks(fallback)
  const allowed = new Set<StorefrontBlockType>(['promo', 'products', 'text'])
  const normalized = blocks.filter((block) => block && typeof block === 'object' && allowed.has((block as StorefrontBlock).type))
    .map((block) => ({ ...(block as StorefrontBlock), visible: (block as StorefrontBlock).visible !== false }))
  return normalized.length ? normalized : cloneBlocks(fallback)
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
