import type { ProductSpec } from './types'

type PhoneProfile = {
  match: RegExp
  display: string
  processor: string
  camera: string
  battery: string
  connectivity: string
  protection: string
}

export type PhoneCatalogProfile = {
  shortSpec: string
  description: string
  specs: ProductSpec[]
}

const profiles: PhoneProfile[] = [
  { match: /\biphone\s*11\s*pro\s*max\b/i, display: '6.5″ OLED, 2688×1242', processor: 'Apple A13 Bionic', camera: '12+12+12 Мп, фронтальная 12 Мп', battery: 'Быстрая и беспроводная зарядка', connectivity: '4G, Wi‑Fi 6, Bluetooth 5.0, NFC', protection: 'IP68, стекло и нержавеющая сталь' },
  { match: /\biphone\s*11\b/i, display: '6.1″ IPS, 1792×828', processor: 'Apple A13 Bionic', camera: '12+12 Мп, фронтальная 12 Мп', battery: 'Быстрая и беспроводная зарядка', connectivity: '4G, Wi‑Fi 6, Bluetooth 5.0, NFC', protection: 'IP68, стекло и алюминий' },
  { match: /\biphone\s*15\b/i, display: '6.1″ OLED, 2556×1179', processor: 'Apple A16 Bionic', camera: '48+12 Мп, фронтальная 12 Мп', battery: 'USB‑C, MagSafe и беспроводная зарядка', connectivity: '5G, Wi‑Fi 6, Bluetooth 5.3, NFC', protection: 'IP68, Ceramic Shield' },
  { match: /\biphone\s*16\b/i, display: '6.1″ OLED, 2556×1179', processor: 'Apple A18', camera: '48+12 Мп, фронтальная 12 Мп', battery: 'USB‑C, MagSafe до 25 Вт', connectivity: '5G, Wi‑Fi 7, Bluetooth 5.3, NFC', protection: 'IP68, Ceramic Shield' },
  { match: /\bhonor\s*600\s*pro\b/i, display: '6.57″ AMOLED, 2728×1264, 120 Гц', processor: 'Snapdragon 8 Elite, до 4.32 ГГц', camera: '200+50+12 Мп, OIS', battery: '7000 мА·ч, 80 Вт, беспроводная зарядка 50 Вт', connectivity: '5G, eSIM, Wi‑Fi, Bluetooth, NFC', protection: 'IP68 / IP69 / IP69K' },
  { match: /\bhonor\s*600\b/i, display: '6.57″ AMOLED, 2728×1264, 120 Гц', processor: 'Snapdragon 7 Gen 4, до 2.8 ГГц', camera: '200+12 Мп, OIS', battery: '7000 мА·ч, быстрая зарядка 80 Вт', connectivity: '5G, eSIM, Wi‑Fi, Bluetooth, NFC', protection: 'IP68 / IP69 / IP69K' },
  { match: /\bhonor\s*x9d\b/i, display: '6.79″ OLED, 2640×1200, 120 Гц', processor: 'Snapdragon 6 Gen 4, до 2.3 ГГц', camera: '108+5 Мп, OIS', battery: '8300 мА·ч, быстрая зарядка 66 Вт', connectivity: '5G, Dual SIM, Wi‑Fi 6, Bluetooth, NFC', protection: 'IP68 / IP69K, усиленный корпус' },
  { match: /\bhonor\s*x7e\b/i, display: '6.61″ TFT LCD, 1604×720', processor: 'MediaTek Helio G81 Ultra, до 2.0 ГГц', camera: '50 Мп, фронтальная камера', battery: '7000 мА·ч, быстрая зарядка 45 Вт', connectivity: '4G, Dual SIM, Wi‑Fi, Bluetooth', protection: 'IP64' },
  { match: /\bhonor\s*x5es\b/i, display: '6.9″ IPS, 1600×720, 90 Гц', processor: 'MediaTek Helio G81, до 2.0 ГГц', camera: '13 Мп, фронтальная камера', battery: '6000 мА·ч', connectivity: '4G, Dual SIM, Wi‑Fi, Bluetooth, FM', protection: 'Защита от повседневных воздействий' },
  { match: /\bhuawei\s*nova\s*15\s*max\b/i, display: '6.84″ OLED, 2756×1272', processor: 'HiSilicon, 6 ядер до 2.4 ГГц', camera: '50+2 Мп, фронтальная камера', battery: '8500 мА·ч, быстрая зарядка', connectivity: '4G, Dual SIM, Wi‑Fi, Bluetooth, NFC', protection: 'Защита корпуса от влаги и пыли' },
  { match: /\bgalaxy\s*s25\s*ultra\b/i, display: '6.9″ Dynamic AMOLED 2X, 3120×1440, 120 Гц', processor: 'Snapdragon 8 Elite for Galaxy, до 4.47 ГГц', camera: '200+50+50+10 Мп, OIS', battery: '5000 мА·ч, зарядка 45 Вт', connectivity: '5G, eSIM, Wi‑Fi 7, Bluetooth 5.4, NFC', protection: 'IP68, титановая рамка, Gorilla Armor 2' },
  { match: /\bgalaxy\s*s25\b/i, display: '6.2″ Dynamic AMOLED 2X, 2340×1080, 120 Гц', processor: 'Snapdragon 8 Elite for Galaxy, до 4.47 ГГц', camera: '50+12+10 Мп, OIS, оптический зум 3×', battery: '4000 мА·ч, проводная и беспроводная зарядка', connectivity: '5G, eSIM, Wi‑Fi 7, Bluetooth 5.4, NFC', protection: 'IP68, Gorilla Glass Victus 2' },
  { match: /\bgalaxy\s*a17\b/i, display: '6.7″ Super AMOLED, 2340×1080, 90 Гц', processor: 'Samsung Exynos 1330, до 2.4 ГГц', camera: '50+5+2 Мп, фронтальная 13 Мп', battery: '5000 мА·ч, зарядка 25 Вт', connectivity: '4G, Dual SIM, Wi‑Fi, Bluetooth, NFC', protection: 'IP54' },
  { match: /\bgalaxy\s*s26\s*ultra\b/i, display: '6.9″ Dynamic AMOLED 2X, 3120×1440, 120 Гц', processor: 'Snapdragon 8 Elite Gen 5 for Galaxy, до 4.74 ГГц', camera: '200+50+50+10 Мп, OIS', battery: '5000 мА·ч, быстрая и беспроводная зарядка', connectivity: '5G, eSIM, Wi‑Fi 7, Bluetooth, NFC', protection: 'IP68, титановая рамка' },
  { match: /\bgalaxy\s*s26\b/i, display: '6.3″ Dynamic AMOLED 2X, 2340×1080, 120 Гц', processor: 'Samsung Exynos 2600, до 3.8 ГГц', camera: '50+12+10 Мп, OIS, оптический зум 3×', battery: '4300 мА·ч, проводная и беспроводная зарядка', connectivity: '5G, eSIM, Wi‑Fi, Bluetooth, NFC', protection: 'IP68' },
  { match: /\bpoco\s*f8\s*ultra\b/i, display: '6.9″ AMOLED, 2608×1200, 120 Гц', processor: 'Snapdragon 8 Elite Gen 5, до 4.61 ГГц', camera: '50+50+50 Мп, OIS, перископический зум', battery: '6500 мА·ч, 100 Вт, беспроводная зарядка 50 Вт', connectivity: '5G, eSIM, Wi‑Fi 7, Bluetooth 6.0, NFC', protection: 'IP68, POCO Shield Glass' },
  { match: /\bpoco\s*f8\s*pro\b/i, display: '6.59″ AMOLED, 2510×1156, 120 Гц', processor: 'Snapdragon 8 Elite, до 4.32 ГГц', camera: '50+50+8 Мп, OIS', battery: '6210 мА·ч, быстрая зарядка 100 Вт', connectivity: '5G, Dual SIM, Wi‑Fi, Bluetooth, NFC', protection: 'IP68' },
  { match: /\bpoco\s*m8\b/i, display: '6.77″ AMOLED, 2392×1080, 120 Гц', processor: 'Snapdragon 6 Gen 3, до 2.4 ГГц', camera: '50+2 Мп, фронтальная 20 Мп', battery: '5520 мА·ч, быстрая зарядка 45 Вт', connectivity: '5G, Dual SIM, Wi‑Fi, Bluetooth, NFC', protection: 'IP65' },
  { match: /\bpoco\s*x8\s*pro\s*max\b/i, display: '6.83″ AMOLED, 2772×1280, 120 Гц', processor: 'MediaTek Dimensity 9500s, до 3.73 ГГц', camera: '50+8 Мп, OIS', battery: '8500 мА·ч, быстрая зарядка 100 Вт', connectivity: '5G, Dual SIM, Wi‑Fi, Bluetooth, NFC', protection: 'IP68' },
  { match: /\bpoco\s*x8\s*pro\b/i, display: '6.59″ AMOLED, 2756×1268, 120 Гц', processor: 'MediaTek Dimensity 8500 Ultra, до 3.4 ГГц', camera: '50+8 Мп, OIS', battery: '6500 мА·ч, быстрая зарядка 100 Вт', connectivity: '5G, Dual SIM, Wi‑Fi 6, Bluetooth, NFC', protection: 'IP68' },
  { match: /\bxiaomi\s*15t\s*pro\b/i, display: '6.83″ AMOLED, 2772×1280, 144 Гц', processor: 'MediaTek Dimensity 9400+, до 3.73 ГГц', camera: '50+50+12 Мп, Leica, OIS', battery: '5500 мА·ч, 90 Вт, беспроводная зарядка 50 Вт', connectivity: '5G, eSIM, Wi‑Fi 7, Bluetooth, NFC', protection: 'IP68, Gorilla Glass 7i' },
  { match: /\bxiaomi\s*17t\s*pro\b/i, display: '6.83″ pOLED, 2772×1280, 144 Гц', processor: 'MediaTek Dimensity 9500, до 4.21 ГГц', camera: '50+50+12 Мп, OIS', battery: '7000 мА·ч, 100 Вт, беспроводная зарядка 50 Вт', connectivity: '5G, eSIM, Wi‑Fi 7, Bluetooth 6.0, NFC', protection: 'IP68' },
  { match: /\bxiaomi\s*17t\b/i, display: '6.59″ pOLED, 2756×1268, 120 Гц', processor: 'MediaTek Dimensity 8500 Ultra, до 3.4 ГГц', camera: '50+50+12 Мп, OIS', battery: '6500 мА·ч, быстрая зарядка 67 Вт', connectivity: '5G, Dual SIM, Wi‑Fi, Bluetooth, NFC', protection: 'IP68' },
  { match: /\brealme\s*16\s*pro\b/i, display: '6.78″ AMOLED, 2772×1272, 120 Гц', processor: 'MediaTek Dimensity 7300 Max, до 2.5 ГГц', camera: '200+8 Мп, OIS', battery: '7000 мА·ч, быстрая зарядка 80 Вт', connectivity: '5G, Dual SIM, Wi‑Fi, Bluetooth, NFC', protection: 'Защита корпуса от влаги и пыли' },
  { match: /\brealme\s*c100x\b/i, display: '6.8″ IPS, 1570×720', processor: 'Unisoc T7250, до 1.8 ГГц', camera: '50 Мп, фронтальная камера', battery: '8000 мА·ч', connectivity: '4G, Dual SIM, Wi‑Fi, Bluetooth', protection: 'IP64' },
  { match: /\btecno\s*camon\s*50\s*ultra\b/i, display: '6.78″ AMOLED, 2644×1208, 144 Гц', processor: 'MediaTek Dimensity 7400 Ultimate, до 2.6 ГГц', camera: '50+50+8 Мп, OIS, оптический зум', battery: '6500 мА·ч, быстрая зарядка', connectivity: '5G, eSIM, Wi‑Fi, Bluetooth, NFC, FM', protection: 'IP68 / IP69K' },
  { match: /\b(?:google\s*)?pixel\s*11\s*pro\b/i, display: '6.3″ LTPO OLED, 2856×1280, 120 Гц', processor: 'Google Tensor G6, до 4.11 ГГц', camera: '50+48+48 Мп, OIS, оптический зум', battery: '4850 мА·ч, проводная и беспроводная зарядка', connectivity: '5G, eSIM, Wi‑Fi 7, Bluetooth 6.0, NFC', protection: 'IP68' },
]

