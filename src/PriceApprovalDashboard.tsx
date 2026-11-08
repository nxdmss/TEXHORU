import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ApiProduct, type OneCPriceSyncStatus, type PriceUpdateOperation } from './api'
import { PriceMonitorPanel } from './PriceMonitorPanel'
import './price-approval.css'

const rub = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('ru-RU').format(value) + ' ₽'
const terminal = new Set(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'])
const itemLabels: Record<string, string> = {
  CHECKING: 'Проверяем', READY: 'Подготовлено', PENDING: 'Ожидает 1С',
  APPLIED: 'Обновлено', SKIPPED: 'Без изменения', FAILED: 'Нужна проверка',
}
function operationLabel(operation: PriceUpdateOperation) {
  switch (operation.state) {
    case 'CHECKING': return `Проверяем цены: ${operation.checked} из ${operation.total}`
    case 'QUEUING': return 'Подготавливаем передачу в 1С'
    case 'WAITING': return operation.pending ? `Ожидаем подтверждения 1С: ${operation.pending}` : 'Ждём завершения предыдущего обмена с 1С'
    case 'COMPLETED': return 'Обновление завершено'
    case 'PARTIAL': return 'Обновление завершено. Есть пропущенные товары'
    case 'CANCELLED': return 'Оставшиеся товары остановлены'
    case 'FAILED': return 'Обновление остановлено: нужна проверка'
    default: return 'Обновляем цены'
  }
}

export function PriceApprovalDashboard({ products }: { products: ApiProduct[] }) {
  const [inventory, setInventory] = useState(products)
  const [operation, setOperation] = useState<PriceUpdateOperation | null>(null)
  const [sync, setSync] = useState<OneCPriceSyncStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const [mode, setMode] = useState<'all' | 'selected'>('all')
  const [selected, setSelected] = useState<number[]>([])
  const [category, setCategory] = useState('')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(40)
  const [resultFilter, setResultFilter] = useState('ALL')
  const [toolsOpen, setToolsOpen] = useState(false)
  const polling = useRef(false)
  const requestVersion = useRef(0)
  const mounted = useRef(true)
  const active = !!operation && !terminal.has(operation.state)
  useEffect(() => setInventory(products), [products])

  const load = useCallback(async () => {
    const version = ++requestVersion.current
    const [current, exchange] = await Promise.all([api.priceUpdateCurrent(), api.priceSyncStatus()])
    if (!mounted.current || version !== requestVersion.current) return
    setOperation(current); setSync(exchange); setUnavailable(false); setLoading(false)
  }, [])
  useEffect(() => {
    mounted.current = true
    void load().catch(e => { if (mounted.current) { setError(e instanceof Error ? e.message : 'Не удалось загрузить цены'); setLoading(false) } })
    return () => { mounted.current = false }
  }, [load])
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden || polling.current || busy) return
      polling.current = true
      void load().catch(() => { if (mounted.current) setUnavailable(true) }).finally(() => { polling.current = false })
    }, active ? 5000 : 15000)
    return () => window.clearInterval(timer)
  }, [active, busy, load])

  const eligible = useMemo(() => inventory.filter(p => p.oneCId && p.status === 'ACTIVE'), [inventory])
  const categories = useMemo(() => {
    const paths = new Set<string>()
    for (const p of eligible) {
      const parts = p.category.name.split(' / ')
      parts.forEach((_, i) => paths.add(parts.slice(0, i + 1).join(' / ')))
    }
    return [...paths].sort((a, b) => a.localeCompare(b, 'ru'))
  }, [eligible])
  const filterProducts = (path: string, query: string) => eligible.filter(p =>
    (!path || p.category.name === path || p.category.name.startsWith(path + ' / '))
    && (p.name + ' ' + p.sku).toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')))
  const visible = filterProducts(category, search)
  const chosen = mode === 'all' ? eligible : eligible.filter(p => selected.includes(p.id))
  const visibleResults = operation?.items.filter(item => resultFilter === 'ALL' || item.status === resultFilter) || []
  const agent = sync?.agent
  const connection = unavailable ? 'Связь с сайтом прервана' : !agent || !agent.online
    ? 'Ожидаем связь с компьютером 1С' : agent.state === 'error'
    ? 'Агент на связи: есть ошибка' : 'Компьютер 1С на связи'
  const locked = loading || busy || active

  function filterSelection(path: string, query: string) {
    setCategory(path); setSearch(query); setLimit(40); setMode('selected')
    setSelected(filterProducts(path, query).map(p => p.id))
  }
  function toggleProduct(id: number, checked: boolean) {
    const current = mode === 'all' ? eligible.map(p => p.id) : selected
    setMode('selected')
    setSelected(checked ? [...new Set([...current, id])] : current.filter(value => value !== id))
  }
  async function start() {
    if (locked || !chosen.length || !sync?.testPriceSyncEnabled) return
    requestVersion.current++
    setBusy(true); setError('')
    try {
      const current = await api.startPriceUpdate(mode === 'all' ? undefined : chosen.map(p => p.id))
      setOperation(current); setResultFilter('ALL')
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось начать обновление') }
    finally { setBusy(false) }
  }
  async function stop() {
    if (!operation || !active || busy) return
    requestVersion.current++
    setBusy(true); setError('')
    try { setOperation(await api.cancelPriceUpdate(operation.id)) }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось остановить оставшиеся товары') }
    finally { setBusy(false) }
  }

  return <section className="pu-root">
    <header className="pu-heading">
      <div><h2>Цены</h2><p>Проверка 05.ru → обновление в TEST 1С → подтверждение на сайте.</p></div>
      <div className="pu-main-action">
        <button type="button" className="pu-primary" onClick={() => void start()}
          disabled={locked || !chosen.length || !sync?.testPriceSyncEnabled}>
          {busy ? 'Запускаем…' : active ? 'Обновление идёт…' : mode === 'all' ? 'Обновить все цены' : `Обновить выбранные (${chosen.length})`}
        </button>
        <span>{mode === 'all' ? `Все товары из 1С · ${eligible.length}` : `Выбрано ${chosen.length} из ${eligible.length}`}</span>
      </div>
    </header>

    <div className="pu-connection" role="status">
      <span className={agent?.online && !unavailable && agent.state !== 'error' ? 'pu-dot is-online' : 'pu-dot'} aria-hidden="true" />
      <span>{connection}</span>
      {agent && <time dateTime={agent.lastSeenAt}>{new Date(agent.lastSeenAt).toLocaleTimeString('ru-RU')}</time>}
    </div>
    {loading && <p className="pu-note">Загружаем сведения…</p>}
    {sync && !sync.testPriceSyncEnabled && <p className="pu-error" role="alert">Обновление цен в TEST 1С выключено на сервере.</p>}
    {error && <p className="pu-error" role="alert">{error}</p>}
    {!loading && !eligible.length && <p className="pu-note">Сначала загрузи товары из тестовой 1С.</p>}

    {operation && <section className="pu-status" aria-label="Ход обновления">
      <div className="pu-status-line"><strong>{operationLabel(operation)}</strong>
        <time dateTime={operation.createdAt}>{new Date(operation.createdAt).toLocaleString('ru-RU')}</time></div>
      {active && <progress aria-label="Ход обновления цен" max={Math.max(1, operation.total)}
        value={operation.state === 'CHECKING' ? operation.checked : operation.applied + operation.skipped + operation.failed} />}
      <div className="pu-counts">
        <span><b>{operation.applied}</b> обновлено</span>
        {operation.pending > 0 && <span><b>{operation.pending}</b> ждут 1С</span>}
        {operation.skipped > 0 && <span><b>{operation.skipped}</b> без изменения</span>}
        {operation.failed > 0 && <span className="pu-attention"><b>{operation.failed}</b> с ошибкой</span>}
      </div>
      <details className="pu-results">
        <summary>Что обновилось <span>{operation.total}</span></summary>
        {operation.error && <p className="pu-error">{operation.error}</p>}
        <div className="pu-result-tools">
          <select aria-label="Результаты обновления" value={resultFilter} onChange={e => setResultFilter(e.target.value)}>
            <option value="ALL">Все</option><option value="APPLIED">Обновлены</option>
            <option value="PENDING">Ожидают 1С</option><option value="SKIPPED">Без изменения</option>
            <option value="FAILED">С ошибкой</option>
          </select>
          <button type="button" onClick={() => void load().catch(() => setUnavailable(true))}>Обновить сведения</button>
        </div>
        <div className="pu-result-list">{visibleResults.map(item => <article className="pu-result" key={item.productId}>
          <div><strong>{item.name}</strong><small>{item.categoryPath}</small></div>
          <span className={'pu-item-state pu-item-' + item.status.toLowerCase()}>{itemLabels[item.status] || item.status}</span>
          <span className="pu-price">{item.newPrice !== null ? <>{rub(item.oldPrice)} <span aria-hidden="true">→</span> <b>{rub(item.newPrice)}</b></> : '—'}</span>
          {item.reason && <details className="pu-item-reason"><summary>Подробности</summary><p>{item.reason}</p></details>}
        </article>)}</div>
        {!visibleResults.length && <p className="pu-note">В этой группе товаров нет.</p>}
        {active && <div className="pu-stop"><button type="button" onClick={() => void stop()} disabled={busy}>Остановить подготовку</button>
          <small>Уже переданные в 1С изменения сохраняются.</small></div>}
      </details>
    </section>}

    <details className="pu-selection">
      <summary>Выбрать товары <span>{mode === 'all' ? 'Все' : chosen.length}</span></summary>
      <div className="pu-selection-tools">
        <select aria-label="Раздел товаров" value={category} onChange={e => filterSelection(e.target.value, search)} disabled={locked}>
          <option value="">Все разделы</option>{categories.map(path => <option key={path} value={path}>{path}</option>)}
        </select>
        <input aria-label="Поиск товаров для обновления" placeholder="Название или артикул" value={search} disabled={locked}
          onChange={e => filterSelection(category, e.target.value)} />
      </div>
      <div className="pu-select-actions">
        <button type="button" disabled={locked} onClick={() => { setMode('all'); setCategory(''); setSearch('') }}>Все товары</button>
        <button type="button" disabled={locked || !visible.length} onClick={() => { setMode('selected'); setSelected(visible.map(p => p.id)) }}>Выбрать найденные ({visible.length})</button>
        <button type="button" disabled={locked} onClick={() => { setMode('selected'); setSelected([]) }}>Снять выбор</button>
      </div>
      <div className="pu-product-list">{visible.slice(0, limit).map(p => <label key={p.id}>
        <input type="checkbox" aria-label={'Обновить товар: ' + p.name}
          checked={mode === 'all' || selected.includes(p.id)} disabled={locked}
          onChange={e => toggleProduct(p.id, e.target.checked)} />
        <span><strong>{p.name}</strong><small>{p.category.name}</small></span><b>{rub(p.price)}</b>
      </label>)}</div>
      {!visible.length && <p className="pu-note">Товары не найдены.</p>}
      {visible.length > limit && <button type="button" className="pu-more" onClick={() => setLimit(value => value + 40)}>Показать ещё {Math.min(40, visible.length - limit)}</button>}
    </details>

    <details className="pu-advanced" onToggle={e => setToolsOpen(e.currentTarget.open)}>
      <summary>Связи с 05.ru и дополнительные проверки</summary>
      {toolsOpen && <PriceMonitorPanel products={inventory} initialPath={category} />}
    </details>
    <details className="pu-rule"><summary>Как обновляются цены</summary>
      <p>Для подтверждённых совпадений используем свежую цену 05.ru минус 100 ₽. Другая память, цвет, состояние или изменение больше 10% требуют проверки. Цена сайта меняется после подтверждения 1С.</p>
    </details>
  </section>
}
