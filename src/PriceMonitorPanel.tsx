import { CatalogSections } from './CatalogSections'
import { inCatalogSection } from './catalog-groups'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type ApiProduct, type MatchCandidate, type MonitorDelivery, type MonitorJob, type PriceMonitorItem } from './api'

const money = new Intl.NumberFormat('ru-RU')
const status: Record<string, string> = { UNMATCHED: 'Не найден', SUGGESTED: 'Проверь совпадение', CONFIRMED: 'Связь подтверждена', REVIEW_REQUIRED: 'Характеристики изменились', QUEUED: 'В очереди', RUNNING: 'Проверяем', COMPLETED: 'Завершено', FAILED: 'Ошибка', CANCELLED: 'Остановлено', PENDING: 'Ожидает 1С', DELIVERED: 'Сохранено в 1С' }
const labels: Record<string, string> = { brand: 'Бренд', model: 'Модель', storage: 'Память, ГБ', ram: 'ОЗУ, ГБ', color: 'Цвет', sim: 'SIM', gtin: 'GTIN', mpn: 'MPN' }
const date = (value?: string | null) => value ? new Date(value).toLocaleString('ru-RU') : '—'
function friendlyError(message: string) {
  if (/Executable doesn't exist|executable.*does not exist|distribution.*not found/i.test(message)) return 'Браузер парсера не найден. Установи Microsoft Edge, затем перезапусти TEXHORU. Товары и база сохраняются.'
  if (/Характеристики расходятся/.test(message)) return message
  if (/403|429/.test(message)) return '05.ru ограничил запросы. Попробуй проверить одну карточку позже.'
  return message
}
function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url)
}

