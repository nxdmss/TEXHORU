import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ApiProduct, type MonitorJob, type OneCPriceSyncStatus, type PriceApprovalPreview, type PriceMonitorItem } from './api'
import { PriceMonitorPanel } from './PriceMonitorPanel'
import './price-approval.css'

const rub = (value: number) => new Intl.NumberFormat('ru-RU').format(value) + ' ₽'
const dateLabel = (value: string | null | undefined) => value ? new Date(value).toLocaleString('ru-RU') : '—'
const inside = (category: string, path: string) => !path || category === path || category.startsWith(path + ' / ')
const fresh = (link: PriceMonitorItem) => !!link.lastSuccessAt && !link.lastError
  && link.inStock === true && link.matchStatus === 'CONFIRMED'
  && Date.now() - new Date(link.lastSuccessAt).getTime() <= 86400_000
  && Date.now() >= new Date(link.lastSuccessAt).getTime()

function childCategories(products: ApiProduct[], path: string) {
  const children = new Map<string, number>()
  for (const product of products) {
    const category = product.category?.name || ''
    if (!inside(category, path) || category === path) continue
    const suffix = path ? category.slice(path.length + 3) : category
    const segment = suffix.split(' / ')[0]
    if (segment) children.set(segment, (children.get(segment) || 0) + 1)
  }
  return [...children].sort((a, b) => a[0].localeCompare(b[0], 'ru'))
}

