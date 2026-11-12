import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ApiProduct, type OneCPriceSyncStatus, type PriceReadiness, type PriceUpdateOperation } from './api'
import { PriceMonitorPanel } from './PriceMonitorPanel'
import { AdminIcon } from './AdminIcon'
import './price-approval.css'

const rub = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('ru-RU').format(value) + ' ₽'
const terminal = new Set(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'])
const itemLabels: Record<string, string> = {
  CHECKING: 'Проверяем', READY: 'Подготовлено', PENDING: 'Ожидает 1С',
  APPLIED: 'Обновлено', SKIPPED: 'Без изменения', FAILED: 'Нужна проверка',
}
function shortReason(reason: string) {
  if (reason.includes('не совпадает')) return 'Не совпадают характеристики'
  if (reason.includes('Не разрешён')) return 'Не разрешён обмен с 1С'
  if (reason.includes('Нет привязки')) return 'Нет привязки к 05.ru'
  if (reason.includes('не подтверждено')) return 'Нужно подтвердить привязку или наличие'
  if (reason.includes('Последняя проверка завершилась ошибкой')) return 'Ошибка проверки 05.ru'
  if (reason.includes('устарела') || reason.includes('свежая')) return 'Нужна свежая проверка цены'
  if (reason.includes('уже совпадает')) return 'Цена уже актуальна'
  if (reason.includes('остатка')) return 'Нет свободного остатка'
  if (reason.includes('Нет актуальной цены')) return 'Нет цены 05.ru'
  return reason.split('; ')[0]
}
function checkError(message: string) {
  if (/не (?:найден|удалось запустить) браузер|executable doesn't exist/i.test(message)) return 'Не удалось запустить браузер проверки на сервере.'
  const http = message.match(/HTTP\s+(401|403|429)\b/i)?.[1]
  if (http === '429') return '05.ru ограничил частоту запросов (HTTP 429). Проверка остановлена.'
  if (http || /сайт ограничил запросы|проверку доступа/i.test(message)) return '05.ru ограничил доступ к карточкам' + (http ? ` (HTTP ${http})` : '') + '.'
  if (/подтверждение снято/i.test(message)) return 'Часть карточек не совпадает с товарами 1С. Проверь привязки.'
  if (/timeout|timed out|тайм.?аут|не ответил/i.test(message)) return '05.ru не ответил вовремя.'
  return 'Не удалось проверить часть карточек. Причина — в подробностях ниже.'
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

export function PriceApprovalDashboard({ products, initialSetup = false, onInventoryRefresh }: {
  products: ApiProduct[]; initialSetup?: boolean; onInventoryRefresh: () => Promise<void>;
}) {
  const inventory = products
  const [readiness, setReadiness] = useState<PriceReadiness | null>(null)
  const [group, setGroup] = useState<'READY' | 'PENDING' | 'BLOCKED'>('READY')
  const [listOpen, setListOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [operation, setOperation] = useState<PriceUpdateOperation | null>(null)
  const [sync, setSync] = useState<OneCPriceSyncStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [checkStarting, setCheckStarting] = useState(false)
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const [mode, setMode] = useState<'all' | 'selected'>('all')
  const [selected, setSelected] = useState<number[]>([])
  const [category, setCategory] = useState('')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(40)
  const [resultFilter, setResultFilter] = useState('ALL')
  const [toolsOpen, setToolsOpen] = useState(initialSetup)
  const toolsRef = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (initialSetup) { setToolsOpen(true); toolsRef.current?.scrollIntoView({ block: 'start' }) }
  }, [initialSetup])
  const polling = useRef(false)
  const requestVersion = useRef(0)
  const mounted = useRef(true)
  const active = !!operation && !terminal.has(operation.state)

  const load = useCallback(async () => {
    const version = ++requestVersion.current
    const [current, exchange, availability] = await Promise.all([api.priceUpdateCurrent(), api.priceSyncStatus(), api.priceReadiness()])
    if (!mounted.current || version !== requestVersion.current) return
    setOperation(current); setSync(exchange); setReadiness(availability); setUnavailable(false); setLoading(false)
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
    }, active || readiness?.checking ? 5000 : 15000)
    return () => window.clearInterval(timer)
  }, [active, busy, load, readiness?.checking])

  const items = readiness?.items || []
  const eligible = items.filter(item => item.status === 'READY')
  const categories = useMemo(() => {
    const paths = new Set<string>()
    for (const p of readiness?.items || []) {
      const parts = p.categoryPath.split(' / ')
      parts.forEach((_, i) => paths.add(parts.slice(0, i + 1).join(' / ')))
    }
    return [...paths].sort((a, b) => a.localeCompare(b, 'ru'))
  }, [readiness])
  const visible = items.filter(p => p.status === group
    && (!category || p.categoryPath === category || p.categoryPath.startsWith(category + ' / '))
    && p.name.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')))
  const chosen = mode === 'all' ? eligible : eligible.filter(p => selected.includes(p.productId))
  const visibleResults = operation?.items.filter(item => resultFilter === 'ALL' || item.status === resultFilter) || []
  const agent = sync?.agent
  const connection = unavailable ? 'Связь с сайтом прервана' : !agent || !agent.online
    ? 'Ожидаем связь с компьютером 1С' : agent.state === 'error'
    ? 'Агент на связи: есть ошибка' : 'Компьютер 1С на связи'
  const locked = loading || busy || active || !!readiness?.checking
  const priceCheck = readiness?.priceCheck
  const checkActive = !!priceCheck && ['QUEUED', 'RUNNING'].includes(priceCheck.status)
  const checkWarning = !!priceCheck && (['FAILED', 'CANCELLED'].includes(priceCheck.status)
    || priceCheck.errors > 0 || !!priceCheck.lastError)
  const currentPrices = items.filter(p => p.authorized && p.reason === 'Предлагаемая цена уже совпадает с текущей ценой TEXHORU').length

  function toggleProduct(id: number, checked: boolean) {
    const current = mode === 'all' ? eligible.map(p => p.productId) : selected
    setMode('selected')
    setSelected(checked ? [...new Set([...current, id])] : current.filter(value => value !== id))
  }
  async function checkPrices() {
    if (locked) return
    requestVersion.current++
    setBusy(true); setCheckStarting(true); setError(''); setNotice('')
    try {
      await api.checkAllowedPrices()
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось проверить цены') }
    finally { setBusy(false); setCheckStarting(false) }
  }
  async function start() {
    if (locked || !chosen.length || !sync?.testPriceSyncEnabled) return
    requestVersion.current++
    setBusy(true); setError('')
    try {
      const current = await api.startPriceUpdate(chosen.map(p => p.productId))
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
      <div><span className="admin-section-kicker">05.ru → 1С → сайт</span><h2>Цены</h2></div>
      <div className="pu-main-action">
        <button type="button" className="pu-primary" onClick={() => void start()}
          disabled={locked || !chosen.length || !sync?.testPriceSyncEnabled}>
          {busy && !checkStarting ? 'Запускаем…' : active ? 'Обновление идёт…' : mode === 'all' ? `Обновить все (${chosen.length})` : `Обновить выбранные (${chosen.length})`}
        </button>
        <span>После подтверждения 1С</span>
      </div>
    </header>

    <div className="pu-connection" role="status">
      <span className={agent?.online && !unavailable && agent.state !== 'error' ? 'pu-dot is-online' : 'pu-dot'} aria-hidden="true" />
      <span>{connection}</span>
      {agent && <time dateTime={agent.lastSeenAt}>{new Date(agent.lastSeenAt).toLocaleTimeString('ru-RU')}</time>}
    </div>
    {loading && <p className="pu-note">Загружаем сведения…</p>}
    {sync && !sync.testPriceSyncEnabled && <p className="pu-error" role="alert">Обновление цен в 1С выключено на сервере.</p>}
    {error && <p className="pu-error" role="alert">{error}</p>}
    {notice && <p className="pu-note" role="status">{notice}</p>}
    <div className="pu-groups" aria-label="Группы товаров">
      {([['READY', 'Готовы'], ['PENDING', 'Ждут 1С'], ['BLOCKED', 'Нужна проверка']] as const).map(([key, label]) =>
        <button type="button" key={key} className={group === key ? 'is-current' : ''} aria-pressed={group === key}
          onClick={() => { setGroup(key); setListOpen(true); setLimit(40) }}>
          <b>{items.filter(item => item.status === key).length}</b><span>{label}</span><AdminIcon name={key === 'READY' ? 'prices' : key === 'PENDING' ? 'sync' : 'audit'} />
        </button>)}
    </div>
    <div className="pu-check-action"><button type="button" disabled={locked || !readiness?.authorized}
      onClick={() => void checkPrices()}>{checkStarting || readiness?.checking ? 'Проверяем цены…' : 'Проверить цены'}</button>
      <small>Из 1С: {readiness?.authorized ?? 0}</small>
      <button className="pu-connect-button" type="button" onClick={() => {
        setToolsOpen(true)
        toolsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }}><AdminIcon name="plus" />Связи с 05.ru</button></div>

    {priceCheck && <section className={'pu-price-check' + (checkWarning ? ' has-warning' : '')} aria-label="Результат проверки цен 05.ru">
      <div className="pu-status-line"><strong role="status">{priceCheck.status === 'QUEUED' ? 'Проверка цен в очереди'
        : priceCheck.status === 'RUNNING' ? 'Проверяем цены 05.ru'
        : priceCheck.status === 'FAILED' ? 'Проверка цен остановлена'
        : priceCheck.status === 'CANCELLED' ? 'Проверка цен отменена'
        : priceCheck.perPage > 0 && priceCheck.errors >= priceCheck.perPage ? 'Не удалось проверить цены'
        : checkWarning ? 'Проверка завершена с замечаниями' : 'Цены 05.ru проверены'}</strong>
        <time dateTime={priceCheck.finishedAt || priceCheck.createdAt}>{new Date(priceCheck.finishedAt || priceCheck.createdAt).toLocaleString('ru-RU')}</time></div>
      {checkActive && <progress aria-label="Проверка карточек 05.ru" max={Math.max(1, priceCheck.perPage)} value={priceCheck.processed} />}
      <div className="pu-check-counts"><span>Обработано: <b>{priceCheck.processed} из {priceCheck.perPage}</b></span>
        {priceCheck.errors > 0 && <span>Ошибок: <b>{priceCheck.errors}</b></span>}
        {!checkActive && <><span>Готовы: <b>{eligible.length}</b></span>
          {currentPrices > 0 && <span>Цена уже актуальна: <b>{currentPrices}</b></span>}</>}
      </div>
      {priceCheck.lastError && <><p className="pu-check-error">{checkError(priceCheck.lastError)}</p>
        <details className="pu-check-details"><summary>Причина и подробности</summary><pre>{priceCheck.lastError}</pre></details></>}
      {!checkActive && !checkWarning && <p className="pu-check-hint">{eligible.length ? 'Можно отправить готовые цены в 1С.'
        : currentPrices > 0 ? 'Актуальные цены повторно отправлять не нужно. Остальные причины — в группе «Нужна проверка».'
        : 'Готовых изменений нет. Открой «Нужна проверка», чтобы увидеть причины.'}</p>}
      {unavailable && <p className="pu-check-error">Не удалось получить свежий результат. Проверяем связь с сайтом.</p>}
    </section>}

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

    <details className="pu-selection" open={listOpen} onToggle={e => setListOpen(e.currentTarget.open)}>
      <summary>{group === 'READY' ? 'Выбрать товары' : group === 'PENDING' ? 'Товары в очереди 1С' : 'Причины пропуска'} <span>{visible.length}</span></summary>
      <div className="pu-selection-tools">
        <select aria-label="Раздел товаров" value={category} onChange={e => { setCategory(e.target.value); setLimit(40) }}>
          <option value="">Все разделы</option>{categories.map(path => <option key={path} value={path}>{path}</option>)}
        </select>
        <input aria-label="Поиск товаров для обновления" placeholder="Название товара" value={search}
          onChange={e => { setSearch(e.target.value); setLimit(40) }} />
      </div>
      {group === 'READY' && <div className="pu-select-actions">
        <button type="button" disabled={locked} onClick={() => { setMode('all'); setCategory(''); setSearch('') }}>Все готовые</button>
        <button type="button" disabled={locked || !visible.length} onClick={() => { setMode('selected'); setSelected(visible.map(p => p.productId)) }}>Выбрать найденные ({visible.length})</button>
        <button type="button" disabled={locked} onClick={() => { setMode('selected'); setSelected([]) }}>Снять выбор</button>
      </div>}
      <div className="pu-product-list">{visible.slice(0, limit).map(p => <label key={p.productId}>
        {group === 'READY' && <input type="checkbox" aria-label={'Обновить товар: ' + p.name}
          checked={mode === 'all' || selected.includes(p.productId)} disabled={locked}
          onChange={e => toggleProduct(p.productId, e.target.checked)} />}
        <span><strong>{p.name}</strong><small>{p.categoryPath}</small>
          {p.reason && <span className="pu-short-reason" title={p.reason}>{shortReason(p.reason)}</span>}</span>
        <b>{rub(p.oldPrice)}{p.newPrice !== null && p.newPrice !== p.oldPrice && <> → {rub(p.newPrice)}</>}</b>
      </label>)}</div>
      {!visible.length && <p className="pu-note">{group === 'READY' ? 'Готовых товаров нет. Проверь цены или открой причины.' : 'Товаров в этой группе нет.'}</p>}
      {visible.length > limit && <button type="button" className="pu-more" onClick={() => setLimit(value => value + 40)}>Показать ещё {Math.min(40, visible.length - limit)}</button>}
    </details>

    <details className="pu-advanced" ref={toolsRef} open={toolsOpen} onToggle={e => setToolsOpen(e.currentTarget.open)}>
      <summary>Связи с 05.ru</summary>
      {toolsOpen && <div className="pu-setup">
        <PriceMonitorPanel products={inventory} initialPath={category} />
        <details className="pu-import-help"><summary>Добавить товары из 1С</summary>
          <p>Выгрузи нужную группу из подключённой базы 1С на этот сайт. Все товары подключатся автоматически.</p>
          <div className="pu-import-address"><span>Адрес</span><code>{window.location.hostname}</code></div>
          <button type="button" disabled={loading || busy} onClick={async () => {
            setBusy(true); setError('')
            try { await onInventoryRefresh(); await load(); setNotice('Список товаров обновлён.') }
            catch (e) { setError(e instanceof Error ? e.message : 'Не удалось обновить каталог') }
            finally { setBusy(false) }
          }}>Обновить список</button>
        </details>
      </div>}
    </details>
    <details className="pu-rule"><summary>Как обновляются цены</summary>
      <p>Товары подключаются через профиль базы 1С. Цена — максимум из «05.ru − 100 ₽» и закупочной. Без закупочной изменение блокируется. Сайт обновляется после ответа 1С.</p>
    </details>
  </section>
}