export function PriceMonitorPanel({ products, onCatalogImported }: { products: ApiProduct[]; onCatalogImported: () => Promise<void> }) {
  const [view, setView] = useState<'prices' | 'add' | 'settings'>('prices')
  const [addMode, setAddMode] = useState<'card' | 'catalog'>('card')
  const [items, setItems] = useState<PriceMonitorItem[]>([])
  const [jobs, setJobs] = useState<MonitorJob[]>([])
  const [deliveries, setDeliveries] = useState<MonitorDelivery[]>([])
  const [url, setUrl] = useState('https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-256-gb-oranzheviy-e-sim-bez-rustore-24007/')
  const [catalog, setCatalog] = useState('https://05.ru/cat/c/02e38f8a/telefony_i_gadzety/')
  const [pages, setPages] = useState(1)
  const [interval, setIntervalMinutes] = useState(0)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [oneCPath, setOneCPath] = useState('')
  const [autoLimit, setAutoLimit] = useState(10)
  const [filter, setFilter] = useState('ALL')
  const [section, setSection] = useState('')
  const [limit, setLimit] = useState(24)
  useEffect(() => { setLimit(24); setOpened(null) }, [section, search, filter])
  const [opened, setOpened] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<MatchCandidate[]>([])
  const [selected, setSelected] = useState('')
  const [history, setHistory] = useState<Array<{ id: string; price: number; inStock: boolean | null; checkedAt: string }>>([])
  const pollBusy = useRef(false)
  const matchRequest = useRef(0)
  const [matchLoading, setMatchLoading] = useState(false)
  const refresh = useCallback(async () => {
    const [rows, tasks, messages] = await Promise.all([api.adminPriceMonitor(), api.monitorJobs(), api.monitorDeliveries()])
    setItems(rows); setJobs(tasks); setDeliveries(messages)
  }, [])
  useEffect(() => {
    let active = true
    void refresh().catch(e => { if (active) setError(e.message) })
    void api.monitorSettings().then(s => { if (active) { setCatalog(s.catalogUrl); setIntervalMinutes(s.intervalMinutes) } }).catch(e => { if (active) setError(e.message) })
    const timer = window.setInterval(() => {
      if (pollBusy.current) return
      pollBusy.current = true
      void refresh().catch(e => { if (active) setError(e.message) }).finally(() => { pollBusy.current = false })
    }, 7000)
    return () => { active = false; window.clearInterval(timer) }
  }, [refresh])
  async function action(key: string, fn: () => Promise<unknown>, message?: string) {
    setBusy(key); setError(''); setNotice('')
    try { await fn(); await refresh(); if (message) setNotice(message) }
    catch (e) { setError(friendlyError(e instanceof Error ? e.message : 'Ошибка')); await refresh().catch(() => undefined) }
    finally { setBusy('') }
  }
  async function openMatch(item: PriceMonitorItem) {
    const request = ++matchRequest.current
    if (opened === item.id) { setOpened(null); setMatchLoading(false); return }
    setOpened(item.id); setError(''); setSelected(products.some(p => p.id === item.product?.id && p.status === 'ACTIVE') ? String(item.product?.id) : ''); setCandidates([]); setHistory([]); setMatchLoading(true)
    try {
      const [possible, past] = await Promise.all([api.monitorCandidates(item.id), api.monitorHistory(item.id)])
      if (matchRequest.current !== request) return
      setCandidates(possible); setHistory(past)
      if (!products.some(p => p.id === item.product?.id && p.status === 'ACTIVE') && possible.length) setSelected(String(possible[0].product.id))
    } catch (e) { if (matchRequest.current === request) setError(friendlyError(e instanceof Error ? e.message : 'Не удалось получить совпадения')) }
    finally { if (matchRequest.current === request) setMatchLoading(false) }
  }
  async function confirmItem(item: PriceMonitorItem) {
    if (!selected) { setError('Выбери свой товар в списке под карточкой.'); return }
    await action('confirm', async () => {
      if (item.lastError || !item.lastSuccessAt) await api.adminCheckCompetitorPrice({ url: item.externalUrl })
      await api.monitorConfirm(item.id, Number(selected))
    }, 'Готово: карточка 05.ru связана с твоим товаром. Цена магазина не изменена.')
  }
  async function applySitePrice(item: PriceMonitorItem) {
    if (item.matchStatus !== 'CONFIRMED' || !item.product || !item.latestPrice || item.latestPrice <= 500
      || item.inStock !== true || item.lastError || !item.lastSuccessAt
      || Date.now() - new Date(item.lastSuccessAt).getTime() > 24 * 3600_000) {
      setError('Подтверди соответствие товара и обнови цену 05.ru перед применением.')
      return
    }
    const next = item.latestPrice - 500
    const old = item.product.price
    const large = Math.abs(next - old) > old * 0.1
    const toOneC = item.product.priceSyncEnabled === true
    const confirmation = [
      toOneC ? 'Изменить цену на сайте и отправить её в тестовую 1С?' : 'Изменить цену ТОЛЬКО НА САЙТЕ TEXHORU?',
      `Товар: ${item.product.name}`,
      `Текущая: ${money.format(old)} ₽`,
      `05.ru: ${money.format(item.latestPrice)} ₽`,
      `Новая: ${money.format(next)} ₽ (на 500 ₽ ниже 05.ru)`,
      '',
      'ВНИМАНИЕ: себестоимость может быть не указана в 1С. Проверь маржу самостоятельно.',
      ...(large ? ['ВНИМАНИЕ: изменение больше 10%.'] : []),
      toOneC ? '1С получит изменение при следующем обмене. До подтверждения оно будет в очереди.' : 'Цена в 1С НЕ изменится. Повторная выгрузка из 1С может перезаписать цену сайта.',
      'Подтвердить изменение?',
    ].join('\n')
    if (!window.confirm(confirmation)) return
    await action(`apply-${item.id}`, async () => {
      const applied = await api.adminApplyRecommendedPrice(item.id, {
        expectedCurrentPrice: old, expectedCompetitorPrice: item.latestPrice!,
        targetPrice: next, acceptUnknownCost: true, acceptLargeChange: large,
      })
      await onCatalogImported()
      return applied
    }, `Новая цена: ${money.format(next)} ₽. ${toOneC ? 'Ожидает подтверждения обменом с 1С.' : 'Только на сайте; 1С не затронута.'}`)
  }
  async function upload(file: File | undefined, mode: 'catalog' | 'receipts') {
    if (!file) return
    await action(mode, async () => {
      const value = JSON.parse((await file.text()).replace(/^\uFEFF/, ''))
      if (mode === 'catalog') { await api.adminImportOneC(value); await onCatalogImported() }
      else await api.monitorReceipts(value)
    }, mode === 'catalog' ? 'Каталог из 1С загружен. Теперь можно искать совпадения на 05.ru.' : 'Подтверждения 1С приняты.')
  }
  const visible = items.filter(item => inCatalogSection({ name: item.externalName || '', categoryName: item.product?.category?.name }, section) && (filter === 'ALL' || (filter === 'ERROR' ? Boolean(item.lastError) : filter === 'REVIEW' ? item.matchStatus !== 'CONFIRMED' : item.matchStatus === filter)) && `${item.externalName} ${item.product?.name || ''}`.toLowerCase().includes(search.toLowerCase()))
  const oneCProducts = products.filter(p => p.oneCId && p.price > 0 && p.stockQty > 0 && p.status === 'ACTIVE')
  const oneCPaths = [...new Set(oneCProducts.flatMap(p => {
    const segments = (p.category?.name || '').split(' / ').map(s => s.trim()).filter(Boolean)
    return segments.map((_, i) => segments.slice(0, i + 1).join(' / '))
  }))].sort((a, b) => a.localeCompare(b, 'ru'))
  const inScope = oneCProducts.filter(p => !oneCPath || p.category?.name === oneCPath || p.category?.name.startsWith(oneCPath + ' / ')).length
  const lastAutoJob = jobs.find(j => j.kind === 'MATCH_1C')
  const matched = items.filter(item => item.matchStatus === 'CONFIRMED').length
  const activeJob = jobs.some(j => ['QUEUED', 'RUNNING'].includes(j.status))

  return <div className="monitor-v2">
    <header className="monitor-simple-head"><div><h2>Цены конкурента</h2><p>Сравнивай свои товары с 05.ru.</p></div>{view === 'prices' && <button className="monitor-primary" disabled={Boolean(busy) || activeJob || !items.length} onClick={() => void action('all', () => api.monitorCheckAll(), 'Проверка запущена.')}>{activeJob ? 'Проверка идёт…' : 'Обновить цены'}</button>}</header>
    <nav className="monitor-simple-tabs" aria-label="Мониторинг цен">{([['prices', 'Мои товары'], ['add', 'Добавить ссылку'], ['settings', 'Настройки']] as const).map(([id, title]) => <button key={id} aria-pressed={view === id} className={view === id ? 'active' : ''} onClick={() => { setView(id); setError(''); setNotice('') }}>{title}</button>)}</nav>
    {activeJob && <div className="monitor-live" role="status">{jobs.filter(j => ['QUEUED', 'RUNNING'].includes(j.status)).map(j => <div key={j.id}><span>{j.status === 'QUEUED' ? 'Ожидает запуска' : 'Проверяем'} · {j.processed} карточек · ошибок: {j.errors}</span><button disabled={Boolean(busy)} onClick={() => void action(j.id, () => api.monitorJobAction(j.id, 'cancel'))}>Остановить</button></div>)}</div>}
    {error && <div role="alert" className="form-error">{error}</div>}{notice && <p className="price-monitor__notice" role="status">{notice}</p>}
    {view === 'add' && <><div className="monitor-add-head"><h3>Что добавить?</h3><div className="monitor-simple-tabs"><button className={addMode === 'card' ? 'active' : ''} onClick={() => setAddMode('card')}>Один товар</button><button className={addMode === 'catalog' ? 'active' : ''} onClick={() => setAddMode('catalog')}>Раздел каталога</button></div></div><div className="monitor-v2__forms monitor-single-form">
      {addMode === 'card' && <form onSubmit={(e: FormEvent) => { e.preventDefault(); void action('check', () => api.adminCheckCompetitorPrice({ url }), 'Карточка добавлена. Открой «Мои товары», выбери раздел и свой товар.') }}>
        <h3>Вставь ссылку на товар 05.ru</h3><label>Ссылка на карточку<input required type="url" value={url} onChange={e => setUrl(e.target.value)} /></label><button disabled={Boolean(busy) || activeJob}>{busy === 'check' ? 'Проверяем…' : 'Проверить цену'}</button><small>Неизвестное наличие останется неизвестным. Ошибка не заменит последнюю успешную цену.</small>
      </form>}
      {addMode === 'catalog' && <form onSubmit={e => { e.preventDefault(); void action('scan', () => api.monitorScan(catalog, pages), 'Сбор запущен. Прогресс появится ниже; страницу можно закрыть.') }}>
        <h3>Собрать товары из раздела 05.ru</h3><label>Раздел 05.ru<input required type="url" value={catalog} onChange={e => setCatalog(e.target.value)} /></label><label>До скольких страниц пройти<select value={pages} onChange={e => setPages(Number(e.target.value))}><option value={1}>1 — первый тест</option><option value={5}>5 страниц</option><option value={20}>20 страниц</option><option value={100}>100 страниц</option></select></label><button disabled={Boolean(busy) || activeJob}>Начать сбор</button><small>Добавляет данные конкурента в мониторинг. Переходит по найденной ссылке следующей страницы. Полнота каталога зависит от разметки 05.ru.</small>
      </form>}
    </div></>}
    {view === 'settings' && <section className="monitor-v2__section">
      <div className="monitor-v2__section-head"><div><p className="eyebrow">ПРОВЕРКИ</p><h3>Задачи и расписание</h3></div><button disabled={Boolean(busy) || activeJob || !items.length} onClick={() => void action('all', () => api.monitorCheckAll(), 'Проверка сохранённых ссылок поставлена в очередь.')}>Проверить все цены</button></div>
      <div className="monitor-v2__schedule"><label>Проверять сохранённые карточки<select value={interval} onChange={e => setIntervalMinutes(Number(e.target.value))}><option value={0}>Только вручную</option><option value={120}>Каждые 2 часа</option><option value={360}>Каждые 6 часов</option><option value={1440}>Раз в сутки</option></select></label><button disabled={Boolean(busy)} onClick={() => void action('settings', () => api.monitorSaveSettings(catalog, interval), 'Расписание сохранено. Проверки выполняются, пока TEXHORU запущен.')}>Сохранить расписание</button></div>
      {!jobs.length && <p className="monitor-v2__muted">Задач ещё нет. Начни с одной карточки или одной страницы.</p>}
      <details className="monitor-settings-details"><summary>История проверок</summary>{jobs.slice(0, 5).map(job => <article className="monitor-v2__job" key={job.id}><div><b>{job.kind === 'CATALOG' ? 'Сбор раздела' : 'Обновление цен'} · {status[job.status]}</b><small>{date(job.createdAt)} · карточек проверено: {job.processed} · ошибок: {job.errors}{job.kind === 'CATALOG' ? ` · страниц: ${job.page}/${job.maxPages}` : ''}</small>{job.lastError && <details><summary>Ошибка прошлой задачи — {date(job.createdAt)}</summary><p>{friendlyError(job.lastError)}</p></details>}{job.status === 'COMPLETED' && job.url && <small>Достигнут лимит страниц. Для продолжения используй <a href={job.url} target="_blank" rel="noreferrer">следующую страницу раздела</a>.</small>}</div>{['QUEUED', 'RUNNING'].includes(job.status) ? <button disabled={Boolean(busy)} onClick={() => void action(job.id, () => api.monitorJobAction(job.id, 'cancel'))}>Остановить</button> : ['FAILED', 'CANCELLED'].includes(job.status) ? <button disabled={Boolean(busy)} onClick={() => void action(job.id, () => api.monitorJobAction(job.id, 'retry'))}>Продолжить</button> : null}</article>)}
      </details>
    </section>}
    {view === 'prices' && <section className="monitor-v2__section" aria-label="Автоматическое сопоставление 1С и 05.ru">
      <div className="monitor-v2__section-head"><div>
        <p className="eyebrow">1С → TEXHORU → 05.ru</p>
        <h3>Найти совпадения автоматически</h3>
        <p>Выбери любую группу или вложенную подгруппу, загруженную из 1С. Программа сама ищет товары на 05.ru и сверяет модель, память, цвет и другие характеристики.</p>
      </div></div>
      <div className="monitor-v2__schedule">
        <label>Группа из 1С
          <select value={oneCPath} onChange={e => setOneCPath(e.target.value)}>
            <option value="">Все группы из 1С</option>
            {oneCPaths.map(path => <option key={path} value={path}>{'· '.repeat(Math.max(0, path.split(' / ').length - 1))}{path}</option>)}
          </select>
        </label>
        <label>Товаров за проверку
          <select value={autoLimit} onChange={e => setAutoLimit(Number(e.target.value))}>
            <option value={10}>10 (тест)</option><option value={30}>30</option><option value={100}>100</option>
          </select>
        </label>
        <button disabled={Boolean(busy) || activeJob || !inScope} onClick={() => void action('auto-find', async () => {
          const job = await api.monitorAutoFindOneC(oneCPath, autoLimit)
          setNotice(`Запущен поиск по разделу: ${job.queued} из ${job.eligible} товаров. Результаты появятся здесь.`)
        })}> {busy === 'auto-find' ? 'Подготовка…' : 'Найти совпадения с 05.ru'}</button>
      </div>
      <p className="monitor-v2__muted">В выбранной группе: {inScope} товаров с ценой и остатком. Подгруппы включены. Цены автоматически НЕ изменяются; спорные совпадения нужно подтвердить.</p>
      {lastAutoJob && <p role="status">Последний поиск: {status[lastAutoJob.status] || lastAutoJob.status} · обработано {lastAutoJob.processed} · ошибок/несовпадений {lastAutoJob.errors}{lastAutoJob.lastError ? ' · ' + lastAutoJob.lastError : ''}</p>}
    </section>}
    {view === 'prices' && <section className="monitor-v2__section monitor-price-workspace">
      <div className="monitor-v2__section-head"><div><h3>Каталог</h3><p>{items.length} карточек · связано с твоими товарами: {matched}</p></div><div className="monitor-v2__filters"><input placeholder="Найти товар…" value={search} onChange={e => setSearch(e.target.value)} /><select value={filter} onChange={e => setFilter(e.target.value)}><option value="ALL">Все карточки</option><option value="REVIEW">Требуют проверки</option><option value="CONFIRMED">Подтверждены</option><option value="ERROR">Ошибки проверки</option></select></div></div>
      {!items.length && <div className="monitor-empty"><h3>Добавь первый товар</h3><p>Вставь ссылку с 05.ru, чтобы получить цену и выбрать свой товар.</p><button onClick={() => setView('add')}>Добавить ссылку</button></div>}
      <CatalogSections items={items.map(item => ({ name: item.externalName || '', categoryName: item.product?.category?.name }))} selection={section} searching={Boolean(search.trim()) || filter !== 'ALL'} onSelect={value => { setSection(value); setSearch(''); setFilter('ALL'); ++matchRequest.current }} />
      {<>
      <div className="catalog-result-count">Найдено: {visible.length}</div>
      {!visible.length && <p className="monitor-v2__muted">Карточек пока нет или они не подходят под фильтр.</p>}
      {visible.slice(0, limit).map(item => {
        const candidate = candidates.find(c => c.product.id === Number(selected))
        return <article className="monitor-v2__product" key={item.id}>
          <div className="monitor-v2__product-row"><div><span className={`monitor-v2__tag ${item.matchStatus === 'CONFIRMED' ? 'is-ok' : ''}`}>{status[item.matchStatus]}</span><h4>{(item.externalName || 'Карточка без результата').replace(/^Фотография товара\s*/i, '')}</h4><a href={item.externalUrl} target="_blank" rel="noreferrer">Открыть на 05.ru ↗</a><small>{item.lastSuccessAt ? `Проверено: ${date(item.lastSuccessAt)}` : 'Цена ещё не проверена'}</small></div><div><span>05.ru</span><strong>{item.latestPrice ? `${money.format(item.latestPrice)} ₽` : '—'}</strong><small>{item.inStock === true ? 'В наличии' : item.inStock === false ? 'Нет в наличии / под заказ' : 'Наличие неизвестно'}</small></div><div><span>Наш товар</span><b>{item.product?.name || 'Не сопоставлен'}</b><small>{item.product ? `${money.format(item.product.price)} ₽` : 'Нажми «Выбрать мой товар»'}</small></div><button disabled={Boolean(busy)} onClick={() => void openMatch(item)}>{opened === item.id ? 'Закрыть' : item.matchStatus === 'CONFIRMED' ? 'Подробнее' : 'Выбрать мой товар'}</button></div>
          <div className="monitor-price-summary"><span>{item.lastError ? 'Не удалось обновить цену' : !item.lastSuccessAt ? 'Нужна первая проверка' : 'Цена проверена'}</span><span>{item.recommendedPrice ? `Рекомендация: ${money.format(item.recommendedPrice)} ₽` : item.matchStatus === 'CONFIRMED' && item.latestPrice && item.latestPrice > 500 ? `Расчётная цена: ${money.format(item.latestPrice - 500)} ₽ (проверь себестоимость)` : 'Рекомендация пока недоступна'}</span></div>{item.matchStatus === 'CONFIRMED' && item.product && item.latestPrice && item.latestPrice > 500
            && item.inStock === true && !item.lastError && item.lastSuccessAt
            && Date.now() - new Date(item.lastSuccessAt).getTime() <= 24 * 3600_000
            ? <div className="monitor-v2__actions"><button disabled={Boolean(busy) || activeJob} onClick={() => void applySitePrice(item)}>
                {busy === `apply-${item.id}` ? 'Применяем…' : `Применить цену ${money.format(item.latestPrice - 500)} ₽`}
              </button><small>Только цена на сайте. Перед применением будет подтверждение.</small></div>
            : null}
          {opened === item.id && <div className="monitor-v2__match"><h4>Выбери свой товар</h4>{(item.lastError || !item.lastSuccessAt) && <div className="form-error"><p>{item.lastError ? friendlyError(item.lastError) : 'Цена ещё не проверена.'}</p><button disabled={Boolean(busy) || activeJob} onClick={() => void action('check', () => api.adminCheckCompetitorPrice({ url: item.externalUrl }), 'Цена обновлена.')}>Повторить проверку</button></div>}<p>Сверь модель, память и цвет. Если прошлая проверка не удалась, кнопка подтверждения сначала повторит её.</p>{matchLoading && <p role="status">Загружаю список товаров…</p>}{!products.some(p => p.status === 'ACTIVE') && <p className="form-error">Нет активных товаров. В разделе «Товары» добавь товар или измени его статус на «Активный».</p>}<div className="monitor-v2__candidate-list">{candidates.map(c => <button className={selected === String(c.product.id) ? 'selected' : ''} key={c.product.id} onClick={() => setSelected(String(c.product.id))}><b>{c.product.name}</b><small>Возможное совпадение — сверь характеристики ниже</small></button>)}</div><label>Или выбери товар вручную<select value={selected} onChange={e => setSelected(e.target.value)}><option value="">Выбрать товар</option>{products.filter(p => p.status === 'ACTIVE').map(p => <option value={p.id} key={p.id}>{p.name} · {p.sku}</option>)}</select></label>
            <details className="monitor-settings-details"><summary>Сравнить характеристики</summary><div className="monitor-v2__table-wrap"><table><thead><tr><th>Характеристика</th><th>Наш товар</th><th>05.ru</th></tr></thead><tbody>{Object.entries(labels).map(([key, label]) => <tr key={key}><td>{label}</td><td>{candidate?.ours[key] || '—'}</td><td>{item.attributes[key] || '—'}</td></tr>)}</tbody></table></div></details>
            {candidate?.missing.length ? <p>Не хватает данных: {candidate.missing.join(', ')}. Перед подтверждением сверь их в 1С и карточке 05.ru.</p> : null}<div className="monitor-v2__actions"><button disabled={Boolean(busy) || activeJob || matchLoading || !selected} onClick={() => void confirmItem(item)}>{busy === 'confirm' ? 'Проверяю и сохраняю…' : item.lastError || !item.lastSuccessAt ? 'Проверить цену и подтвердить' : 'Подтвердить выбранный товар'}</button>{item.product && <button disabled={Boolean(busy)} onClick={() => void action('unmatch', () => api.monitorUnmatch(item.id), 'Связь снята; ожидающие сообщения отменены.')}>Снять связь</button>}</div>
            <div role="status">{error && <p className="form-error">{error}</p>}{notice && <p>{notice}</p>}{!selected && <p>Сначала выбери товар в списке выше.</p>}{activeJob && <p>Дождись завершения текущей проверки или останови её выше.</p>}</div><details className="monitor-settings-details"><summary>История цен и данные источника</summary><p>Продавец: {item.seller || 'не определён'} · регион: {item.region || 'не определён'}</p><p>{item.recommendationReasons.join('; ')}</p><div className="monitor-v2__table-wrap"><table><thead><tr><th>Когда</th><th>Цена</th><th>Наличие</th></tr></thead><tbody>{history.slice(0, 10).map(row => <tr key={row.id}><td>{date(row.checkedAt)}</td><td>{money.format(row.price)} ₽</td><td>{row.inStock === true ? 'Есть' : row.inStock === false ? 'Нет / под заказ' : 'Неизвестно'}</td></tr>)}</tbody></table></div></details>
          </div>}
        </article>
      })}
      {visible.length > limit && <button className="catalog-more" onClick={() => setLimit(n => n + 24)}>Показать ещё 24</button>}</>}
    </section>}
    {view === 'settings' && <section className="monitor-v2__section"><details className="monitor-settings-details"><summary>Обмен с 1С</summary>
      <div className="monitor-v2__section-head"><div><p className="eyebrow">ОБМЕН С 1С</p><h3>Передать результаты</h3><p>Цены конкурента сохраняются отдельно. Подтверждённые свежие результаты попадают в очередь автоматически.</p></div><button disabled={Boolean(busy)} onClick={() => void action('queue', () => api.monitorQueue(), 'Очередь обновлена. В 1С нажми «Получить мониторинг».')}>Подготовить очередь для 1С</button></div>
      <div className="monitor-v2__files"><label>1. Загрузить каталог из 1С<input type="file" accept=".json" disabled={Boolean(busy)} onChange={e => { void upload(e.target.files?.[0], 'catalog'); e.target.value = '' }} /></label><button disabled={Boolean(busy)} onClick={() => void action('export', async () => download('monitoring.json', await api.monitorExport()), 'Файл monitoring.json готов. Загрузите его в 1С.')}>2. Скачать результаты JSON</button><label>3. Загрузить подтверждения 1С<input type="file" accept=".json" disabled={Boolean(busy)} onChange={e => { void upload(e.target.files?.[0], 'receipts'); e.target.value = '' }} /></label></div><small>Файловый обмен подходит для первого теста учебной базы. Прямой HTTP-обмен использует тот же формат и ключ из настроек TEXHORU.</small>
      <div className="monitor-v2__table-wrap"><table><thead><tr><th>Создано</th><th>Товар 1С</th><th>Цена конкурента</th><th>Доставка</th></tr></thead><tbody>{deliveries.slice(0, 15).map(d => <tr key={d.id}><td>{date(d.createdAt)}</td><td>{String(d.payload.ourName || '')}</td><td>{money.format(Number(d.payload.price || 0))} ₽</td><td>{status[d.status]}{d.lastError && <small>{d.lastError}</small>}</td></tr>)}</tbody></table></div>
    </details></section>}
  </div>
}