export function PriceApprovalDashboard({ products, onCatalogImported }: {
  products: ApiProduct[]
  onCatalogImported: () => Promise<void>
}) {
  const [inventory, setInventory] = useState(products)
  const [preview, setPreview] = useState<PriceApprovalPreview | null>(null)
  const [links, setLinks] = useState<PriceMonitorItem[]>([])
  const [jobs, setJobs] = useState<MonitorJob[]>([])
  const [exchange, setExchange] = useState<OneCPriceSyncStatus>({ scope: [], changes: [] })
  const [interval, setInterval] = useState(0)
  const [nextRun, setNextRun] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [view, setView] = useState<'offers' | 'all' | 'issues'>('offers')
  const [path, setPath] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [limit, setLimit] = useState(60)
  const [advanced, setAdvanced] = useState(false)
  const lastToken = useRef<string | null>(null)
  const polling = useRef(false)

  useEffect(() => setInventory(products), [products])
  const load = useCallback(async (includeProducts = false) => {
    const [proposal, matched, tasks, sync, settings, stock] = await Promise.all([
      api.monitorBulkPreview(''), api.adminPriceMonitor(), api.monitorJobs(),
      api.priceSyncStatus(), api.monitorSettings('05ru'),
      includeProducts ? api.adminProducts() : Promise.resolve(null),
    ])
    if (proposal.token !== lastToken.current) {
      lastToken.current = proposal.token
      setSelected([])
    }
    setPreview(proposal)
    setLinks(matched)
    setJobs(tasks)
    setExchange(sync)
    setInterval(settings.intervalMinutes)
    setNextRun(settings.nextRunAt)
    if (stock) setInventory(stock)
    setLoading(false)
  }, [])

  useEffect(() => {
    let active = true
    void load(true).catch(e => { if (active) { setError(e instanceof Error ? e.message : 'Не удалось загрузить цены'); setLoading(false) } })
    const timer = window.setInterval(() => {
      if (polling.current || busy) return
      polling.current = true
      void load().catch(() => undefined).finally(() => { polling.current = false })
    }, 30000)
    return () => { active = false; window.clearInterval(timer) }
  }, [load, busy])

  const allOneC = useMemo(() => inventory.filter(product =>
    !!product.oneCId && product.status === 'ACTIVE'), [inventory])
  const current = useMemo(() => allOneC.filter(product =>
    inside(product.category?.name || '', path)
    && (!search.trim() || (product.name + ' ' + product.sku).toLocaleLowerCase('ru')
      .includes(search.trim().toLocaleLowerCase('ru')))), [allOneC, path, search])
  const children = useMemo(() => childCategories(allOneC, path), [allOneC, path])
  const linked = useMemo(() => {
    const map = new Map<number, PriceMonitorItem>()
    for (const item of links) {
      if (!item.product?.id) continue
      const previous = map.get(item.product.id)
      if (!previous || (item.matchStatus === 'CONFIRMED' && previous.matchStatus !== 'CONFIRMED')) map.set(item.product.id, item)
    }
    return map
  }, [links])
  const offers = useMemo(() => (preview?.items || []).filter(item =>
    inside(item.categoryPath, path)
    && (!search.trim() || item.productName.toLocaleLowerCase('ru')
      .includes(search.trim().toLocaleLowerCase('ru')))), [preview, path, search])
  const groupedOffers = useMemo(() => {
    const categories = new Map<string, typeof offers>()
    for (const item of offers) categories.set(item.categoryPath, [...(categories.get(item.categoryPath) || []), item])
    return [...categories].sort(([a], [b]) => a.localeCompare(b, 'ru'))
  }, [offers])
  const issues = useMemo(() => current.filter(product => {
    if (!product.priceSyncEnabled) return false
    const link = linked.get(product.id)
    return !link || !fresh(link)
  }), [current, linked])
  const running = jobs.find(job => job.status === 'QUEUED' || job.status === 'RUNNING')
  const lastCheck = jobs.find(job => job.kind === 'RECHECK')
  const selectedVisible = selected.filter(id => offers.some(item => item.id === id))
  const shownProposals = offers.length
  const pending = exchange.changes.filter(change => change.status === 'PENDING').length
  const failed = exchange.changes.filter(change => change.status === 'CONFLICT' || change.status === 'FAILED').length

  async function checkNow() {
    if (running) return
    setBusy('checking'); setError(''); setNotice('')
    try {
      await api.monitorCheckAll('05ru')
      setNotice('Проверка началась. После завершения появятся свежие предложения.')
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось начать проверку') }
    finally { setBusy('') }
  }

  async function decide(action: 'apply' | 'reject') {
    if (!preview || !selectedVisible.length || running) return
    const chosen = offers.filter(item => selectedVisible.includes(item.id))
    const question = action === 'apply'
      ? 'Утвердить цены для ' + chosen.length + ' товаров?\n\nНовые цены появятся на сайте и будут ожидать подтверждения 1С.'
      : 'Не менять цены для ' + chosen.length + ' товаров?\n\nЭти предложения будут скрыты до изменения цены товара или конкурента.'
    if (!window.confirm(question)) return
    setBusy(action); setError(''); setNotice('')
    try {
      if (action === 'apply') {
        const result = await api.monitorBulkApply({ categoryPath: '', token: preview.token, ids: chosen.map(item => item.id),
          acceptUnknownCost: false, acceptLargeChange: false })
        setNotice('Утверждено: ' + result.applied + '. Отправлено в очередь 1С: ' + result.oneCQueued + '. Следите за подтверждением.')
        await onCatalogImported()
      } else {
        const result = await api.monitorBulkReject({ categoryPath: '', token: preview.token, ids: chosen.map(item => item.id) })
        setNotice('Без изменений оставлено товаров: ' + result.rejected + '.')
      }
      await load(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'Не получилось сохранить решение. Данные не подтверждены.') }
    finally { setBusy('') }
  }

  async function toggleSchedule(enabled: boolean) {
    setBusy('schedule'); setError('')
    try {
      const settings = await api.monitorSaveSettings('05ru', 'https://05.ru/cat/c/02e38f8a/telefony_i_gadzety/', enabled ? 1440 : 0)
      setInterval(settings.intervalMinutes); setNextRun(settings.nextRunAt)
      setNotice(enabled ? 'Ежедневная проверка включена на 06:00 по Москве.' : 'Автоматическая проверка выключена.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить расписание') }
    finally { setBusy('') }
  }

  const statusFor = (product: ApiProduct) => {
    const sync = exchange.changes.find(c => c.oneCId === product.oneCId)
    if (sync?.status === 'PENDING') return 'Ожидает 1С'
    if (sync?.status === 'CONFLICT' || sync?.status === 'FAILED') return 'Ошибка передачи'
    if (sync?.status === 'DELIVERED') return 'Цена подтверждена в 1С'
    return product.priceSyncEnabled ? 'Связан с 1С' : 'Цена управляется в 1С'
  }

  return <section className="pa-root">
    <header className="pa-top">
      <div><h2>Мониторинг цен</h2><p>Предложения по категориям из 1С. Решение всегда принимает человек.</p></div>
      <button className="pa-action pa-secondary" onClick={() => void checkNow()} disabled={Boolean(busy) || Boolean(running)}>
        {running ? 'Проверяем…' : busy === 'checking' ? 'Запускаем…' : 'Проверить цены'}
      </button>
    </header>

    <div className="pa-overview" role="status">
      <div><strong>{preview?.count ?? '—'}</strong><span>Предложений</span></div>
      <div><strong>{pending}</strong><span>Ожидают 1С</span></div>
      <div><strong>{failed}</strong><span>Ошибок передачи</span></div>
    </div>
    <p className="pa-schedule-label">Автопроверка: {interval === 1440 ? 'каждый день в 06:00 (МСК)' : interval > 0 ? 'по другому расписанию' : 'выключена'}
      {interval > 0 ? ' · следующая: ' + dateLabel(nextRun) : ''}.
      {lastCheck ? ' Последний запуск: ' + dateLabel(lastCheck.createdAt) + '.' : ''}</p>
    {running && <div className="pa-message">Идёт проверка цен. Предложения можно утвердить после её завершения.</div>}
    {loading && <p className="pa-message">Загружаем цены…</p>}
    {error && <div className="pa-error" role="alert">{error}</div>}
    {notice && <div className="pa-message" role="status">{notice}</div>}

    <nav className="pa-tabs" aria-label="Разделы мониторинга">
      <button className={view === 'offers' ? 'active' : ''} onClick={() => setView('offers')}>Предложения ({preview?.count ?? 0})</button>
      <button className={view === 'all' ? 'active' : ''} onClick={() => setView('all')}>Все товары из 1С</button>
      <button className={view === 'issues' ? 'active' : ''} onClick={() => setView('issues')}>Нужна проверка</button>
    </nav>
    <div className="pa-browser">
      <nav className="pa-crumbs" aria-label="Категории из 1С">
        <button onClick={() => setPath('')}>Все категории</button>
        {path.split(' / ').filter(Boolean).map((level, i, levels) => <span key={i}>
          <span> / </span><button onClick={() => setPath(levels.slice(0, i + 1).join(' / '))}>{level}</button>
        </span>)}
      </nav>
      {children.length > 0 && <div className="pa-folders">
        {children.map(([name, count]) => {
          const folder = path ? path + ' / ' + name : name
          return <button key={folder} onClick={() => { setPath(folder); setLimit(60) }}>
            <span>▸ {name}</span><small>{count} товаров</small>
          </button>
        })}
      </div>}
      <input className="pa-search" aria-label="Поиск по товарам" value={search}
        onChange={e => setSearch(e.target.value)} placeholder="Найти товар по названию или артикулу"/>

      {view === 'offers' && <div className="pa-offers">
        {preview && preview.skipped > 0 && <p className="pa-muted">Не все товары подходят для автоматического предложения: {preview.skipped} пропущено (нет свежей проверенной цены, закупки, достаточной маржи или есть ограничения).</p>}
        {groupedOffers.map(([category, rows]) => <div className="pa-group" key={category}>
          <h3>{category} <span>{rows.length}</span></h3>
          {rows.map(item => <label className="pa-offer" key={item.id}>
            <input type="checkbox" checked={selected.includes(item.id)} disabled={Boolean(busy) || Boolean(running)}
              onChange={e => setSelected(all => e.target.checked ? [...all, item.id] : all.filter(id => id !== item.id))}/>
            <div className="pa-offer-body">
              <strong>{item.productName}</strong>
              <div className="pa-prices">
                <span>Сейчас <b>{rub(item.oldPrice)}</b></span>
                <span>Конкурент <b>{rub(item.competitorPrice)}</b></span>
                <span>Предложение <b>{rub(item.newPrice)}</b></span>
              </div>
              <small>Маржа: {item.marginPercent ?? '—'}% · Проверено: {dateLabel(item.lastSuccessAt)}</small>
            </div>
          </label>)}
        </div>)}
        {shownProposals === 0 && !loading && <div className="pa-empty">Нет предложений, готовых к утверждению. Проверьте свежесть цен и привязки в разделе «Для специалиста».</div>}
        {shownProposals > 0 && <div className="pa-approval">
          <span>Выбрано: <b>{selectedVisible.length}</b> из {shownProposals}</span>
          <div className="pa-approval-buttons">
            <button className="pa-action pa-secondary" disabled={!selectedVisible.length || Boolean(busy) || Boolean(running)}
              onClick={() => void decide('reject')}>Не менять выбранные</button>
            <button className="pa-action pa-primary" disabled={!selectedVisible.length || Boolean(busy) || Boolean(running)}
              onClick={() => void decide('apply')}>Применить выбранные</button>
          </div>
        </div>}
        <p className="pa-muted">После утверждения сайт обновит цену и отправит её в очередь 1С. Окончательное подтверждение появится после проведения документа в 1С.</p>
      </div>}

      {view === 'all' && <div className="pa-list">
        {current.slice(0, limit).map(product => {
          const match = linked.get(product.id)
          return <article key={product.id}>
            <div><strong>{product.name}</strong><small>{product.category.name}</small></div>
            <div><span>Наша цена: <b>{rub(product.price)}</b></span><span>05.ru: <b>{match && fresh(match) && match.latestPrice ? rub(match.latestPrice) : 'Нет свежей цены'}</b></span><small>{statusFor(product)}</small></div>
          </article>
        })}
        {current.length > limit && <button className="pa-action pa-secondary" onClick={() => setLimit(x => x + 60)}>Показать ещё ({current.length - limit})</button>}
        {!current.length && <p className="pa-empty">В этой категории нет товаров из 1С.</p>}
      </div>}
      {view === 'issues' && <div className="pa-list">
        <p className="pa-muted">Здесь товары, подключённые к обмену с 1С, для которых нет свежей подтверждённой цены конкурента.</p>
        {issues.slice(0, limit).map(product => <article key={product.id}>
          <div><strong>{product.name}</strong><small>{product.category.name}</small></div>
          <span>Нужна проверка привязки или цены 05.ru</span>
        </article>)}
        {issues.length > limit && <button className="pa-action pa-secondary" onClick={() => setLimit(x => x + 60)}>Показать ещё</button>}
        {!issues.length && <p className="pa-empty">Нет товаров с ошибкой привязки в выбранной категории.</p>}
      </div>}
    </div>

    <details className="pa-specialist">
      <summary>Настройки и инструменты специалиста</summary>
      <label className="pa-schedule-toggle">
        <input type="checkbox" checked={interval > 0} disabled={Boolean(busy)}
          onChange={e => void toggleSchedule(e.target.checked)}/>
        Проверять сохранённые ссылки автоматически в 06:00 (МСК)
      </label>
      <p>Автоматическая проверка работает только при запущенном сервере TEXHORU. Меняет только результаты мониторинга, не цены товаров.</p>
      <button className="pa-action pa-secondary" onClick={() => setAdvanced(value => !value)}>
        {advanced ? 'Скрыть привязки и диагностику' : 'Открыть привязки товаров и диагностику'}
      </button>
      {advanced && <PriceMonitorPanel products={inventory} onCatalogImported={onCatalogImported}/>}
    </details>
  </section>
}
