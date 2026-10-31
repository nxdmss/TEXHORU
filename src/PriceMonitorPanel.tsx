import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ApiProduct, type MatchCandidate, type MonitorJob, type PriceMonitorItem } from './api'
import './price-monitor-simple.css'

const rub = (n: number) => new Intl.NumberFormat('ru-RU').format(n) + ' ₽'
const prettyDate = (s?: string | null) => s ? new Date(s).toLocaleString('ru-RU') : '—'
const pathSegments = (value: string) => value.split(' / ').map(s => s.trim()).filter(Boolean)
const inPath = (category: string, path: string) => !path || category === path || category.startsWith(path + ' / ')
const cleanName = (name: string) => name.replace(/^Фотография товара\s*/i, '').trim()

function childrenAt(products: ApiProduct[], path: string) {
  const folders = new Map<string, number>()
  for (const product of products) {
    const category = product.category?.name || ''
    if (!inPath(category, path) || category === path) continue
    const rest = path ? category.slice(path.length + 3) : category
    const next = rest.split(' / ')[0]
    if (!next) continue
    folders.set(next, (folders.get(next) || 0) + 1)
  }
  return [...folders].sort((a, b) => a[0].localeCompare(b[0], 'ru'))
}

const isFresh = (item: PriceMonitorItem) => Boolean(
  item.lastSuccessAt && !item.lastError && item.priceSource !== 'USER_FILE'
  && Date.now() - new Date(item.lastSuccessAt).getTime() >= 0
  && Date.now() - new Date(item.lastSuccessAt).getTime() <= 24 * 3600_000
)

