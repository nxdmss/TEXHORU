import { identity } from '../price-monitor/product-matching'

export type SourcedSpec = { label: string; value: string }

type SpecRule = { label: string; patterns: RegExp[] }

const templates: Record<string, SpecRule[]> = {
  smartphone: [
    { label: 'Экран', patterns: [/тип экрана|технология экрана|матриц/i] },
    { label: 'Диагональ', patterns: [/^диагональ(?: экрана)?$|размер экрана/i] },
    { label: 'Разрешение экрана', patterns: [/разрешение экрана|разрешение дисплея/i] },
    { label: 'Процессор', patterns: [/процессор|чипсет|cpu/i] },
    { label: 'Оперативная память', patterns: [/оперативн.*памят|^ram$/i] },
    { label: 'Встроенная память', patterns: [/встроенн.*памят|постоянн.*памят|^rom$|объем накоп/i] },
    { label: 'Основная камера', patterns: [/основн.*камер|тылов.*камер/i] },
    { label: 'Фронтальная камера', patterns: [/фронтал.*камер/i] },
    { label: 'Аккумулятор', patterns: [/емкост.*аккумулятор|емкост.*батаре/i] },
    { label: 'SIM', patterns: [/тип sim|формат sim|количество sim|число sim/i] },
    { label: 'Связь', patterns: [/стандарт.*связ|сети 5g|поддержка 5g/i] },
    { label: 'NFC', patterns: [/^nfc$|бесконтактн.*оплат/i] },
    { label: 'Операционная система', patterns: [/операционн.*систем|^ос$/i] },
    { label: 'Размеры', patterns: [/размер.*корпус|габарит/i] },
    { label: 'Вес', patterns: [/^вес$|масса/i] },
  ],
  laptop: [
    { label: 'Экран', patterns: [/тип экрана|тип матриц|матриц/i] },
    { label: 'Диагональ', patterns: [/^диагональ(?: экрана)?$|размер экрана/i] },
    { label: 'Разрешение экрана', patterns: [/разрешение экрана|разрешение дисплея/i] },
    { label: 'Процессор', patterns: [/модель процессор|процессор|^cpu$/i] },
    { label: 'Оперативная память', patterns: [/оперативн.*памят|^ram$/i] },
    { label: 'Накопитель', patterns: [/объем ssd|объем hdd|накопител|встроенн.*памят/i] },
    { label: 'Видеокарта', patterns: [/видеокарт|графическ.*адаптер|^gpu$/i] },
    { label: 'Операционная система', patterns: [/операционн.*систем|^ос$/i] },
    { label: 'Автономность', patterns: [/время автоном|время работы|аккумулятор/i] },
    { label: 'Вес', patterns: [/^вес$|масса/i] },
  ],
  controller: [
    { label: 'Тип устройства', patterns: [/^тип$|тип устройства|назначение/i] },
    { label: 'Совместимость', patterns: [/совместим|поддерживаем.*платформ/i] },
    { label: 'Подключение', patterns: [/тип подключ|интерфейс подключ|беспроводн.*связ/i] },
    { label: 'Разъём', patterns: [/разъем|разъём|connector/i] },
    { label: 'Питание', patterns: [/питание|аккумулятор|время работы/i] },
    { label: 'Вибрация', patterns: [/вибро/i] },
    { label: 'Размеры', patterns: [/размер|габарит/i] },
    { label: 'Вес', patterns: [/^вес$|масса/i] },
  ],
  charger: [
    { label: 'Мощность', patterns: [/мощност|power/i] },
    { label: 'Вход', patterns: [/входн.*напряж|параметры вход|^вход$/i] },
    { label: 'Выход', patterns: [/выходн.*напряж|выходн.*ток|параметры выход|^выход$/i] },
    { label: 'Разъёмы', patterns: [/выходн.*разъем|выходн.*разъём|тип разъем|тип разъём|коннектор/i] },
    { label: 'Количество портов', patterns: [/количество.*порт/i] },
    { label: 'Быстрая зарядка', patterns: [/быстр.*заряд|power delivery|quick charge/i] },
    { label: 'Совместимость', patterns: [/совместим/i] },
  ],
  cable: [
    { label: 'Тип', patterns: [/^тип$|тип кабел|назначение/i] },
    { label: 'Разъём 1', patterns: [/разъем 1|разъём 1|входн.*разъем|входн.*разъём/i] },
    { label: 'Разъём 2', patterns: [/разъем 2|разъём 2|выходн.*разъем|выходн.*разъём/i] },
    { label: 'Интерфейс', patterns: [/интерфейс|коннектор/i] },
    { label: 'Длина', patterns: [/длина кабел|^длина$/i] },
    { label: 'Максимальный ток', patterns: [/максимальн.*ток|сила тока/i] },
    { label: 'Мощность', patterns: [/мощност/i] },
    { label: 'Материал', patterns: [/материал|оплетк|оплётк/i] },
  ],
  accessory: [
    { label: 'Тип', patterns: [/^тип$|тип аксессуар|назначение/i] },
    { label: 'Совместимость', patterns: [/совместим|модель устройства/i] },
    { label: 'Материал', patterns: [/материал/i] },
    { label: 'Размер', patterns: [/размер|диагональ|габарит/i] },
    { label: 'Особенности', patterns: [/особенност|функц/i] },
    { label: 'Комплектация', patterns: [/комплектац/i] },
    { label: 'Вес', patterns: [/^вес$|масса/i] },
  ],
}

const colourRule: SpecRule = { label: 'Цвет', patterns: [/^цвет$|цвет корпуса|основной цвет|body color/i] }
const makerRule: SpecRule = { label: 'Производитель', patterns: [/производител|изготовител|^бренд$|^brand$/i] }

function productTemplate(product: { name: string; brand?: string | null; category?: string | { name?: string } | null }) {
  const parsed = identity(product)
  if (parsed.kind === 'smartphone') return 'smartphone'
  if (parsed.kind === 'laptop') return 'laptop'
  if (parsed.kind === 'charger') return 'charger'
  if (parsed.kind === 'cable') return 'cable'
  if (['case', 'screen-protector', 'watch-strap'].includes(parsed.kind || '')) return 'accessory'
  const text = `${product.name} ${typeof product.category === 'string' ? product.category : product.category?.name || ''}`
  if (/геймпад|контроллер|dualshock|dualsense|игровая приставка/i.test(text)) return 'controller'
  if (/адаптер|блок питания|зарядн/i.test(text)) return 'charger'
  if (/кабель|переходник/i.test(text)) return 'cable'
  return 'accessory'
}

export function curateProductSpecs(
  product: { name: string; brand?: string | null; category?: string | { name?: string } | null },
  rawSpecs: SourcedSpec[],
) {
  const cleaned = rawSpecs.map(item => ({
    label: String(item?.label || '').replace(/\s+/g, ' ').trim(),
    value: String(item?.value || '').replace(/\s+/g, ' ').trim(),
  })).filter(item => item.label && item.value && item.label.length <= 100 && item.value.length <= 240)
  const rules = [makerRule, ...(templates[productTemplate(product)] || templates.accessory), colourRule]
  const result: SourcedSpec[] = []
  for (const rule of rules) {
    const found = cleaned.find(item => rule.patterns.some(pattern => pattern.test(item.label)))
    if (found && !result.some(item => item.label === rule.label)) result.push({ label: rule.label, value: found.value })
  }
  return result.slice(0, 12)
}

