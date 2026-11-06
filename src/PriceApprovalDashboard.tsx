import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ApiProduct, type MonitorJob, type OneCPriceSyncStatus, type PriceApprovalPreview } from './api'
import { PriceMonitorPanel } from './PriceMonitorPanel'
import './price-approval.css'

const rub = (value: number) => new Intl.NumberFormat('ru-RU').format(value) + ' ₽'
const dateLabel = (value: string | null | undefined) => value ? new Date(value).toLocaleString('ru-RU') : '—'
const inside = (category: string, path: string) => !path || category === path || category.startsWith(path + ' / ')

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
  const [jobs, setJobs] = useState<MonitorJob[]>([])
  const [exchange, setExchange] = useState<OneCPriceSyncStatus>({ scope: [], changes: [] })
  const [interval, setInterval] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [path, setPath] = useState('')
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'ALL' | 'READY' | 'BLOCKED'>('ALL')
  const [selected, setSelected] = useState<string[]>([])
  const lastToken = useRef<string | null>(null)
  const polling = useRef(false)

  useEffect(() => setInventory(products), [products])

  const load = useCallback(async (includeProducts = false) => {
    const [proposal, tasks, sync, settings, stock] = await Promise.all([
      api.monitorBulkPreview(''), api.monitorJobs(), api.priceSyncStatus(),
      api.monitorSettings('05ru'), includeProducts ? api.adminProducts() : Promise.resolve(null),
    ])
    if (proposal.token !== lastToken.current) {
      lastToken.current = proposal.token
      setSelected([])
    }
    setPreview(proposal)
    setJobs(tasks)
    setExchange(sync)
    setInterval(settings.intervalMinutes)
    if (stock) setInventory(stock)
    setLoading(false)
  }, [])

  useEffect(() => {
    let active = true
    void load(true).catch(e => {
      if (active) {
        setError(e instanceof Error ? e.message : 'Не удалось загрузить цены')
        setLoading(false)
      }
    })
    const timer = window.setInterval(() => {
      if (polling.current || busy) return
      polling.current = true
      void load().catch(() => undefined).finally(() => { polling.current = false })
    }, 30000)
    return () => { active = false; window.clearInterval(timer) }
  }, [load, busy])

  // A new filter starts a fresh, explicit selection.
  useEffect(() => setSelected([]), [path, search, view])

  const allOneC = useMemo(() => inventory.filter(product =>
    !!product.oneCId && product.status === 'ACTIVE'), [inventory])
  const children = useMemo(() => childCategories(allOneC, path), [allOneC, path])
  const offers = useMemo(() => (preview?.items || []).filter(item =>
    inside(item.categoryPath, path)
    && (!search.trim() || item.productName.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')))),
  [preview, path, search])
  const visibleOffers = useMemo(() => offers.filter(item =>
    view === 'ALL' || (view === 'READY' ? item.canSend : !item.canSend)), [offers, view])
  const selectableOffers = useMemo(() => visibleOffers.filter(item => item.canSend), [visibleOffers])
  const groupedOffers = useMemo(() => {
    const categories = new Map<string, typeof visibleOffers>()
    for (const item of visibleOffers) categories.set(item.categoryPath, [...(categories.get(item.categoryPath) || []), item])
    return [...categories].sort(([a], [b]) => a.localeCompare(b, 'ru'))
  }, [visibleOffers])

  const running = jobs.find(job => job.status === 'QUEUED' || job.status === 'RUNNING')
  const selectedVisible = selected.filter(id => selectableOffers.some(item => item.id === id))
  const allVisibleSelected = selectableOffers.length > 0 && selectedVisible.length === selectableOffers.length
  const pending = exchange.changes.filter(change => change.status === 'PENDING').length
  const failed = exchange.changes.filter(change => change.status === 'CONFLICT' || change.status === 'FAILED').length
  const totalChanges = preview?.items.length ?? 0
  const readyChanges = preview?.items.filter(item => item.canSend).length ?? 0
  const blockedChanges = totalChanges - readyChanges

  function toggleAll() {
    const visibleIds = selectableOffers.map(item => item.id)
    if (allVisibleSelected) {
      setSelected(current => current.filter(id => !visibleIds.includes(id)))
    } else {
      setSelected(current => [...new Set([...current, ...visibleIds])])
    }
  }

  async function checkNow() {
    if (running) return
    setBusy('checking')
    setError('')
    setNotice('')
    try {
      await api.monitorCheckAll('05ru')
      setNotice('Проверка запущена')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось начать проверку')
    } finally {
      setBusy('')
    }
  }

  async function sendSelected() {
    if (!preview || !selectedVisible.length || running) return
    const chosen = selectableOffers.filter(item => selectedVisible.includes(item.id))
    if (!window.confirm('Отправить выбранные цены в тестовую 1С для ' + chosen.length + ' товаров?\n\nНа сайте цены изменятся только после подтверждения 1С.')) return
    setBusy('apply')
    setError('')
    setNotice('')
    try {
      const result = await api.monitorBulkApply({
        categoryPath: '', token: preview.token, ids: chosen.map(item => item.id),
        acceptUnknownCost: false, acceptLargeChange: false,
      })
      setNotice('В очереди 1С: ' + result.oneCQueued + '. Цены на сайте обновятся после подтверждения агента.')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить выбранные цены в 1С')
    } finally {
      setBusy('')
    }
  }

  async function toggleSchedule(enabled: boolean) {
    setBusy('schedule')
    setError('')
    try {
      const settings = await api.monitorSaveSettings(
        '05ru', 'https://05.ru/cat/c/02e38f8a/telefony_i_gadzety/', enabled ? 1440 : 0,
      )
      setInterval(settings.intervalMinutes)
      setNotice(enabled ? 'Автопроверка включена' : 'Автопроверка выключена')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось изменить расписание')
    } finally {
      setBusy('')
    }
  }

  return <section className="pa-root">
    <header className="pa-top">
      <div>
        <h2>Предложения по ценам</h2>
        <p>Проверяем цены на 05.ru и предлагаем цену на 100 ₽ ниже. Решение всегда за тобой.</p>
      </div>
      <button className="pa-action pa-secondary" type="button" onClick={() => void checkNow()} disabled={Boolean(busy) || Boolean(running)}>
        {running || busy === 'checking' ? 'Проверяем…' : 'Проверить цены'}
      </button>
    </header>

    <div className="pa-overview" role="status">
      <div><strong>{totalChanges}</strong><span>Найдено отличий</span></div>
      <div><strong>{readyChanges}</strong><span>Можно отправить</span></div>
      <div><strong>{pending}</strong><span>Ожидают ответа 1С</span></div>
    </div>
    {(blockedChanges > 0 || failed > 0) && <p className="pa-status-note">
      {blockedChanges > 0 && <span>Нужна проверка: {blockedChanges} товаров.</span>}
      {failed > 0 && <span>Ошибки обмена: {failed}. Подробности в разделе «Обмен с 1С».</span>}
    </p>}

    {running && <div className="pa-message">Проверка цен выполняется…</div>}
    {loading && <div className="pa-message">Загрузка…</div>}
    {preview && (preview.diagnostics.unlinkedCount > 0 || preview.diagnostics.uncheckedCount > 0) && <details className="pa-diagnostics">
      <summary>
        Нужна привязка к 05.ru: {preview.diagnostics.unlinkedCount} товаров; не удалось получить цену: {preview.diagnostics.uncheckedCount}
      </summary>
      <p>Новые товары нужно один раз связать с правильными карточками 05.ru.
        Открой «Связи с 05.ru» ниже и выбери «Найти карточки товаров».</p>
      {preview.diagnostics.unlinked.length > 0 && <div>
        <strong>Нет привязки к 05.ru</strong>
        <ul>{preview.diagnostics.unlinked.map(item => <li key={item.productId}>{item.productName}</li>)}</ul>
        {preview.diagnostics.unlinkedCount > preview.diagnostics.unlinked.length &&
          <small>Показаны первые {preview.diagnostics.unlinked.length} товаров из {preview.diagnostics.unlinkedCount}</small>}
      </div>}
      {preview.diagnostics.unchecked.length > 0 && <div>
        <strong>Не получена цена 05.ru</strong>
        <ul>{preview.diagnostics.unchecked.map((item, i) => <li key={item.productId + ':' + i}>
          {item.productName}: {item.reason}
        </li>)}</ul>
      </div>}
    </details>}
    {error && <div className="pa-error" role="alert">{error}</div>}
    {notice && <div className="pa-message" role="status">{notice}</div>}

    <section className="pa-browser" aria-label="Список предложений">
      <div className="pa-browser-head">
        <div>
          <h3>Выбери товары</h3>
          <p>Доступные предложения можно отправить. Остальные видны вместе с причиной.</p>
        </div>
        <div className="pa-tools">
          <input className="pa-search" aria-label="Найти товар" value={search}
            onChange={e => setSearch(e.target.value)} placeholder="Название товара"/>
          <label className="pa-filter">Показать
            <select aria-label="Какие предложения показывать" value={view}
              onChange={e => setView(e.target.value as typeof view)}>
              <option value="ALL">Все</option>
              <option value="READY">Можно отправить</option>
              <option value="BLOCKED">Требуют проверки</option>
            </select>
          </label>
        </div>
      </div>

      {children.length > 0 || path ? <details className="pa-category-filter">
        <summary>{path ? 'Раздел: ' + path.split(' / ').at(-1) : 'Отобрать по разделу'}</summary>
        <nav className="pa-crumbs" aria-label="Категории товаров">
          <button type="button" onClick={() => setPath('')}>Все разделы</button>
          {path.split(' / ').filter(Boolean).map((level, i, levels) => <span key={i}>
            <span aria-hidden="true"> / </span>
            <button type="button" onClick={() => setPath(levels.slice(0, i + 1).join(' / '))}>{level}</button>
          </span>)}
        </nav>
        {children.length > 0 && <div className="pa-folders">
          {children.map(([name, count]) => {
            const folder = path ? path + ' / ' + name : name
            return <button type="button" key={folder} onClick={() => setPath(folder)}>
              <span>{name}</span><small>{count}</small>
            </button>
          })}
        </div>}
      </details> : null}

      {selectableOffers.length > 0 && <label className="pa-select-all">
        <input type="checkbox" checked={allVisibleSelected} disabled={Boolean(busy) || Boolean(running)}
          onChange={toggleAll}/>
        Выбрать все доступные в этом списке ({selectableOffers.length})
      </label>}

      <div className="pa-offers">
        {groupedOffers.map(([category, rows]) => <div className="pa-group" key={category}>
          <h4>{category}</h4>
          {rows.map(item => <label className={item.canSend ? 'pa-offer' : 'pa-offer pa-offer-blocked'} key={item.id}>
            <input type="checkbox" checked={selected.includes(item.id)}
              aria-label={'Выбрать товар: ' + item.productName}
              disabled={!item.canSend || Boolean(busy) || Boolean(running)}
              onChange={e => setSelected(all => e.target.checked ? [...all, item.id] : all.filter(id => id !== item.id))}/>
            <div className="pa-offer-body">
              <div className="pa-offer-title">
                <strong>{item.productName}</strong>
                <span className={item.canSend ? 'pa-state pa-state-ready' : 'pa-state pa-state-issue'}>
                  {item.canSend ? 'Можно отправить' : 'Нужна проверка'}
                </span>
              </div>
              <div className="pa-prices">
                <span>Цена 05.ru <b>{rub(item.competitorPrice)}</b></span>
                <span>Наша цена <b>{item.oldPrice === null ? '—' : rub(item.oldPrice)}</b></span>
                <span className="pa-price-new">Предлагаем <b>{rub(item.newPrice)}</b></span>
              </div>
              {!item.canSend && <p className="pa-blocked-reason">{item.blockedReasons.join('. ')}.</p>}
              <div className="pa-offer-meta">
                Проверено: {dateLabel(item.lastSuccessAt)}
                {item.previousCompetitorPrice !== null && <span> · Раньше на 05.ru: {rub(item.previousCompetitorPrice)}</span>}
                <span> · </span><a className="pa-external-link" href={item.externalUrl}
                  target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>Открыть товар на 05.ru</a>
              </div>
            </div>
          </label>)}
        </div>)}
        {!visibleOffers.length && !loading && <div className="pa-empty">
          {offers.length ? 'В выбранной группе предложений нет. Попробуй «Все».'
            : search || path ? 'Товары по этому запросу не найдены.' : 'Пока нет отличий. Проверь цены или связи с 05.ru.'}
        </div>}
      </div>

      {selectableOffers.length > 0 && <div className="pa-approval">
        <span>Выбрано товаров: <b>{selectedVisible.length}</b></span>
        <button className="pa-action pa-primary" disabled={!selectedVisible.length || Boolean(busy) || Boolean(running)}
          onClick={() => void sendSelected()}>
          {busy === 'apply' ? 'Отправляем…' : 'Отправить выбранные в 1С'}
        </button>
        <small>Цены на сайте изменятся только после ответа 1С.</small>
      </div>}
    </section>

    <details className="pa-specialist">
      <summary>Связи с 05.ru и расписание проверки</summary>
      <label className="pa-schedule-toggle">
        <input type="checkbox" checked={interval === 1440} disabled={Boolean(busy)}
          onChange={e => void toggleSchedule(e.target.checked)}/>
        Автоматически проверять цены каждый день в 06:00 по Москве
      </label>
      <PriceMonitorPanel products={inventory} onCatalogImported={onCatalogImported}/>
    </details>
  </section>
}
