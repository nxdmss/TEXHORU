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

  useEffect(() => setSelected([]), [path, search])

  const allOneC = useMemo(() => inventory.filter(product =>
    !!product.oneCId && product.status === 'ACTIVE'), [inventory])
  const children = useMemo(() => childCategories(allOneC, path), [allOneC, path])
  const offers = useMemo(() => (preview?.items || []).filter(item =>
    inside(item.categoryPath, path)
    && (!search.trim() || item.productName.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')))),
  [preview, path, search])
  const selectableOffers = useMemo(() => offers.filter(item => item.canSend), [offers])
  const groupedOffers = useMemo(() => {
    const categories = new Map<string, typeof offers>()
    for (const item of offers) categories.set(item.categoryPath, [...(categories.get(item.categoryPath) || []), item])
    return [...categories].sort(([a], [b]) => a.localeCompare(b, 'ru'))
  }, [offers])

  const running = jobs.find(job => job.status === 'QUEUED' || job.status === 'RUNNING')
  const selectedVisible = selected.filter(id => selectableOffers.some(item => item.id === id))
  const allVisibleSelected = selectableOffers.length > 0 && selectedVisible.length === selectableOffers.length
  const pending = exchange.changes.filter(change => change.status === 'PENDING').length
  const failed = exchange.changes.filter(change => change.status === 'CONFLICT' || change.status === 'FAILED').length

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
    if (!window.confirm('Отправить новые цены в 1С для ' + chosen.length + ' товаров?\n\nЦены на сайте изменятся только после подтверждения 1С.')) return
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
      <h2>Обновление цен</h2>
      <button className="pa-action pa-secondary" onClick={() => void checkNow()} disabled={Boolean(busy) || Boolean(running)}>
        {running || busy === 'checking' ? 'Проверяем…' : 'Проверить цены'}
      </button>
    </header>

    <div className="pa-overview" role="status">
      <div><strong>{offers.length}</strong><span>Изменений</span></div>
      <div><strong>{selectableOffers.length}</strong><span>Можно отправить</span></div>
      <div><strong>{offers.length - selectableOffers.length}</strong><span>Заблокировано</span></div>
      <div><strong>{selectedVisible.length}</strong><span>Выбрано</span></div>
      <div><strong>{pending}</strong><span>Ожидают 1С</span></div>
      <div><strong>{failed}</strong><span>Ошибки</span></div>
    </div>

    {running && <div className="pa-message">Проверка цен выполняется…</div>}
    {loading && <div className="pa-message">Загрузка…</div>}
    {preview && (preview.diagnostics.unlinkedCount > 0 || preview.diagnostics.uncheckedCount > 0) && <details className="pa-diagnostics">
      <summary>
        Почему нет предложений: {preview.diagnostics.unlinkedCount} товаров без связи с 05.ru,
        {' '}{preview.diagnostics.uncheckedCount} карточек без успешного сканирования
      </summary>
      <p>Без привязки поиск цены не начнётся. Кнопка «Проверить цены» обновляет только подтверждённые ссылки.
        Для новых товаров открой «Настройки и привязки» и запусти поиск совпадений 05.ru.</p>
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

    <div className="pa-browser">
      <nav className="pa-crumbs" aria-label="Категории">
        <button onClick={() => setPath('')}>Все категории</button>
        {path.split(' / ').filter(Boolean).map((level, i, levels) => <span key={i}>
          <span> / </span>
          <button onClick={() => setPath(levels.slice(0, i + 1).join(' / '))}>{level}</button>
        </span>)}
      </nav>

      {children.length > 0 && <div className="pa-folders">
        {children.map(([name, count]) => {
          const folder = path ? path + ' / ' + name : name
          return <button key={folder} onClick={() => setPath(folder)}>
            <span>{name}</span><small>{count}</small>
          </button>
        })}
      </div>}

      <input className="pa-search" aria-label="Поиск по товарам" value={search}
        onChange={e => setSearch(e.target.value)} placeholder="Поиск товара"/>

      {selectableOffers.length > 0 && <label className="pa-select-all">
        <input type="checkbox" checked={allVisibleSelected} disabled={Boolean(busy) || Boolean(running)}
          onChange={toggleAll}/>
        Выбрать все доступные ({selectableOffers.length})
      </label>}

      <div className="pa-offers">
        {groupedOffers.map(([category, rows]) => <div className="pa-group" key={category}>
          <h3>{category}</h3>
          {rows.map(item => <label className={item.canSend ? 'pa-offer' : 'pa-offer pa-offer-blocked'} key={item.id}>
            <input type="checkbox" checked={selected.includes(item.id)}
              disabled={!item.canSend || Boolean(busy) || Boolean(running)}
              onChange={e => setSelected(all => e.target.checked ? [...all, item.id] : all.filter(id => id !== item.id))}/>
            <div className="pa-offer-body">
              <strong>{item.productName}</strong>
              <div className="pa-prices">
                <span>05.ru было <b>{item.previousCompetitorPrice === null ? 'Первый замер' : rub(item.previousCompetitorPrice)}</b></span>
                <span>05.ru сейчас <b>{rub(item.competitorPrice)}</b></span>
                <span>TEXHORU <b>{item.oldPrice === null ? '—' : rub(item.oldPrice)}</b></span>
                <span>Предложение <b>{rub(item.newPrice)}</b></span>
              </div>
              <small>
                {item.costPrice !== null && item.newPrice > 0
                  ? 'Маржа ' + (Math.round((item.newPrice - item.costPrice) / item.newPrice * 1000) / 10) + '% · '
                  : ''}
                Проверено: {dateLabel(item.lastSuccessAt)} · <a className="pa-external-link" href={item.externalUrl}
                  target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>Открыть 05.ru</a>
              </small>
              {!item.canSend && <small className="pa-blocked-reason">Нельзя отправить: {item.blockedReasons.join('; ')}</small>}
              {item.canSend && <small className="pa-ready-reason">Доступно для ручного выбора и отправки в 1С</small>}
            </div>
          </label>)}
        </div>)}
        {!offers.length && !loading && <div className="pa-empty">Нет цен для обновления</div>}
      </div>

      {selectableOffers.length > 0 && <div className="pa-approval">
        <span>Выбрано: <b>{selectedVisible.length}</b></span>
        <button className="pa-action pa-primary" disabled={!selectedVisible.length || Boolean(busy) || Boolean(running)}
          onClick={() => void sendSelected()}>
          {busy === 'apply' ? 'Отправляем…' : 'Обновить выбранные в 1С'}
        </button>
      </div>}
    </div>

    <details className="pa-specialist">
      <summary>Настройки и привязки</summary>
      <label className="pa-schedule-toggle">
        <input type="checkbox" checked={interval === 1440} disabled={Boolean(busy)}
          onChange={e => void toggleSchedule(e.target.checked)}/>
        Проверять цены автоматически каждый день в 06:00
      </label>
      <PriceMonitorPanel products={inventory} onCatalogImported={onCatalogImported}/>
    </details>
  </section>
}