function memoryFromName(name: string) {
  const pair = name.match(/(?:^|\D)(\d{1,2})\s*(?:гб|gb)?\s*[+/]\s*(\d{2,4})\s*(?:гб|gb)?(?!\d)/i)
  if (pair) return `${pair[1]} ГБ ОЗУ / ${pair[2]} ГБ`
  const storageFirst = name.match(/(?:^|\D)(\d{3,4})\s*(?:гб|gb)\s+(\d{1,2})\s*(?:гб|gb)(?!\d)/i)
  if (storageFirst) return `${storageFirst[2]} ГБ ОЗУ / ${storageFirst[1]} ГБ`
  const storage = [...name.matchAll(/(?:^|\D)(\d{2,4})\s*(?:гб|gb)(?!\d)/gi)].at(-1)?.[1]
  return storage ? `${storage} ГБ` : ''
}

export function phoneCatalogProfile(name: string): PhoneCatalogProfile | null {
  const profile = profiles.find(item => item.match.test(name))
  if (!profile) return null
  const memory = memoryFromName(name)
  const specs: ProductSpec[] = [
    { label: 'Экран', value: profile.display },
    { label: 'Процессор', value: profile.processor },
    ...(memory ? [{ label: 'Память', value: memory }] : []),
    { label: 'Основная камера', value: profile.camera },
    { label: 'Аккумулятор', value: profile.battery },
    { label: 'Связь', value: profile.connectivity },
    { label: 'Защита', value: profile.protection },
  ]
  return {
    shortSpec: [memory, profile.display.split(',').slice(0, 2).join(','), profile.battery.split(',')[0]].filter(Boolean).join(' · '),
    description: `Смартфон с экраном ${profile.display}, процессором ${profile.processor} и камерой ${profile.camera}.`,
    specs,
  }
}
