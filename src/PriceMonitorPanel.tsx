import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ApiProduct, type MatchCandidate, type MonitorJob, type MonitorSource, type PriceMonitorItem, type MatchOutcome } from './api'
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

const MONITOR_CATALOG_URL = 'https://05.ru/cat/c/02e38f8a/telefony_i_gadzety/'

const isFresh = (item: PriceMonitorItem) => Boolean(
  item.lastSuccessAt && !item.lastError && item.priceSource !== 'USER_FILE'
  && Date.now() - new Date(item.lastSuccessAt).getTime() >= 0
  && Date.now() - new Date(item.lastSuccessAt).getTime() <= 24 * 3600_000
)

// Display only official 05.ru product pages, not arbitrary imported URLs.
function officialProductUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || !['05.ru', 'www.05.ru'].includes(url.hostname.toLowerCase())
      || url.username || url.password || (url.port && url.port !== '443')
      || !/^\/cat\/[^/]+\/p\/[^/]+\/?$/.test(url.pathname)) return null
    return url.toString()
  } catch { return null }
}

function SourceEvidence({ item }: { item: PriceMonitorItem }) {
  const link = officialProductUrl(item.externalUrl)
  if (!link) return null
  const fromParser = item.latestPrice != null && item.latestPrice > 0
    && Boolean(item.lastSuccessAt) && item.priceSource !== 'USER_FILE'
  const sourceMethod: Record<string, string> = {
    'JSON-LD Offer': 'данные карточки',
    'product:price:amount': 'метаданные цены',
    'DOM основной карточки': 'цена на странице',
  }
  return <span className="mp-price-proof">
    <a className="mp-source-link" href={link} target="_blank" rel="noopener noreferrer"
      title={'Открыть сохранённую карточку товара на 05.ru: ' + link}
      aria-label={'Проверить цену в источнике 05.ru: ' + item.externalName}>
      Проверить на 05.ru <span aria-hidden="true">↗</span>
    </a>
    {fromParser && <small className="mp-proof-meta">
      Считано: {prettyDate(item.lastSuccessAt)}
      {item.priceSource ? ' · ' + (sourceMethod[item.priceSource] || item.priceSource) : ''}
      {!isFresh(item) ? ' · данные устарели' : ''}
    </small>}
    {item.priceSource === 'USER_FILE' && <small className="mp-proof-warning">
      Цена из файла, не подтверждена сайтом
    </small>}
    {!fromParser && item.priceSource !== 'USER_FILE' && <small className="mp-proof-warning">
      Цена страницы ещё не подтверждена
    </small>}
  </span>
}

