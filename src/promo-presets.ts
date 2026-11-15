import type { StorefrontDevice } from './page-layout'

export type PromoStandard = {
  label: string
  width: number
  height: number
  ratio: number
  shortLabel: string
}

export const PROMO_STANDARDS: Record<StorefrontDevice, PromoStandard> = {
  desktop: { label: 'Компьютер · 1920×600 · 16:5', shortLabel: '1920×600', width: 1920, height: 600, ratio: 16 / 5 },
  tablet: { label: 'Планшет · 1600×900 · 16:9', shortLabel: '1600×900', width: 1600, height: 900, ratio: 16 / 9 },
  mobile: { label: 'Телефон · 1080×608 · 16:9', shortLabel: '1080×608', width: 1080, height: 608, ratio: 16 / 9 },
}