export function PriceMonitorPanel({ products, onCatalogImported }: {
  products: ApiProduct[]
  onCatalogImported: () => Promise<void>
}) {
  const [stock, setStock] = useState<ApiProduct[]>(products)
  const [items, setItems] = useState<PriceMonitorItem[]>([])
  const [jobs, setJobs] = useState<MonitorJob[]>([])
  const [path, setPath] = useState('')
  const [search, setSearch] = useState('')
  const [opened, setOpened] = useState<string | null>(null)
  const [matches, setMatches] = useState<MatchCandidate[]>([])
  const [selected, setSelected] = useState('')
  const [history, setHistory] = useState<Array<{ id: string; price: number; checkedAt: string }>>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [manualUrl, setManualUrl] = useState('')
  const [linkingProduct, setLinkingProduct] = useState<number | null>(null)
  const [linkUrl, setLinkUrl] = useState('')
  const polling = useRef(false)
  const loadingMatch = useRef(0)
  const [matchLoading, setMatchLoading] = useState(false)

  useEffect(() => { setStock(products) }, [products])
  const refresh = useCallback(async (includeProducts = false) => {
    const [list, tasks, inventory] = await Promise.all([
      api.adminPriceMonitor(), api.monitorJobs(),
      includeProducts ? api.adminProducts() : Promise.resolve(null),
    ])
    setItems(list); setJobs(tasks)
    if (inventory) setStock(inventory)
  }, [])
  useEffect(() => {
    let mounted = true
    void refresh(true).catch(e => { if (mounted) setError(e.message) })
    let ticks = 0
    const timer = window.setInterval(() => {
      if (polling.current) return
      polling.current = true
      void refresh(++ticks % 3 === 0).catch(e => { if (mounted) setError(e.message) })
        .finally(() => { polling.current = false })
    }, 7000)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [refresh])

  async function run(key: string, action: () => Promise<unknown>, done?: string) {
    setBusy(key); setError(''); setNotice('')
    try {
      await action()
      await refresh(true)
      if (done) setNotice(done)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка операции')
      await refresh().catch(() => undefined)
    } finally { setBusy('') }
  }

  const phones = useMemo(() => stock.filter(product =>
    Boolean(product.oneCId) && product.status === 'ACTIVE'
    && product.price > 0
  ), [stock])
  const scopedPhones = useMemo(() => phones.filter(product =>
    inPath(product.category?.name || '', path)
  ), [phones, path])
  const folders = useMemo(() => childrenAt(phones, path), [phones, path])
  const visiblePhones = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('ru')
    return phones.filter(product => (
      q ? inPath(product.category?.name || '', path) && (product.name + ' ' + product.sku + ' ' + product.category?.name).toLocaleLowerCase('ru').includes(q)
        : inPath(product.category?.name || '', path)
    )).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }, [phones, path, search])
  const byProduct = useMemo(() => {
    const grouped = new Map<number, PriceMonitorItem[]>()
    for (const item of items) {
      if (!item.product?.id) continue
      const current = grouped.get(item.product.id) || []
      current.push(item)
      grouped.set(item.product.id, current)
    }
    for (const group of grouped.values()) group.sort((a, b) => {
      const score = (x: PriceMonitorItem) =>
        (x.matchStatus === 'CONFIRMED' ? 1000 : 0) +
        (isFresh(x) ? 100 : 0) + (x.lastSuccessAt ? new Date(x.lastSuccessAt).getTime() / 1e13 : 0)
      return score(b) - score(a)
    })
    return grouped
  }, [items])
  const confirmed = phones.filter(p => byProduct.get(p.id)?.some(i => i.matchStatus === 'CONFIRMED')).length
  const unlinkedInScope = scopedPhones.filter(p => !byProduct.get(p.id)?.some(i => i.matchStatus === 'CONFIRMED')).length
  // Prefer the job the worker is actually executing over a newer queued job.
  const active = jobs.find(j => j.status === 'RUNNING')
    ?? jobs.find(j => j.kind === 'INDEX_05RU' && j.status === 'QUEUED')
    ?? jobs.find(j => j.status === 'QUEUED')
  const last = jobs.find(j => j.kind === 'MATCH_1C')
  const lastRecheck = jobs.find(j => j.kind === 'RECHECK')
  const unlinked = items.filter(i => !i.product?.oneCId || !phones.some(p => p.id === i.product?.id))
  const level = pathSegments(path)
  // Searching filters tiles only; never widen a price-changing scope silently.
  const displayPath = path
  const scopeCount = scopedPhones.length

  async function searchMatches() {
    if (active) { setError('Дождись завершения предыдущей проверки'); return }
    await run('match', async () => {
      const number = Math.min(5000, unlinkedInScope)
      if (!number) throw new Error('Все товары уже привязаны. Обновляй цены одной кнопкой.')
      const useCatalogIndex = number >= 100
      const onlyInStockSmartphones = /(?:смартфон|smartphone)/i.test(displayPath)
      const job = await api.monitorAutoFindOneC(displayPath, number, useCatalogIndex, onlyInStockSmartphones, true)
      setNotice(useCatalogIndex
        ? 'Запущена сборка публичного каталога 05.ru. После индексации TEXHORU сопоставит товары 1С и проверит цены в карточках.'
        : 'Поиск ' + job.queued + ' товаров запущен. Результаты появятся в карточках.')
    })
  }

  async function refreshSavedPrices() {
    if (active) { setError('Сначала заверши текущую проверку'); return }
    await run('refresh', () => api.monitorCheckAll(),
      'Проверка запущена. Цены 05.ru обновляются по сохранённым ссылкам; цены товаров TEXHORU не меняются.')
  }

  async function bindManually(product: ApiProduct) {
    if (!linkUrl.trim()) { setError('Вставь ссылку на карточку товара 05.ru'); return }
    await run('bind', async () => {
      const link = await api.adminCheckCompetitorPrice({ url: linkUrl.trim(), productId: product.id })
      if (link.matchStatus !== 'CONFIRMED' || link.product?.id !== product.id) {
        await api.monitorConfirm(link.id, product.id)
      }
      setLinkingProduct(null)
      setLinkUrl('')
    }, 'Карточка привязана. При следующих проверках поиск не потребуется.')
  }

  async function updateAllPrices() {
    if (active) { setError('Сначала заверши поиск и проверку цен'); return }
    setBusy('preview'); setError(''); setNotice('')
    try {
      const preview = await api.monitorBulkPreview(displayPath)
      if (!preview.count) {
        setNotice('Нет цен для обновления: нужны свежие проверки 05.ru и точные подтверждённые совпадения.')
        return
      }
      const text = [
        'ПРИМЕНИТЬ ЦЕНЫ НА САЙТЕ TEXHORU?',
        '',
        'Товаров: ' + preview.count,
        'Пропущено: ' + preview.skipped,
        'Правило: на 500 ₽ ниже подтверждённой цены 05.ru.',
        'Только цены, проверенные за последние 24 часа.',
        preview.unknownCost ? 'Без известной себестоимости: ' + preview.unknownCost : '',
        preview.largeChanges ? 'Изменение цены более 10%: ' + preview.largeChanges : '',
        preview.oneCQueued ? 'Очередь обмена с 1С получит изменения по ' + preview.oneCQueued + ' товарам.' : 'В 1С цены не изменятся.',
        '',
        'Ошибочные, старые и спорные совпадения не применяются.',
        'Подтвердить?',
      ].filter(Boolean).join('\n')
      if (!window.confirm(text)) return
      const result = await api.monitorBulkApply({
        categoryPath: displayPath, token: preview.token,
        acceptUnknownCost: preview.unknownCost > 0, acceptLargeChange: preview.largeChanges > 0,
      })
      await onCatalogImported()
      await refresh(true)
      setNotice('Обновлено цен: ' + result.applied + '. Пропущено: ' + result.skipped + '.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось применить цены')
    } finally { setBusy('') }
  }

  async function expand(item: PriceMonitorItem) {
    const call = ++loadingMatch.current
    if (opened === item.id) { setOpened(null); return }
    setOpened(item.id); setSelected(item.product ? String(item.product.id) : '')
    setMatchLoading(true); setMatches([]); setHistory([])
    try {
      const [candidates, history] = await Promise.all([
        api.monitorCandidates(item.id), api.monitorHistory(item.id),
      ])
      if (loadingMatch.current !== call) return
      setMatches(candidates); setHistory(history)
      if (!item.product && candidates.length) setSelected(String(candidates[0].product.id))
    } catch (e) {
      if (loadingMatch.current === call) setError(e instanceof Error ? e.message : 'Не удалось получить совпадения')
    } finally { if (loadingMatch.current === call) setMatchLoading(false) }
  }

  async function confirm(item: PriceMonitorItem) {
    if (!selected) { setError('Выбери правильный товар'); return }
    await run('confirm', async () => {
      if (!isFresh(item)) await api.adminCheckCompetitorPrice({ url: item.externalUrl })
      await api.monitorConfirm(item.id, Number(selected))
    }, 'Совпадение подтверждено. Цена твоего товара не изменена.')
  }

  function itemStatus(item?: PriceMonitorItem) {
    if (!item) return { label: 'Нет связи', className: 'missing' }
    if (item.matchStatus === 'CONFIRMED' && isFresh(item)) return { label: 'Совпало', className: 'ready' }
    if (item.matchStatus === 'CONFIRMED') return { label: item.lastError ? 'Ошибка проверки' : 'Привязано', className: 'pending' }
    if (item.matchStatus === 'SUGGESTED' || item.matchStatus === 'REVIEW_REQUIRED') return { label: 'Проверить', className: 'pending' }
    return { label: 'Без связи', className: 'missing' }
  }

  function renderPhone(p: ApiProduct) {
    const linked = byProduct.get(p.id)?.[0]
    const state = itemStatus(linked)
    return <article className="mp-tile" key={p.id}>
      <div className="mp-tile-head">
        <span className={'mp-pill ' + state.className}>{state.label}</span>
        <small>{p.stockQty - (p.reservedQty || 0)} шт. · 1С</small>
      </div>
      <strong className="mp-product-name">{p.name}</strong>
      <div className="mp-prices">
        <div><small>Наш сайт</small><b>{rub(p.price)}</b></div>
        <div><small>05.ru</small><b>{linked?.latestPrice && isFresh(linked) ? rub(linked.latestPrice) : '—'}</b></div>
      </div>
      {linked
        ? <button className="mp-tile-button" disabled={Boolean(busy)} onClick={() => void expand(linked)}>
            {opened === linked.id ? 'Скрыть детали' : linked.matchStatus === 'CONFIRMED' ? 'Детали' : 'Проверить'}
          </button>
        : <span className="mp-no-match">Совпадение ещё не найдено</span>}
      {linked?.matchStatus !== 'CONFIRMED' && <>
        <button className="mp-tile-button" disabled={Boolean(busy) || Boolean(active)}
          onClick={() => { setLinkingProduct(linkingProduct === p.id ? null : p.id); setLinkUrl('') }}>
          {linkingProduct === p.id ? 'Отменить' : 'Привязать по ссылке'}
        </button>
        {linkingProduct === p.id && <div className="mp-expanded">
          <label>Ссылка на точную карточку 05.ru
            <input aria-label={'Ссылка 05.ru для ' + p.name} value={linkUrl}
              onChange={e => setLinkUrl(e.target.value)} placeholder="https://05.ru/cat/…/p/…"/>
          </label>
          <button disabled={Boolean(busy) || Boolean(active) || !linkUrl.trim()}
            onClick={() => void bindManually(p)}>Проверить и сохранить связь</button>
        </div>}
      </>}
      {linked && opened === linked.id && <div className="mp-expanded">
        <p><a href={linked.externalUrl} target="_blank" rel="noreferrer">Карточка 05.ru ↗</a> · {prettyDate(linked.lastSuccessAt)}</p>
        {linked.lastError && <p className="form-error">{linked.lastError}</p>}
        {matchLoading ? <p>Проверяем варианты…</p> : <>
          {linked.matchStatus !== 'CONFIRMED' && <>
            <label>Выбери соответствие
              <select value={selected} onChange={e => setSelected(e.target.value)}>
                <option value="">Выбрать товар</option>
                {matches.map(c => <option key={c.product.id} value={c.product.id}>{c.product.name}</option>)}
              </select>
            </label>
            <button disabled={Boolean(busy) || !selected || Boolean(active)}
              onClick={() => void confirm(linked)}>Подтвердить совпадение</button>
          </>}
          <button className="mp-link-button" disabled={Boolean(busy) || Boolean(active)}
            onClick={() => void run('check', () => api.adminCheckCompetitorPrice({ url: linked.externalUrl }), 'Цена 05.ru обновлена.')}>Проверить цену сейчас</button>
          {linked.matchStatus === 'CONFIRMED' && <button disabled={Boolean(busy) || Boolean(active)}
            onClick={() => {
              if (window.confirm('Снять подтверждённую привязку к 05.ru? Цена товара не изменится.')) {
                void run('unmatch', () => api.monitorUnmatch(linked.id), 'Привязка снята. Можно указать другую ссылку.')
              }
            }}>Снять привязку</button>}
          <details><summary>История цен</summary>
            {history.slice(0, 6).map(row => <p key={row.id}>{prettyDate(row.checkedAt)} · {rub(row.price)}</p>)}
          </details>
        </>}
      </div>}
    </article>
  }

  return <div className="mp-shell">
    <header className="mp-top">
      <div><h2>Мониторинг цен</h2><p>Сравнение с 05.ru</p></div>
      <div className="mp-top-count"><b>{phones.length}</b><span>из 1С с ценой</span></div>
    </header>

    <div className="mp-summary">
      <span><b>{confirmed}</b> совпадений</span>
      <span><b>{phones.filter(p => byProduct.get(p.id)?.some(isFresh)).length}</b> свежих цен</span>
      <span><b>{phones.length - confirmed}</b> без подтверждения</span>
    </div>

    <div className="mp-toolbar">
      <button className="mp-primary" disabled={Boolean(busy) || Boolean(active) || !confirmed}
        onClick={() => void refreshSavedPrices()}>{busy === 'refresh' ? 'Запуск…' : 'Обновить цены 05.ru'}</button>
      <button disabled={Boolean(busy) || Boolean(active) || !unlinkedInScope}
        onClick={() => void searchMatches()}>{busy === 'match' ? 'Запуск…' : 'Найти непривязанные (' + unlinkedInScope + ')'}</button>
      <input aria-label="Поиск товара" placeholder="Поиск по товару…" value={search} onChange={e => setSearch(e.target.value)}/>
    </div>
    <p className="mp-helper">Обновление читает только сохранённые ссылки, без повторного поиска. Цены на сайте и в 1С не меняются автоматически.</p>
    {active && <div className="mp-progress" role="status">
      <span>{active.kind === 'INDEX_05RU'
        ? 'Сбор каталога 05.ru · страница ' + active.page + ' / ' + active.maxPages + ' · карточек ' + active.processed
        : (active.kind === 'MATCH_1C' ? 'Поиск совпадений' : active.kind === 'RECHECK' ? 'Обновление сохранённых цен' : 'Проверка 05.ru') + ' · ' + active.processed + ' / ' + (active.perPage || '…')}</span>
      <button disabled={Boolean(busy)} onClick={() => void run('stop', () => api.monitorJobAction(active.id, 'cancel'))}>Остановить</button>
      <progress aria-label="Ход проверки" max={Math.max(1, active.kind === 'INDEX_05RU' ? active.maxPages : (active.perPage || active.processed || 1))}
        value={active.kind === 'INDEX_05RU' ? active.page : active.processed} />
    </div>}
    {lastRecheck && !active && <div className="mp-last">
      Последнее обновление цен: {lastRecheck.processed} / {lastRecheck.perPage || lastRecheck.processed} · ошибок: {lastRecheck.errors}
      {lastRecheck.status === 'FAILED' && <>
        {' · остановлено из-за ошибки доступа. '}
        <button disabled={Boolean(busy)} onClick={() => void run('retry', () => api.monitorJobAction(lastRecheck.id, 'retry'),
          'Проверка продолжена с оставшихся ссылок.')}>Продолжить обновление</button>
      </>}
      {lastRecheck.lastError && <details><summary>Ошибки проверки</summary><p>{lastRecheck.lastError}</p></details>}
    </div>}
    {last && !active && <div className="mp-last">
      Последний поиск: {last.processed} / {last.perPage || last.processed} · тех. ошибок: {last.errors}
      {last.lastError && <details><summary>Диагностика поиска</summary><p>{last.lastError}</p></details>}
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="price-monitor__notice" role="status">{notice}</p>}

    <section className="mp-browser">
      <nav className="mp-breadcrumbs" aria-label="Категории 1С">
        <button onClick={() => { setPath(''); setSearch(''); setOpened(null) }}>Все товары</button>
        {level.map((segment, index) =>
          <span key={level.slice(0, index + 1).join('/')}>
            <span aria-hidden="true">/</span>
            <button onClick={() => { setPath(level.slice(0, index + 1).join(' / ')); setSearch(''); setOpened(null) }}>{segment}</button>
          </span>
        )}
      </nav>
      {!search && folders.length > 0 && <div className="mp-folder-grid">
        {folders.map(([name, count]) => {
          const child = path ? path + ' / ' + name : name
          return <button className="mp-folder" key={child} onClick={() => { setPath(child); setOpened(null) }}>
            <b>{name}</b>
            <small>{count} товаров</small>
            <span className="mp-folder-arrow" aria-hidden="true">›</span>
          </button>
        })}
      </div>}
      {visiblePhones.length > 0 && <>
        <div className="mp-group-title"><h3>Товары</h3><span>{visiblePhones.length}</span></div>
        <div className="mp-card-grid">{visiblePhones.map(renderPhone)}</div>
      </>}
      {!visiblePhones.length && !folders.length &&
        <p className="mp-empty">{phones.length ? 'В этом разделе нет товаров в наличии.' : 'Ожидаем товары из 1С. Они появятся здесь после следующего обмена.'}</p>}
    </section>

    {unlinked.length > 0 && <details className="mp-extra"><summary>Не разобрано: {unlinked.length} карточек 05.ru</summary>
      <div className="mp-extra-grid">{unlinked.map(item => <div key={item.id} className="mp-extra-card">
        <b>{cleanName(item.externalName || 'Без названия')}</b>
        <p>{item.latestPrice ? rub(item.latestPrice) : 'Цена неизвестна'} · {item.matchStatus === 'CONFIRMED' ? 'связано' : 'не сопоставлено'}</p>
        <button onClick={() => void expand(item)}>{opened === item.id ? 'Скрыть' : 'Сопоставить'}</button>
        {opened === item.id && <div className="mp-expanded">
          {matchLoading ? 'Загрузка…' : <>
            <select value={selected} onChange={e => setSelected(e.target.value)}>
              <option value="">Выбери товар из 1С</option>
              {matches.map(c => <option key={c.product.id} value={c.product.id}>{c.product.name}</option>)}
            </select>
            <button disabled={!selected || Boolean(busy) || Boolean(active)} onClick={() => void confirm(item)}>Подтвердить</button>
          </>}
        </div>}
      </div>)}</div>
    </details>}

    <details className="mp-extra" open={advanced} onToggle={e => setAdvanced(e.currentTarget.open)}>
      <summary>Дополнительно</summary>
      <p>Товары поступают автоматически при настроенном обмене 1С → TEXHORU. Импорт файлов для ежедневного мониторинга не нужен.</p>
      <div className="mp-advanced">
        <button disabled={Boolean(busy) || Boolean(active) || !phones.length}
          onClick={() => void updateAllPrices()}>{busy === 'preview' ? 'Проверяем…' : 'Применить цены к товарам TEXHORU'}</button>
        <label>Проверить одну ссылку 05.ru
          <input value={manualUrl} onChange={e => setManualUrl(e.target.value)} placeholder="https://05.ru/cat/…/p/…"/>
        </label>
        <button disabled={Boolean(busy) || Boolean(active) || !manualUrl.trim()}
          onClick={() => void run('manual', () => api.adminCheckCompetitorPrice({ url: manualUrl }), 'Карточка проверена.')}>Проверить</button>
      </div>
    </details>
  </div>
}
