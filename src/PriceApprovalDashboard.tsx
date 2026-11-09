import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ApiProduct, type OneCPriceSyncStatus, type PriceReadiness, type PriceUpdateOperation } from './api'
import { TestPriceScope } from './TestPriceScope'
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
  if (reason.includes('устарела') || reason.includes('свежая')) return 'Нужна свежая проверка цены'
  if (reason.includes('уже совпадает')) return 'Цена уже актуальна'
  if (reason.includes('остатка')) return 'Нет свободного остатка'
  if (reason.includes('Нет актуальной цены')) return 'Нет цены 05.ru'
  return reason.split('; ')[0]
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
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const [mode, setMode] = useState<'all' | 'selected'>('all')
  const [selected, setSelected] = useState<number[]>([])
  const [category, setCategory] = useState('')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(40)
  const [resultFilter, setResultFilter] = useState('ALL')
  const [toolsOpen, setToolsOpen] = useState(initialSetup)
  const [setupStep, setSetupStep] = useState<'catalog' | 'scope' | 'links'>('catalog')
  const toolsRef = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (initialSetup) { setToolsOpen(true); setSetupStep('catalog'); toolsRef.current?.scrollIntoView({ block: 'start' }) }
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

  function toggleProduct(id: number, checked: boolean) {
    const current = mode === 'all' ? eligible.map(p => p.productId) : selected
    setMode('selected')
    setSelected(checked ? [...new Set([...current, id])] : current.filter(value => value !== id))
  }
  async function checkPrices() {
    if (locked) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.checkAllowedPrices()
      setNotice(`Проверяем карточки: ${result.queued}.`)
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось проверить цены') }
    finally { setBusy(false) }
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
      <div><span className="admin-section-kicker">05.ru → 1С → сайт</span><h2>Цены под контролем</h2><p>Выбери готовые. Остальное сделает агент.</p></div>
      <div className="pu-main-action">
        <button type="button" className="pu-primary" onClick={() => void start()}
          disabled={locked || !chosen.length || !sync?.testPriceSyncEnabled}>
          {busy ? 'Запускаем…' : active ? 'Обновление идёт…' : mode === 'all' ? `Обновить готовые (${chosen.length})` : `Обновить выбранные (${chosen.length})`}
        </button>
        <span>Сайт обновится после подтверждения 1С</span>
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
    {notice && <p className="pu-note" role="status">{notice}</p>}
    <div className="pu-groups" aria-label="Группы товаров">
      {([['READY', 'Готовы к обновлению'], ['PENDING', 'Ждут 1С'], ['BLOCKED', 'Нельзя обновить']] as const).map(([key, label]) =>
        <button type="button" key={key} className={group === key ? 'is-current' : ''} aria-pressed={group === key}
          onClick={() => { setGroup(key); setListOpen(true); setLimit(40) }}>
          <b>{items.filter(item => item.status === key).length}</b><span>{label}</span><AdminIcon name={key === 'READY' ? 'prices' : key === 'PENDING' ? 'sync' : 'audit'} />
        </button>)}
    </div>
    <div className="pu-check-action"><button type="button" disabled={locked || !readiness?.authorized}
      onClick={() => void checkPrices()}>{readiness?.checking ? 'Проверяем цены…' : 'Проверить цены разрешённых'}</button>
      <small>{readiness?.authorized ?? 0} товаров · только разрешённые</small>
      <button className="pu-connect-button" type="button" onClick={() => {
        setToolsOpen(true); setSetupStep('catalog')
        toolsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }}><AdminIcon name="plus" />Подключить товары</button></div>

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
      {!visible.length && <p className="pu-note">{group === 'READY' ? 'Готовых товаров нет. Проверь цены разрешённых или открой причины пропуска.' : 'Товаров в этой группе нет.'}</p>}
      {visible.length > limit && <button type="button" className="pu-more" onClick={() => setLimit(value => value + 40)}>Показать ещё {Math.min(40, visible.length - limit)}</button>}
    </details>

    <details className="pu-advanced" ref={toolsRef} open={toolsOpen} onToggle={e => setToolsOpen(e.currentTarget.open)}>
      <summary>Подключение товаров <span>1С · допуск · 05.ru</span></summary>
      {toolsOpen && <div className="pu-setup">
        <nav className="pu-steps" aria-label="Шаги подключения товаров">
          {([['catalog', 'Товары из 1С'], ['scope', 'Допуск к обмену'], ['links', 'Карточки 05.ru']] as const).map(([key, title], i) =>
            <button type="button" key={key} aria-current={setupStep === key ? 'step' : undefined}
              onClick={() => setSetupStep(key)}><b>{String(i + 1).padStart(2, '0')}</b><span>{title}</span></button>)}
        </nav>
        {setupStep === 'catalog' && <section className="pu-import-guide" aria-label="Добавление товаров из 1С">
          <div className="pu-import-icon"><AdminIcon name="products" /></div>
          <h3>Новые товары? Начни в 1С.</h3>
          <p>В обработке выгрузки TEST выбери нужную группу и отправь каталог на этот сайт. Повторная выгрузка обновит существующие товары.</p>
          <div className="pu-import-address"><span>Адрес сайта</span><code>{window.location.hostname}</code></div>
          <details><summary>Где указать адрес и ключ?</summary><p>В обработке выгрузки каталога укажи этот хост вместо старого ngrok и ключ обмена с облачным сервером. В некоторых версиях обработки хост задан в модуле формы. Агент цен получает задания, а каталог отправляется отдельной выгрузкой.</p></details>
          <div className="pu-import-actions"><button type="button" disabled={loading || busy} onClick={async () => {
            setBusy(true); setError('')
            try { await onInventoryRefresh(); await load(); setNotice('Каталог обновлён. Выбери товары для обмена.'); setSetupStep('scope') }
            catch (e) { setError(e instanceof Error ? e.message : 'Не удалось обновить каталог') }
            finally { setBusy(false) }
          }}>Я выгрузил — обновить каталог <AdminIcon name="refresh" /></button>
          <button type="button" onClick={() => setSetupStep('scope')}>Товары уже на сайте <AdminIcon name="arrow" /></button></div>
          <small>В каталоге из 1С: {inventory.filter(p => p.oneCId).length}</small>
        </section>}
        {setupStep === 'scope' && sync && <>
          <TestPriceScope products={inventory} scope={sync.scope} enabled={!!sync.testPriceSyncEnabled}
            disabled={locked} path={category} onChanged={load} />
          <div className="pu-step-next"><button type="button" onClick={() => setSetupStep('links')}>Далее: карточки 05.ru <AdminIcon name="arrow" /></button></div>
        </>}
        {setupStep === 'links' && <>
          <PriceMonitorPanel products={inventory} initialPath={category} />
          <div className="pu-step-next"><button type="button" onClick={() => { setToolsOpen(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Готово — к обновлению цен <AdminIcon name="arrow" /></button></div>
        </>}
      </div>}
    </details>
    <details className="pu-rule"><summary>Как обновляются цены</summary>
      <p>Кнопка обновляет все готовые товары или только выбранные. Разрешения не меняются автоматически. Для подтверждённых совпадений используем свежую цену 05.ru минус 100 ₽. Другая память, цвет или состояние требуют проверки. В TEST ограничение изменения 10% временно отключено. Цена сайта меняется после подтверждения 1С.</p>
    </details>
  </section>
}
