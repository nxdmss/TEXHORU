import { useEffect, useState } from 'react'
import { api, type RemoteCatalogStatus } from './api'
import './RemoteCatalogPanel.css'
const labels: Record<string, string> = { QUEUED: 'В очереди', RUNNING: 'Загружается', PAUSED: 'На паузе', FAILED: 'Ошибка', COMPLETED: 'Готово', CANCELLED: 'Отменено' }
const errors: Record<string, string> = { COM_CONNECT: 'Не удалось подключиться к 1С. Проверьте COM-коннектор и локальные настройки агента.', CATALOG_READ: 'Не удалось прочитать данные 1С. Проверьте права, типы цен и соответствие базы УТ 10.3.' }
export function RemoteCatalogPanel() {
  const [data, setData] = useState<RemoteCatalogStatus | null>(null)
  const [path, setPath] = useState<{ id: string; name: string }[]>([])
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(0)
  const [selected, setSelected] = useState<string[]>([]), [mode, setMode] = useState<'FULL' | 'DELTA'>('FULL')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const parent = path.at(-1)?.id || ''
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(0) }, 300); return () => clearTimeout(timer) }, [search])
  useEffect(() => {
    let active = true, pending = false
    const refresh = async () => {
      if (pending || document.hidden) return
      pending = true
      try { const next = await api.remoteCatalog(parent, query, page); if (active) { setData(next); setError('') } }
      catch (e) { if (active) setError(e instanceof Error ? e.message : 'Не удалось получить состояние 1С') }
      finally { pending = false }
    }
    void refresh(); const timer = setInterval(refresh, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [parent, query, page])
  async function act(work: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('')
    try { await work(); setNotice(message); setData(await api.remoteCatalog(parent, query, page)) }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось выполнить команду') }
    finally { setBusy(false) }
  }
  const queue = (ids: string[]) => act(async () => {
    for (const groupId of ids) await api.remoteCatalogCreate({ kind: 'CATALOG', mode, ...(groupId ? { groupId } : {}) })
    setSelected([])
  }, 'Задание отправлено агенту. Прогресс появится после подключения к 1С.')
  const agent = data?.agent
  return <section className="remote-catalog" aria-label="Каталог основной базы 1С">
    <header className="remote-catalog__head"><div><p className="eyebrow">1С → TEXHORU</p><h2>Каталог под управлением</h2><p>Выберите группы из базы и отправьте их в магазин.</p></div><span className={'remote-catalog__connection ' + (agent?.online && agent.state !== 'error' ? 'is-online' : '')}>{agent?.online ? agent.state === 'error' ? 'Ошибка агента' : 'Агент на связи' : agent ? 'Агент не на связи' : 'Ожидаем агента'}</span></header>
    {data && !data.configured ? <div className="remote-catalog__empty"><h3>Подключите основную базу</h3><p>На сервере задайте профиль PRODUCTION и идентификатор базы. На компьютере с 1С установите агент каталога по инструкции из проекта: docs/управление-каталогом-из-сайта.md.</p></div> : <>
      <div className="remote-catalog__toolbar"><label>Режим загрузки<select value={mode} onChange={e => setMode(e.target.value as 'FULL' | 'DELTA')}><option value="FULL">Полная загрузка</option><option value="DELTA">Только изменения</option></select></label><button disabled={busy || !data?.configured} onClick={() => queue([''])}>Загрузить весь каталог</button><button disabled={busy || !data?.configured} onClick={() => act(() => api.remoteCatalogCreate({ kind: 'GROUPS', mode: 'FULL' }), 'Запрошено обновление групп из 1С.')}>Обновить группы</button></div>
      <div className="remote-catalog__workspace"><div className="remote-catalog__groups"><nav aria-label="Путь группы"><button onClick={() => { setPath([]); setPage(0); setSearch(''); setSelected([]) }}>Все группы</button>{path.map((p, i) => <button key={p.id} onClick={() => { setPath(path.slice(0, i + 1)); setPage(0); setSearch(''); setSelected([]) }}> / {p.name}</button>)}</nav>
        <input aria-label="Поиск группы в 1С" placeholder="Найти группу в 1С…" value={search} onChange={e => { setSearch(e.target.value); setSelected([]) }} />
        {parent && !query && <button className="remote-catalog__load-group" disabled={busy} onClick={() => queue([parent])}>Загрузить эту группу с подгруппами</button>}
        {selected.length > 0 && <button className="remote-catalog__load-group" disabled={busy} onClick={() => queue(selected)}>Загрузить выбранные ({selected.length})</button>}
        <div className="remote-catalog__group-list">{data?.groups.map(g => {
          const job = data.jobs.find(j => j.kind === 'CATALOG' && j.groupId === g.oneCId)
          return <div className="remote-catalog__group" key={g.oneCId}><input type="checkbox" aria-label={'Выбрать ' + g.name} checked={selected.includes(g.oneCId)} disabled={!selected.includes(g.oneCId) && selected.length >= 20} onChange={e => setSelected(e.target.checked ? [...selected, g.oneCId] : selected.filter(id => id !== g.oneCId))} /><button onClick={() => { setPath([...path, { id: g.oneCId, name: g.name }]); setPage(0); setSearch(''); setSelected([]) }}><span className="remote-catalog__folder" aria-hidden="true">▱</span><span><strong>{g.name}</strong><small>{g.itemCount.toLocaleString('ru-RU')} товаров в группе · {job ? labels[job.status] : g.lastReceivedAt ? 'Данные получены ' + new Date(g.lastReceivedAt).toLocaleString('ru-RU') : 'Нет данных о загрузке'}</small></span><span aria-hidden="true">›</span></button></div>
        })}</div>
        {data?.groups.length === 0 && <p className="remote-catalog__empty">{agent ? 'Здесь пока нет групп. Обновите список или загрузите выбранную группу целиком.' : 'После установки агент прочитает группы из 1С. Товары загрузятся по вашей команде.'}</p>}
        {data && data.total > 100 && <div className="remote-catalog__pagination"><button disabled={page === 0} onClick={() => { setPage(page - 1); setSelected([]) }}>Назад</button><span>{page + 1} / {Math.ceil(data.total / 100)}</span><button disabled={(page + 1) * 100 >= data.total} onClick={() => { setPage(page + 1); setSelected([]) }}>Далее</button></div>}
        <p className="remote-catalog__hint">Количество указано без подгрупп. Загрузка включает все подгруппы.{agent?.groupsUpdatedAt && <> Список обновлён {new Date(agent.groupsUpdatedAt).toLocaleString('ru-RU')}.</>}</p>
      </div><div className="remote-catalog__jobs"><h3>Загрузки <span>{data?.jobs.length || 0}</span></h3>{!data?.jobs.length && <p className="remote-catalog__empty">Выберите группу или весь каталог. Можно закрыть сайт — агент продолжит работу.</p>}{data?.jobs.map(job => <article className={'remote-catalog__job is-' + job.status.toLowerCase()} key={job.id}><div><strong>{job.groupName}</strong><span>{labels[job.status]}</span></div><p>{job.kind === 'GROUPS' ? `Прочитано групп: ${job.scanned}` : `Просмотрено: ${job.scanned} · Принято: ${job.processed} · Без изменений: ${Math.max(0, job.scanned - job.processed - job.skipped)}${job.skipped ? ' · Дублей: ' + job.skipped : ''}`}</p><small>{job.kind === 'CATALOG' && (job.mode === 'FULL' ? 'Полная загрузка · ' : 'Только изменения · ')}{new Date(job.updatedAt).toLocaleString('ru-RU')}</small>{job.error && <p role="alert">{errors[job.error] || 'Ошибка обмена. Проверьте агент на компьютере с 1С.'}</p>}<div className="remote-catalog__job-actions">{(job.status === 'QUEUED' || job.status === 'RUNNING') && <button disabled={busy} onClick={() => act(() => api.remoteCatalogAction(job.id, 'pause'), 'Загрузка поставлена на паузу.')}>Пауза</button>}{job.status === 'PAUSED' && <button disabled={busy} onClick={() => act(() => api.remoteCatalogAction(job.id, 'resume'), 'Продолжаем с сохранённого места.')}>Продолжить</button>}{job.status === 'FAILED' && <button disabled={busy} onClick={() => act(() => api.remoteCatalogAction(job.id, 'retry'), 'Повторяем с сохранённого места.')}>Повторить</button>}{['QUEUED', 'RUNNING', 'PAUSED', 'FAILED'].includes(job.status) && <button disabled={busy} onClick={() => act(() => api.remoteCatalogAction(job.id, 'cancel'), 'Задание отменено. Принятые товары сохранены.')}>Отменить</button>}</div></article>)}</div></div>
      <details className="remote-catalog__hint"><summary>Как работает обмен</summary><p>Агент проверяет задания раз в минуту. Во время загрузки прогресс обновляется каждые 5 секунд. Порции до 50 товаров и 512 КБ, один пакет за раз с паузой. Фото, документы и вся база целиком не передаются.</p><p>Режим «Только изменения» просматривает выбранную группу, передавая полные карточки только при изменениях. Список групп обновляется каждые 5 минут, пока агент работает. Каталог читается из 1С; запись розничных цен выполняется отдельным механизмом.</p></details>
    </>}
    {agent?.error && <p className="form-error">{errors[agent.error] || 'Проверьте настройки агента.'}</p>}{notice && <p role="status">{notice}</p>}{error && <p className="form-error" role="alert">{error}</p>}
  </section>
}
