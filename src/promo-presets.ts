import type { StorefrontDevice } from './page-layout'

export type PromoStandard = {
  label: string
  width: number
  height: number
  ratio: number
  shortLabel: string
}

export type PromoPreset = {
  id: string
  title: string
  caption: string
  category: string
  tone: 'light' | 'dark' | 'red'
  images: Record<StorefrontDevice, string>
}

export const PROMO_STANDARDS: Record<StorefrontDevice, PromoStandard> = {
  desktop: { label: 'Компьютер · 1920×600 · 16:5', shortLabel: '1920×600', width: 1920, height: 600, ratio: 16 / 5 },
  tablet: { label: 'Планшет · 1600×900 · 16:9', shortLabel: '1600×900', width: 1600, height: 900, ratio: 16 / 9 },
  mobile: { label: 'Телефон · 1080×608 · 16:9', shortLabel: '1080×608', width: 1080, height: 608, ratio: 16 / 9 },
}

export const PROMO_PRESETS: PromoPreset[] = [
  {
    id: 'scarlet-mobile', title: 'Новый ритм', caption: 'Смартфоны', category: 'ТЕЛЕФОНЫ И ГАДЖЕТЫ', tone: 'red',
    images: { desktop: '/promos/presets/scarlet-mobile-desktop.svg', tablet: '/promos/presets/scarlet-mobile-tablet.svg', mobile: '/promos/presets/scarlet-mobile-mobile.svg' },
  },
  {
    id: 'electric-play', title: 'Игра без пауз', caption: 'Консоли и игры', category: 'ИГРОВЫЕ ПРИСТАВКИ', tone: 'dark',
    images: { desktop: '/promos/presets/electric-play-desktop.svg', tablet: '/promos/presets/electric-play-tablet.svg', mobile: '/promos/presets/electric-play-mobile.svg' },
  },
  {
    id: 'blue-work', title: 'Быстрее идеи', caption: 'Компьютерная техника', category: 'КОМПЬЮТЕРНАЯ ТЕХНИКА', tone: 'light',
    images: { desktop: '/promos/presets/blue-work-desktop.svg', tablet: '/promos/presets/blue-work-tablet.svg', mobile: '/promos/presets/blue-work-mobile.svg' },
  },
  {
    id: 'sonic-color', title: 'Громче цвета', caption: 'Аудио и видео', category: 'АУДИО-ВИДЕО ТЕХНИКА', tone: 'dark',
    images: { desktop: '/promos/presets/sonic-color-desktop.svg', tablet: '/promos/presets/sonic-color-tablet.svg', mobile: '/promos/presets/sonic-color-mobile.svg' },
  },
]

export const promoPresetsFor = (device: StorefrontDevice) => PROMO_PRESETS.map((preset) => ({
  ...preset,
  image: preset.images[device],
}))
