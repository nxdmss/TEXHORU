/** CSV/TSV exported from Excel; each row is a user-supplied observation, not a verified shop price. */
export type ManualPriceRow = {
  oneCId?: string
  url: string
  name: string
  price: number
  observedAt: string
  inStock?: boolean
}

function csvRows(source: string): string[][] {
  const input = source.replace(/^\uFEFF/, '')
  const header = input.split(/\r?\n/, 1)[0] || ''
  const delimiter = header.includes('\t') ? '\t' : header.includes(';') ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { field += '"'; i++ }
      else quoted = !quoted
    } else if (char === delimiter && !quoted) {
      row.push(field.trim()); field = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[i + 1] === '\n') i++
      row.push(field.trim()); field = ''
      if (row.some(Boolean)) rows.push(row)
      row = []
    } else field += char
  }
  if (quoted) throw new Error('Незакрытая кавычка в CSV.')
  row.push(field.trim())
  if (row.some(Boolean)) rows.push(row)
  return rows
}

export function parseManualPriceCsv(input: string): ManualPriceRow[] {
  const rows = csvRows(input)
  if (rows.length < 2) throw new Error('Файл пустой. Заполни хотя бы одну строку с ценой.')
  const fields = rows[0].map(value => value.toLowerCase().replace(/[\s_-]/g, ''))
  const column = (name: string) => fields.indexOf(name.toLowerCase())
  for (const key of ['onecId', 'url', 'name', 'price', 'observedAt']) {
    if (column(key) < 0) throw new Error('В CSV нет столбца ' + key + '. Скачай шаблон из TEXHORU.')
  }
  const out: ManualPriceRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const get = (key: string) => rows[i][column(key)]?.trim() || ''
    const url = get('url')
    const priceText = get('price')
    if (!url && !priceText) continue // Blank template rows haven't been filled yet.
    const name = get('name')
    const observedAt = get('observedAt')
    const money = priceText.replace(/[\s\u00A0\u202F₽]/g, '').replace(/(?:руб\.?|RUB)$/i, '').replace(/,00$|\.00$/, '')
    const price = Number(money)
    if (!url || !name || !observedAt || !money || !Number.isSafeInteger(price) || price < 1) {
      throw new Error('Строка ' + (i + 1) + ': заполни url, name, целую цену в рублях и observedAt (ISO с часовым поясом).')
    }
    const stock = column('inStock') >= 0 ? get('inStock').toLowerCase() : ''
    let inStock: boolean | undefined
    if (['да', 'yes', 'true', '1', 'есть'].includes(stock)) inStock = true
    else if (['нет', 'no', 'false', '0'].includes(stock)) inStock = false
    else if (stock) throw new Error('Строка ' + (i + 1) + ': наличие должно быть «да», «нет» или пусто.')
    out.push({ oneCId: get('oneCId') || undefined, url, name, price, observedAt, ...(inStock === undefined ? {} : { inStock }) })
  }
  if (!out.length) throw new Error('В CSV нет заполненных строк с ценами и ссылками.')
  if (out.length > 500) throw new Error('За один раз можно загрузить не более 500 строк.')
  return out
}

function safeCsv(value: string): string {
  // Prevent spreadsheet formula execution when a product label originates in external 1C data.
  const safe = /^[=+\-@]/.test(value) ? "'" + value : value
  return '"' + safe.replace(/"/g, '""') + '"'
}

export function oneCPriceTemplate(products: Array<{ oneCId?: string | null; name: string }>): string {
  const header = 'oneCId;url;name;price;observedAt;inStock'
  const rows = products.filter(product => product.oneCId).map(product =>
    [product.oneCId || '', '', product.name, '', '', ''].map(safeCsv).join(';'))
  return '\uFEFF' + [header, ...rows].join('\r\n') + '\r\n'
}
