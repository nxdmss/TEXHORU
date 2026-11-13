import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { api, type OneCExcludedGroup, type OneCNomenclaturePage, type OneCRemoteGroup, type RemoteCatalogStatus } from './api'
import './RemoteCatalogPanel.css'

const jobLabels: Record<string, string> = {
  QUEUED: 'В очереди', RUNNING: 'Считывается из 1С', PAUSED: 'На паузе',
  FAILED: 'Ошибка', COMPLETED: 'Готово', CANCELLED: 'Отменено',
}
const agentErrors: Record<string, string> = {
  COM_CONNECT: 'Агент дошёл до компьютера, но не подключился к 1С. Проверьте разрядность COMConnector и строку подключения.',
  CATALOG_READ: '1С подключена, но чтение номенклатуры завершилось ошибкой. Проверьте права пользователя и структуру УТ 10.3.',
}
const money = new Intl.NumberFormat('ru-RU')

function shortDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('ru-RU') : 'ещё не получено'
}

export function RemoteCatalogPanel() {
  const [status, setStatus] = useState<RemoteCatalogStatus | null>(null)
  const [tree, setTree] = useState<OneCRemoteGroup[]>([])
  const [excludedGroups, setExcludedGroups] = useState<OneCExcludedGroup[]>([])
  const [mirrorCount, setMirrorCount] = useState(0)
  const [pageData, setPageData] = useState<OneCNomenclaturePage | null>(null)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [selectedGroup, setSelectedGroup] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const byId = useMemo(() => new Map(tree.map(group => [group.oneCId, group])), [tree])
  const children = useMemo(() => {
    const map = new Map<string, OneCRemoteGroup[]>()
    for (const group of tree) map.set(group.parentId, [...(map.get(group.parentId) || []), group])
    return map
  }, [tree])
  const path = useMemo(() => {
    const result: OneCRemoteGroup[] = []
    const seen = new Set<string>()
    let id = selectedGroup
    while (id && !seen.has(id)) {
      seen.add(id)
      const group = byId.get(id)
      if (!group) break
      result.unshift(group)
      id = group.parentId
    }
    return result
  }, [byId, selectedGroup])

  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setPage(0) }, 250)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    let alive = true
    let pending = false
    const refresh = async (withTree = false) => {
      if (pending || document.hidden) return
      pending = true
      try {
        const nextStatus = await api.remoteCatalog()
        if (!alive) return
        setStatus(nextStatus)
        if (!nextStatus.configured) { setPageData(null); return }
        const nextPagePromise = api.remoteNomenclature(selectedGroup, query, page)
        const loadTree = withTree || tree.length === 0
        const nextTreePromise = loadTree ? api.remoteCatalogTree() : null
        const excludedPromise = loadTree ? api.remoteExcludedGroups() : null
        const [nextPage, nextTree, nextExcluded] = await Promise.all([nextPagePromise, nextTreePromise, excludedPromise])
        if (!alive) return
        setPageData(nextPage)
        if (nextTree) { setTree(nextTree.groups); setMirrorCount(nextTree.itemCount) }
        if (nextExcluded) setExcludedGroups(nextExcluded)
        setError('')
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : 'Не удалось получить номенклатуру')
      } finally {
        pending = false
      }
    }
    void refresh(true)
    const fast = window.setInterval(() => void refresh(false), 5000)
    const slow = window.setInterval(() => void refresh(true), 30000)
    return () => { alive = false; clearInterval(fast); clearInterval(slow) }
  }, [selectedGroup, query, page])

  async function command(work: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('')
    try {
      await work()
      setNotice(message)
      const [nextStatus, nextTree, nextPage, nextExcluded] = await Promise.all([
        api.remoteCatalog(), api.remoteCatalogTree(), api.remoteNomenclature(selectedGroup, query, page), api.remoteExcludedGroups(),
      ])
      setStatus(nextStatus); setTree(nextTree.groups); setMirrorCount(nextTree.itemCount); setPageData(nextPage); setExcludedGroups(nextExcluded)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Команда не выполнена')
      return false
    } finally {
      setBusy(false)
    }
  }

  function openGroup(group: OneCRemoteGroup) {
    setSelectedGroup(group.oneCId)
    setExpanded(current => new Set(current).add(group.oneCId))
    setSearch(''); setPage(0)
  }

  function toggleItem(id: string) {
    if (!selectedItemIds.has(id) && selectedItemIds.size >= 100) {
      setError('За один раз можно загрузить до 100 позиций. Запустите их, затем выберите следующие.')
      return
    }
    setSelectedItemIds(current => {
      const next = new Set(current)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function importSelected() {
    const ids = [...selectedItemIds]
    if (!ids.length) return
    const queued = await command(
      () => api.remoteCatalogCreate({ kind: 'IMPORT', mode: 'FULL', itemIds: ids }),
      `${ids.length.toLocaleString('ru-RU')} выбранных позиций поставлено в очередь. Агент загрузит полные данные только для них.`,
    )
    if (queued) setSelectedItemIds(new Set())
  }

  async function importGroup(group: OneCRemoteGroup, stockOnly: boolean) {
    await command(
      () => api.remoteCatalogCreate({ kind: 'IMPORT', mode: 'FULL', groupId: group.oneCId, stockOnly }),
      `Группа «${group.name}» поставлена в очередь: ${stockOnly ? 'только товары в наличии' : 'все товары'}.`,
    )
  }

  async function excludeGroup(group: OneCRemoteGroup) {
    if (!window.confirm(`Исключить «${group.name}» и все вложенные группы из сайта?\n\nЗаписи этой ветки будут удалены из базы сайта и больше не будут загружаться из 1С. В самой 1С ничего не изменится.`)) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.remoteExcludeGroup(group.oneCId)
      const [nextStatus, nextTree, nextPage, nextExcluded] = await Promise.all([
        api.remoteCatalog(), api.remoteCatalogTree(), api.remoteNomenclature('', '', 0), api.remoteExcludedGroups(),
      ])
      setSelectedGroup(''); setSearch(''); setQuery(''); setPage(0)
      setStatus(nextStatus); setTree(nextTree.groups); setMirrorCount(nextTree.itemCount); setPageData(nextPage); setExcludedGroups(nextExcluded)
      const protectedText = result.productsArchived ? ` Защищено историей заказов/цен и архивировано: ${result.productsArchived.toLocaleString('ru-RU')}.` : ''
      setNotice(`Группа «${result.name}» исключена. Удалено из зеркала: ${result.removed.toLocaleString('ru-RU')}; карточек сайта: ${result.productsDeleted.toLocaleString('ru-RU')}; категорий: ${result.categoriesDeleted.toLocaleString('ru-RU')}.${protectedText} 1С не изменялась.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось исключить группу')
    } finally { setBusy(false) }
  }

  async function restoreGroup(group: OneCExcludedGroup) {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.remoteRestoreGroup(group.oneCId)
      const [nextStatus, nextTree, nextExcluded] = await Promise.all([api.remoteCatalog(), api.remoteCatalogTree(), api.remoteExcludedGroups()])
      setStatus(nextStatus); setTree(nextTree.groups); setMirrorCount(nextTree.itemCount); setExcludedGroups(nextExcluded)
      setNotice(`Группа «${result.name}» возвращена. Обновление списка названий поставлено в очередь.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось вернуть группу')
    } finally { setBusy(false) }
  }

  function renderTree(parentId: string, depth = 0): ReactNode {
    return (children.get(parentId) || []).map(group => {
      const nested = (children.get(group.oneCId) || []).length > 0
      const isOpen = expanded.has(group.oneCId)
      const isSelected = selectedGroup === group.oneCId
      return <div key={group.oneCId}>
        <div className={'onec-tree__row' + (isSelected ? ' is-selected' : '')} style={{ '--tree-depth': depth } as CSSProperties}>
          <button className="onec-tree__toggle" aria-label={isOpen ? 'Свернуть' : 'Развернуть'} disabled={!nested}
            onClick={() => setExpanded(current => { const next = new Set(current); next.has(group.oneCId) ? next.delete(group.oneCId) : next.add(group.oneCId); return next })}>
            {nested ? isOpen ? '⌄' : '›' : ''}
          </button>
          <button className="onec-tree__name" title={group.name} onClick={() => openGroup(group)}>
            <span className="onec-folder" aria-hidden="true" /><span>{group.name}</span>
          </button>
        </div>
        {nested && isOpen && renderTree(group.oneCId, depth + 1)}
      </div>
    })
  }

  const agent = status?.agent
  const selected = selectedGroup ? byId.get(selectedGroup) : null
  const online = Boolean(agent?.online && agent.state !== 'error')
  const activeJob = status?.jobs.find(job => ['QUEUED', 'RUNNING', 'PAUSED', 'FAILED'].includes(job.status))
  const groupRows = pageData?.children || []
  const itemRows = pageData?.items || []
  const totalPages = Math.max(1, Math.ceil((pageData?.total || 0) / (pageData?.pageSize || 100)))

  return <section className="onec-mirror" aria-label="Номенклатура основной базы 1С">
    <header className="onec-mirror__header">
      <div>
        <p className="eyebrow">Основная база · УТ 10.3</p>
        <h2>Номенклатура 1С</h2>
        <p>Выберите группу или отметьте нужные товары.</p>
      </div>
      <div className="onec-mirror__live">
        <span className={online ? 'is-online' : ''} />
        <div><strong>{online ? 'Онлайн-связь с агентом 1С' : agent ? 'Агент сейчас не на связи' : 'Ожидаем агента'}</strong>
          <small>{agent ? 'Последний сигнал: ' + shortDate(agent.lastSeenAt) : 'После запуска агент появится здесь автоматически'}</small></div>
      </div>
    </header>

    {status && !status.configured ? <div className="onec-mirror__setup">
      <strong>На сервере не выбрана основная база 1С</strong>
      <span>Задайте профиль PRODUCTION и ONE_C_PRODUCTION_BASE_ID — после этого зеркало начнёт наполняться автоматически.</span>
    </div> : <>
      <div className="onec-mirror__toolbar">
        <div className="onec-search"><span aria-hidden="true">⌕</span><input aria-label="Поиск по номенклатуре"
          placeholder="Найти по коду, артикулу или названию…" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <div className="onec-mirror__toolbar-stats">
          <span><b>{mirrorCount.toLocaleString('ru-RU')}</b> позиций из 1С</span>
        </div>
        <button disabled={busy || !status?.configured} onClick={() => command(
          () => api.remoteCatalogCreate({ kind: 'INDEX', mode: 'FULL' }),
          'Обновление лёгкого списка поставлено в очередь. Цены и остатки не загружаются.',
        )}>{busy ? 'Отправляем…' : 'Обновить'}</button>
        {selectedItemIds.size > 0 && <button className="onec-import-button" disabled={busy} onClick={importSelected}>
          Загрузить {selectedItemIds.size}
        </button>}
      </div>

      <div className="onec-mirror__window">
        <aside className="onec-tree">
          <div className="onec-tree__title"><span className="onec-folder is-root" /><strong>Группы номенклатуры</strong></div>
          <button className={'onec-tree__root' + (!selectedGroup ? ' is-selected' : '')} onClick={() => { setSelectedGroup(''); setSearch(''); setPage(0) }}>
            <span className="onec-folder" />Номенклатура <b>{mirrorCount.toLocaleString('ru-RU')}</b>
          </button>
          <div className="onec-tree__scroll">{tree.length ? renderTree('') : <p>Группы появятся после первого чтения 1С.</p>}</div>
          <details className="onec-excluded">
            <summary>Исключённые группы <b>{excludedGroups.length}</b></summary>
            <div>{excludedGroups.length ? excludedGroups.map(group => <article key={group.oneCId}>
              <span><strong>{group.name}</strong><small>Не загружается из 1С</small></span>
              <button disabled={busy} onClick={() => restoreGroup(group)}>Вернуть</button>
            </article>) : <p>Исключённых веток нет.</p>}</div>
          </details>
        </aside>

        <main className="onec-list">
          <nav className="onec-breadcrumbs" aria-label="Путь в номенклатуре">
            <button onClick={() => { setSelectedGroup(''); setPage(0) }}>Номенклатура</button>
            {path.map(group => <span key={group.oneCId}><i>›</i><button onClick={() => openGroup(group)}>{group.name}</button></span>)}
            {query && <span><i>›</i><b>Поиск: {query}</b></span>}
          </nav>
          {selected && <section className={'onec-group-actions' + (selected.fullyImportedAt ? ' is-complete' : '')}>
            <div><strong>{selected.name}</strong><span>{selected.fullyImportedAt ? 'Группа уже загружена на сайт' : 'Какие товары добавить на сайт?'}</span></div>
            {!selected.fullyImportedAt && <><button className="is-primary" disabled={busy} onClick={() => importGroup(selected, true)}>Только в наличии</button><button disabled={busy} onClick={() => importGroup(selected, false)}>Все товары</button></>}
            <button className="is-danger" disabled={busy} onClick={() => excludeGroup(selected)}>Исключить</button>
          </section>}
          {groupRows.length > 0 && <div className="onec-subgroups"><strong>Подгруппы</strong><div>{groupRows.map(group => <button key={group.oneCId} onClick={() => openGroup(group)}><span className="onec-folder" />{group.name}{group.fullyImportedAt && <i>На сайте</i>}</button>)}</div></div>}
          {itemRows.length > 0 && <div className="onec-table-wrap">
            <div className="onec-table">
              <div className="onec-table__row is-head">
                <span /><span>Товар</span><span>Код / артикул</span><span>Цена / остаток</span><span>Статус</span>
              </div>
              {itemRows.map(item => <div className={'onec-table__row is-item' + (item.deletionMark ? ' is-deleted' : '')} key={item.oneCId}>
                <span><input type="checkbox" aria-label={`Выбрать ${item.name}`} disabled={item.deletionMark} checked={selectedItemIds.has(item.oneCId)} onChange={() => toggleItem(item.oneCId)} /></span>
                <span title={item.name}><b>{item.name}</b>{item.fullName && item.fullName !== item.name && <small>{item.fullName}</small>}{item.deletionMark && <small>Пометка удаления</small>}</span>
                <span><b>{item.code || '—'}</b><small>{item.article || 'Без артикула'}</small></span>
                <span>{item.imported ? <><b>{item.retailPrice == null ? 'Цена не задана' : money.format(item.retailPrice) + ' ₽'}</b><small>Остаток: {money.format(item.stockQty)} {item.unitName}</small></> : <small>После загрузки</small>}</span>
                <span><b className={item.imported ? 'onec-status is-imported' : 'onec-status'}>{item.imported ? 'На сайте' : 'Только список'}</b></span>
              </div>)}
            </div>
          </div>}
          {!groupRows.length && !itemRows.length && <div className="onec-list__empty">
            <span className="onec-folder is-large" /><strong>{query ? 'Ничего не найдено' : mirrorCount ? 'В этой группе пока нет позиций' : 'Идёт загрузка списка названий'}</strong>
            <p>{mirrorCount ? 'Выберите другую группу или измените запрос.' : 'Агент перенесёт только названия, коды и группы. Полные данные загружаются после вашего выбора.'}</p>
          </div>}
          {pageData && pageData.total > pageData.pageSize && <div className="onec-pagination">
            <button disabled={page === 0} onClick={() => setPage(value => value - 1)}>← Назад</button>
            <span>Страница {page + 1} из {totalPages} · {pageData.total.toLocaleString('ru-RU')} позиций</span>
            <button disabled={page + 1 >= totalPages} onClick={() => setPage(value => value + 1)}>Далее →</button>
          </div>}
        </main>
      </div>

      <section className="onec-exchange">
        <div className="onec-exchange__summary">
          <div><span className={activeJob?.status === 'FAILED' ? 'is-error' : activeJob ? 'is-working' : online ? 'is-ok' : ''} />
            <p><strong>{activeJob ? activeJob.groupName + ': ' + jobLabels[activeJob.status] : online ? 'Автоматическая синхронизация включена' : 'Синхронизация продолжится после связи с агентом'}</strong>
              <small>{activeJob?.kind === 'INDEX' ? 'Просмотрено ' + activeJob.scanned.toLocaleString('ru-RU') + ' · добавлено названий ' + activeJob.processed.toLocaleString('ru-RU') : activeJob?.kind === 'IMPORT' ? 'Прочитано ' + activeJob.scanned.toLocaleString('ru-RU') + ' · загружено на сайт ' + activeJob.processed.toLocaleString('ru-RU') : 'Агент проверяет 1С раз в минуту, экран обновляется каждые 5 секунд.'}</small></p>
          </div>
          {activeJob?.status === 'FAILED' && <button disabled={busy} onClick={() => command(() => api.remoteCatalogAction(activeJob.id, 'retry'), 'Повтор запущен с сохранённого места.')}>Повторить</button>}
        </div>
        <details>
          <summary>Очередь и диагностика <b>{status?.jobs.length || 0}</b></summary>
          <div className="onec-jobs">{status?.jobs.slice(0, 20).map(job => <article key={job.id} className={'is-' + job.status.toLowerCase()}>
            <div><strong>{job.groupName}</strong><span>{jobLabels[job.status]}</span></div>
            <p>{job.kind === 'GROUPS' ? 'Прочитано групп: ' + job.scanned : job.kind === 'INDEX' ? 'Названий просмотрено: ' + job.scanned + ' · добавлено: ' + job.processed : 'Полных карточек прочитано: ' + job.scanned + ' · загружено: ' + job.processed + ' · пропущено: ' + job.skipped}</p>
            <small>{shortDate(job.updatedAt)}</small>
            {job.error && <p className="is-error">{agentErrors[job.error] || 'Ошибка обмена с 1С.'}</p>}
            <div>{job.status === 'PAUSED' && <button onClick={() => command(() => api.remoteCatalogAction(job.id, 'resume'), 'Загрузка продолжена.')}>Продолжить</button>}
              {job.status === 'FAILED' && <button onClick={() => command(() => api.remoteCatalogAction(job.id, 'retry'), 'Повтор запущен.')}>Повторить</button>}
              {['QUEUED', 'RUNNING'].includes(job.status) && <button onClick={() => command(() => api.remoteCatalogAction(job.id, 'pause'), 'Загрузка приостановлена.')}>Пауза</button>}
              {['QUEUED', 'RUNNING', 'PAUSED', 'FAILED'].includes(job.status) && <button onClick={() => command(() => api.remoteCatalogAction(job.id, 'cancel'), 'Задание отменено.')}>Отменить</button>}</div>
          </article>)}</div>
        </details>
      </section>
    </>}
    {agent?.error && <p className="form-error" role="alert">{agentErrors[agent.error] || 'Агент сообщил об ошибке чтения 1С.'}</p>}
    {notice && <p className="onec-notice" role="status">{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>
}