export function PriceMonitorPanel({ products, initialPath }: { products: ApiProduct[]; initialPath?: string }) {
  const [stock, setStock] = useState<ApiProduct[]>(products)
  const [onlyAllowed, setOnlyAllowed] = useState(true)
  const [items, setItems] = useState<PriceMonitorItem[]>([])
  const [jobs, setJobs] = useState<MonitorJob[]>([])
  const [outcomes, setOutcomes] = useState<MatchOutcome[]>([])
  const [group, setGroup] = useState<'ALL' | 'CONFIRMED' | 'REVIEW' | 'NO_MATCH' | 'PENDING'>('ALL')
  const [sources, setSources] = useState<MonitorSource[]>([])
  const sourceKey = '05ru' as const
  const [path, setPath] = useState(initialPath || '')
  const [search, setSearch] = useState('')
  const [opened, setOpened] = useState<string | null>(null)
  useEffect(() => { if (initialPath !== undefined) { setPath(initialPath); setSearch(''); setOpened(null) } }, [initialPath])
  const [matches, setMatches] = useState<MatchCandidate[]>([])
  const [selected, setSelected] = useState('')
  const [history, setHistory] = useState<Array<{ id: string; price: number; checkedAt: string }>>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [manualUrl, setManualUrl] = useState('')
  const [linkingProduct, setLinkingProduct] = useState<number | null>(null)
  const [linkUrl, setLinkUrl] = useState('')
  const polling = useRef(false)
  const loadingMatch = useRef(0)
  const [matchLoading, setMatchLoading] = useState(false)
  const [visibleLimit, setVisibleLimit] = useState(80)
  const [showUnlinked, setShowUnlinked] = useState(false)
  const [unlinkedLimit, setUnlinkedLimit] = useState(80)

  useEffect(() => { setStock(products) }, [products])
  useEffect(() => {
    let mounted = true
    void api.monitorSources().then(list => {
      if (mounted) setSources(list.filter(source => source.key === '05ru'))
    }).catch(e => {
      if (mounted) setError(e instanceof Error ? e.message : 'Не удалось загрузить сведения о 05.ru')
    })
    return () => { mounted = false }
  }, [])
  useEffect(() => { setVisibleLimit(80) }, [path, search, group])
  const refresh = useCallback(async (includeProducts = false) => {
    const [list, tasks, decisions, inventory] = await Promise.all([
      api.adminPriceMonitor(), api.monitorJobs(), api.monitorMatchOutcomes(),
      includeProducts ? api.adminProducts() : Promise.resolve(null),
    ])
    setItems(list); setJobs(tasks); setOutcomes(decisions)
    if (inventory) setStock(inventory)
  }, [])
  useEffect(() => {
    let mounted = true
    void refresh(true).catch(e => { if (mounted) setError(e.message) })
    let ticks = 0
    const timer = window.setInterval(() => {
      if (polling.current || document.hidden) return
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

  const sourceName = '05.ru'
  const phones = useMemo(() => stock.filter(product =>
    Boolean(product.oneCId) && product.status === 'ACTIVE'
    && (!onlyAllowed || product.priceSyncEnabled)
    && product.price > 0 && product.stockQty > (product.reservedQty || 0)
  ), [stock, onlyAllowed])
  const scopedPhones = useMemo(() => phones.filter(product =>
    inPath(product.category?.name || '', path)
  ), [phones, path])
  const folders = useMemo(() => childrenAt(phones, path), [phones, path])
  const searchablePhones = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('ru')
    return phones.filter(product => (
      q ? inPath(product.category?.name || '', path) && (product.name + ' ' + product.sku + ' ' + product.category?.name).toLocaleLowerCase('ru').includes(q)
        : inPath(product.category?.name || '', path)
    )).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }, [phones, path, search])
  const byProduct = useMemo(() => {
    const grouped = new Map<number, PriceMonitorItem[]>()
    for (const item of items) {
      if (item.source.key !== sourceKey || !item.product?.id) continue
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
  }, [items, sourceKey])
  const byOutcome = useMemo(() => new Map(outcomes.map(row => [row.productId, row] as const)), [outcomes])
  const matchGroup = (productId: number) => {
    const links = byProduct.get(productId) || []
    if (links.some(item => item.matchStatus === 'CONFIRMED')) return 'CONFIRMED' as const
    if (links.some(item => ['SUGGESTED', 'REVIEW_REQUIRED'].includes(item.matchStatus))) return 'REVIEW' as const
    return byOutcome.get(productId)?.status === 'NO_MATCH' ? 'NO_MATCH' as const : 'PENDING' as const
  }
  const visiblePhones = searchablePhones.filter(product => group === 'ALL' || matchGroup(product.id) === group)
  const confirmed = scopedPhones.filter(p => matchGroup(p.id) === 'CONFIRMED').length
  const needsReview = scopedPhones.filter(p => matchGroup(p.id) === 'REVIEW').length
  const noMatches = scopedPhones.filter(p => matchGroup(p.id) === 'NO_MATCH').length
  const unlinkedInScope = scopedPhones.filter(p => matchGroup(p.id) === 'PENDING').length
  // Mirror worker priority and FIFO order across per-store jobs.
  const oldestQueued = (kind?: string) => jobs
    .filter(job => job.status === 'QUEUED' && (!kind || job.kind === kind))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0]
  const queuedIndex = jobs.filter(job => job.status === 'QUEUED'
    && ['INDEX_05RU_SMARTPHONES', 'INDEX_05RU'].includes(job.kind))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0]
  const active = jobs.find(j => j.status === 'RUNNING')
    ?? queuedIndex
    ?? oldestQueued('MATCH_1C')
    ?? oldestQueued()
  const activeIsIndex = active?.kind === 'INDEX_05RU' || active?.kind === 'INDEX_05RU_SMARTPHONES'
  const activeSourceName = sources.find(item => item.key === active?.sourceKey)?.name || (activeIsIndex ? '05.ru' : sourceName)
  const belongsToSelectedSource = (job: MonitorJob) => job.sourceKey === sourceKey || (sourceKey === '05ru' && !job.sourceKey)
  const last = jobs.find(j => j.kind === 'MATCH_1C' && belongsToSelectedSource(j))
  const lastRecheck = jobs.find(j => j.kind === 'RECHECK' && belongsToSelectedSource(j))
  const unlinked = onlyAllowed ? [] : items.filter(i => i.source.key === sourceKey && (!i.product?.oneCId || !phones.some(p => p.id === i.product?.id)))
  const level = pathSegments(path)
  // Searching filters tiles only; never widen a price-changing scope silently.
  const displayPath = path

  async function searchMatches() {
    if (active) { setError('Дождись завершения предыдущей проверки'); return }
    await run('match', async () => {
      const number = Math.min(5000, scopedPhones.length)
      if (!number) throw new Error('Нет активных товаров из 1С с ценой и остатком.')
      const needsCatalogIndex = number > 40
      const job = await api.monitorAutoFindOneC(displayPath, number, needsCatalogIndex, false, true, '05ru', onlyAllowed)
      setNotice((needsCatalogIndex
        ? '05.ru: общий индекс смартфонов и сопоставление с 1С. '
        : '05.ru: быстрый поиск без полного обхода каталога. ')
        + 'Запущено проверок: ' + job.queued + '.')
    })
  }

  async function retryOneProduct(productId: number) {
    if (active) { setError('Сначала заверши текущую проверку'); return }
    await run('retry-one', () => api.monitorRetryMatch(productId),
      'Отдельный ручной повторный поиск поставлен в очередь. Остальные исключённые товары не затронуты.')
  }

  async function bindManually(product: ApiProduct) {
    if (!linkUrl.trim()) { setError('Вставь ссылку на карточку товара ' + sourceName); return }
    await run('bind', async () => {
      const link = await api.adminCheckCompetitorPrice({ url: linkUrl.trim(), productId: product.id })
      if (link.matchStatus !== 'CONFIRMED' || link.product?.id !== product.id) {
        await api.monitorConfirm(link.id, product.id)
      }
      setLinkingProduct(null)
      setLinkUrl('')
    }, 'Карточка привязана. При следующих проверках поиск не потребуется.')
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

  function itemStatus(item?: PriceMonitorItem, outcome?: MatchOutcome) {
    if (!item && outcome?.status === 'NO_MATCH') return { label: 'Нет совпадений', className: 'missing' }
    if (!item && outcome?.status === 'RETRYABLE') return { label: 'Ошибка поиска', className: 'pending' }
    if (!item) return { label: 'Не проверен', className: 'missing' }
    if (item.matchStatus === 'CONFIRMED' && isFresh(item)) return { label: 'Совпало', className: 'ready' }
    if (item.matchStatus === 'CONFIRMED') return { label: item.lastError ? 'Ошибка проверки' : 'Привязано', className: 'pending' }
    if (item.matchStatus === 'SUGGESTED' || item.matchStatus === 'REVIEW_REQUIRED') return { label: 'Проверить', className: 'pending' }
    return { label: 'Не сопоставлено', className: 'missing' }
  }

  function renderPhone(p: ApiProduct) {
    const linked = byProduct.get(p.id)?.[0]
    const outcome = byOutcome.get(p.id)
    const state = itemStatus(linked, outcome)
    const chosen = opened === linked?.id ? matches.find(m => String(m.product.id) === selected) : undefined
    return <article className="mp-tile" key={p.id}>
      <div className="mp-tile-head">
        <span className={'mp-pill ' + state.className}>{state.label}</span>
        <small>{p.stockQty - (p.reservedQty || 0)} шт. · 1С</small>
      </div>
      <strong className="mp-product-name">{p.name}</strong>
      <div className="mp-prices">
        <div><small>Наш сайт</small><b>{rub(p.price)}</b></div>
        <div className="mp-shop-price">
          <small>{sourceName}</small>
          <b>{linked?.latestPrice && isFresh(linked) ? rub(linked.latestPrice) : '—'}</b>
          {linked && <SourceEvidence item={linked} />}
        </div>
      </div>
      {linked
        ? <button className="mp-tile-button" disabled={Boolean(busy)} onClick={() => void expand(linked)}>
            {opened === linked.id ? 'Скрыть детали' : linked.matchStatus === 'CONFIRMED' ? 'Детали' : 'Проверить'}
          </button>
        : <span className="mp-no-match">{outcome?.status === 'NO_MATCH'
          ? 'Первый поиск завершён без совпадений. Автоматически больше не проверяется.'
          : outcome?.status === 'RETRYABLE'
            ? 'Поиск завершился ошибкой или был неполным. Доступна повторная проверка.'
            : 'Подходящая карточка ' + sourceName + ' пока не найдена'}</span>}
      {!linked && outcome?.status === 'NO_MATCH' && <button
        className="mp-tile-button" disabled={Boolean(busy) || Boolean(active)}
        onClick={() => void retryOneProduct(p.id)}>Повторить поиск вручную</button>}
      {linked?.matchStatus !== 'CONFIRMED' && <>
        <button className="mp-tile-button" disabled={Boolean(busy) || Boolean(active)}
          onClick={() => { setLinkingProduct(linkingProduct === p.id ? null : p.id); setLinkUrl('') }}>
          {linkingProduct === p.id ? 'Отменить' : 'Привязать по ссылке'}
        </button>
        {linkingProduct === p.id && <div className="mp-expanded">
          <label>Ссылка на точную карточку {sourceName}
            <input aria-label={'Ссылка 05.ru для ' + p.name} value={linkUrl}
              onChange={e => setLinkUrl(e.target.value)} placeholder="https://05.ru/cat/…/p/…"/>
          </label>
          <button disabled={Boolean(busy) || Boolean(active) || !linkUrl.trim()}
            onClick={() => void bindManually(p)}>Проверить и сохранить связь</button>
        </div>}
      </>}
      {linked && opened === linked.id && <div className="mp-expanded">
        {linked.matchStatus === 'SUGGESTED' && <p>Предложение для проверки, не подтверждено. Цена 1С не изменится.</p>}
        <p>Карточка {linked.source.name} · последнее чтение: {prettyDate(linked.lastSuccessAt)}{linked.region ? ' · ' + linked.region : ''}. Ссылка для проверки находится рядом с ценой.</p>
        {linked.lastError && <p className="form-error">{linked.lastError}</p>}
        {matchLoading ? <p>Проверяем варианты…</p> : <>
          {linked.matchStatus !== 'CONFIRMED' && <>
            <label>Выбери соответствие
              <select value={selected} onChange={e => setSelected(e.target.value)}>
                <option value="">Выбрать товар</option>
                {matches.map(c => <option key={c.product.id} value={c.product.id}>
                  {c.product.name}{c.conflicts.length ? ' · ПРОВЕРИТЬ: ' + c.conflicts.join(', ') : ''}
                </option>)}
              </select>
            </label>
            {chosen?.reasons?.length ? <p className="mp-match-reasons">Совпало по: {chosen.reasons.join(', ')}</p> : null}
            {chosen?.missing.length ? <p>Не хватает данных: {chosen.missing.join(', ')}. Проверь вручную.</p> : null}
            {chosen?.manualBlockers.length ? <p className="form-error">
              Нельзя подтвердить: {chosen.manualBlockers.join(', ')}. Выбери другую карточку.
            </p> : chosen?.conflicts.length ? <p className="mp-helper">
              Отличия: {chosen.conflicts.join(', ')}. Можно подтвердить вручную, если ты сверил полную карточку магазина. Автоматическая привязка не выполняется.
            </p> : null}
            <button disabled={Boolean(busy) || !selected || Boolean(active) || Boolean(chosen?.manualBlockers.length)}
              onClick={() => void confirm(linked)}>Подтвердить совпадение</button>
          </>}
          <button className="mp-link-button" disabled={Boolean(busy) || Boolean(active)}
            onClick={() => void run('check', () => api.adminCheckCompetitorPrice({ url: linked.externalUrl }), 'Цена магазина обновлена.')}>Проверить цену сейчас</button>
          {linked.product?.id && <button disabled={Boolean(busy) || Boolean(active)}
            onClick={() => {
              const confirmedLink = linked.matchStatus === 'CONFIRMED'
              if (window.confirm(confirmedLink
                ? 'Снять подтверждённую привязку к магазину? Цена товара не изменится.'
                : 'Отклонить этот вариант? Товар снова попадёт в список непривязанных.')) {
                void run('unmatch', () => api.monitorUnmatch(linked.id),
                  confirmedLink ? 'Привязка снята.' : 'Вариант отклонён. Можно запустить новый поиск.')
              }
            }}>{linked.matchStatus === 'CONFIRMED' ? 'Снять привязку' : 'Не тот вариант'}</button>}
          <details><summary>История цен</summary>
            {history.slice(0, 6).map(row => <p key={row.id}>{prettyDate(row.checkedAt)} · {rub(row.price)}</p>)}
          </details>
        </>}
      </div>}
    </article>
  }

  return <div className="mp-shell">
    <div className="mp-scope-switch" aria-label="Область поиска карточек">
      <button type="button" aria-pressed={onlyAllowed} disabled={Boolean(busy) || Boolean(active)} onClick={() => setOnlyAllowed(true)}>Для обмена</button>
      <button type="button" aria-pressed={!onlyAllowed} disabled={Boolean(busy) || Boolean(active)} onClick={() => setOnlyAllowed(false)}>Весь каталог</button>
      <span>{onlyAllowed ? 'Только разрешённые в 1С' : 'Все товары из 1С'}</span>
    </div>
    <header className="mp-top">
      <div><h2>Карточки 05.ru</h2><p>Модель, память, цвет и состояние должны совпадать.</p></div>
      <div className="mp-top-count"><b>{phones.length}</b><span>товаров из 1С</span></div>
    </header>

    <div className="mp-summary">
      <span><b>{confirmed}</b> связаны</span>
      <span><b>{needsReview}</b> требуют проверки</span>
      <span><b>{noMatches}</b> без совпадений</span>
      <span><b>{unlinkedInScope}</b> не проверены</span>
    </div>

    <div className="mp-toolbar">
      <button className="mp-primary" disabled={Boolean(busy) || Boolean(active) || !scopedPhones.length}
        onClick={() => void searchMatches()}>{busy === 'match' ? 'Ищем…' : 'Найти карточки товаров на 05.ru'}</button>
      <input aria-label="Найти товар" placeholder="Название товара…" value={search} onChange={e => setSearch(e.target.value)}/>
    </div>
    <details className="mp-helper"><summary>Как искать быстрее?</summary><p>Открой нужный раздел ниже перед поиском. Поиск связывает карточки и не меняет розничные цены. Для готовых связей используй проверку цен в основной панели.</p></details>
    {active && <div className="mp-progress" role="status">
      <span>{activeIsIndex
        ? (active.kind === 'INDEX_05RU_SMARTPHONES' ? 'Сбор каталога смартфонов 05.ru' : 'Сбор каталога 05.ru')
          + ' · страница ' + active.page + ' / ' + active.maxPages + ' · карточек ' + active.processed
        : (active.kind === 'MATCH_1C' ? 'Локальное сопоставление в ' + activeSourceName : active.kind === 'RECHECK' ? 'Обновление цен ' + activeSourceName : 'Проверка ' + activeSourceName) + ' · ' + active.processed + ' / ' + (active.perPage || '…')}</span>
      <button disabled={Boolean(busy)} onClick={() => void run('stop', () => api.monitorJobAction(active.id, 'cancel'))}>Остановить</button>
      <progress aria-label="Ход проверки" max={Math.max(1, activeIsIndex ? active.maxPages : (active.perPage || active.processed || 1))}
        value={activeIsIndex ? active.page : active.processed} />
    </div>}
    {lastRecheck && !active && <div className="mp-last">
      Последнее обновление цен ({sources.find(item => item.key === lastRecheck.sourceKey)?.name || sourceName}): {lastRecheck.processed} / {lastRecheck.perPage || lastRecheck.processed} · ошибок: {lastRecheck.errors}
      {lastRecheck.status === 'FAILED' && <>
        {' · остановлено из-за ошибки доступа. '}
        <button disabled={Boolean(busy)} onClick={() => void run('retry', () => api.monitorJobAction(lastRecheck.id, 'retry'),
          'Проверка продолжена с оставшихся ссылок.')}>Продолжить обновление</button>
      </>}
      {lastRecheck.lastError && <details><summary>Ошибки проверки</summary><p>{lastRecheck.lastError}</p></details>}
    </div>}
    {last && !active && <div className="mp-last">
      Последний поиск ({sources.find(item => item.key === last.sourceKey)?.name || sourceName}): {last.processed} / {last.perPage || last.processed} · тех. ошибок: {last.errors}
      {last.lastError && <details className="mp-diagnostic"><summary>Диагностика поиска</summary><pre>{last.lastError}</pre></details>}
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="price-monitor__notice" role="status">{notice}</p>}

    <section className="mp-browser">
      <div className="mp-result-filter">
        <label>Показать товары
          <select aria-label="Статус привязки товара" value={group}
            onChange={e => setGroup(e.target.value as typeof group)}>
            <option value="ALL">Все ({scopedPhones.length})</option>
            <option value="CONFIRMED">Связаны ({confirmed})</option>
            <option value="REVIEW">Нужна проверка ({needsReview})</option>
            <option value="NO_MATCH">Нет совпадения ({noMatches})</option>
            <option value="PENDING">Не проверены ({unlinkedInScope})</option>
          </select>
        </label>
      </div>
      <details className="mp-category-filter">
        <summary>{path ? 'Раздел: ' + path.split(' / ').at(-1) : 'Отобрать по разделу товаров'}</summary>
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
      </details>
      {visiblePhones.length > 0 && <>
        <div className="mp-group-title"><h3>Товары</h3><span>{visiblePhones.length}</span></div>
        <div className="mp-card-grid">{visiblePhones.slice(0, visibleLimit).map(renderPhone)}</div>
        {visiblePhones.length > visibleLimit && <button className="mp-more-button"
          onClick={() => setVisibleLimit(n => n + 80)}>Показать ещё 80 из {visiblePhones.length}</button>}
      </>}
      {!visiblePhones.length && !folders.length &&
        <p className="mp-empty">{phones.length ? 'В этом разделе нет товаров в наличии.' : 'Ожидаем товары из 1С. Они появятся здесь после следующего обмена.'}</p>}
    </section>

    {unlinked.length > 0 && <details className="mp-extra" onToggle={e => setShowUnlinked(e.currentTarget.open)}>
      <summary>Не разобрано: {unlinked.length} карточек {sourceName}</summary>
      {showUnlinked && <div className="mp-extra-grid">{unlinked.slice(0, unlinkedLimit).map(item => <div key={item.id} className="mp-extra-card">
        <b>{cleanName(item.externalName || 'Без названия')}</b>
        <p>{item.latestPrice ? rub(item.latestPrice) : 'Цена неизвестна'} · {item.matchStatus === 'CONFIRMED' ? 'связано' : 'не сопоставлено'}</p>
        <SourceEvidence item={item} />
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
      </div>)}
      {unlinked.length > unlinkedLimit && <button className="mp-more-button"
        onClick={() => setUnlinkedLimit(n => n + 80)}>Показать ещё 80 из {unlinked.length}</button>}
      </div>}
    </details>}

    <details className="mp-extra">
      <summary>Проверить одну ссылку вручную</summary>
      <p>Это только проверка карточки 05.ru. Розничную цену она не меняет.</p>
      <div className="mp-advanced">
        <label>Ссылка на карточку 05.ru
          <input value={manualUrl} onChange={e => setManualUrl(e.target.value)}
            placeholder="Вставь ссылку на 05.ru"/>
        </label>
        <button disabled={Boolean(busy) || Boolean(active) || !manualUrl.trim()}
          onClick={() => void run('manual', () => api.adminCheckCompetitorPrice({ url: manualUrl }), 'Карточка проверена.')}>
          Проверить ссылку
        </button>
      </div>
    </details>
  </div>
}
