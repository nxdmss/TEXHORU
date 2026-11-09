import { useEffect, useMemo, useState } from 'react'
import { api, type ApiProduct, type OneCPriceSyncStatus } from './api'

export function TestPriceScope({ products, scope, enabled, disabled = false, path, onChanged }: {
  products: ApiProduct[]; scope: OneCPriceSyncStatus['scope']; enabled: boolean; disabled?: boolean;
  path: string; onChanged: () => Promise<unknown>;
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(40)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [category, setCategory] = useState(path)
  const [showApproved, setShowApproved] = useState(false)
  useEffect(() => { setCategory(path); setSelected([]); setSearch(''); setLimit(40); setNotice(''); setError('') }, [path])
  const approved = useMemo(() => new Set(scope.map(p => p.oneCId)), [scope])
  const free = Math.max(0, 30 - scope.length)
  const available = products.filter(p => p.oneCId && p.status === 'ACTIVE' && p.price > 0 && p.price <= 5_000_000
    && (!category || p.category.name === category || p.category.name.startsWith(category + ' / ')))
  const visible = available.filter(p => (showApproved ? approved.has(p.oneCId!) : !approved.has(p.oneCId!))
    && (p.name + ' ' + p.sku).toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')))
  const chosen = products.filter(p => selected.includes(p.oneCId!) && !approved.has(p.oneCId!))
  const categories = [...new Set(products.filter(p => p.oneCId).map(p => p.category.name))].sort((a, b) => a.localeCompare(b, 'ru'))
  const eligible = visible.filter(p => !approved.has(p.oneCId!))
  async function add() {
    if (!chosen.length || chosen.length > free || busy || disabled || !enabled) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.addTestPriceScope(chosen.map(p => p.oneCId!))
      setSelected([])
      setNotice(`Добавлено: ${result.added}. Можно перейти к карточкам 05.ru.`)
      await onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось разрешить товары для TEST') }
    finally { setBusy(false) }
  }
  return <section className="pa-scope" aria-label="Допуск товаров к обмену">
    <div className="pa-scope-heading"><div><h3>Каким товарам обновлять цены?</h3><p>Отметь товары из TEST. Сами цены отправишь отдельно.</p></div><span>{scope.length} / 30</span></div>
    {!enabled && <p role="alert">Передача цен в TEST выключена на сервере. Добавление товаров сейчас недоступно.</p>}
    <div className="pa-scope-filters"><input className="pa-search" aria-label="Найти товар для TEST" placeholder="Название или артикул" value={search} disabled={busy || disabled || !enabled}
      onChange={e => { setSearch(e.target.value); setLimit(40) }} />
    <select aria-label="Раздел для допуска к обмену" value={category} onChange={e => { setCategory(e.target.value); setLimit(40) }}><option value="">Все разделы</option>{categories.map(p => <option key={p}>{p}</option>)}</select></div>
    <div className="pa-scope-tabs"><button type="button" aria-pressed={!showApproved} onClick={() => { setShowApproved(false); setLimit(40) }}>Доступны для выбора</button><button type="button" aria-pressed={showApproved} onClick={() => { setShowApproved(true); setLimit(40) }}>Уже разрешены · {scope.length}</button><span>Свободно: {free}</span></div>
    <div className="pa-scope-actions">
      <button className="pa-action pa-secondary" type="button" disabled={busy || disabled || !enabled || !eligible.length || eligible.length > free}
        onClick={() => setSelected(eligible.map(p => p.oneCId!))}>Выбрать найденные ({eligible.length})</button>
      <button className="pa-action pa-secondary" type="button" disabled={busy || disabled || !selected.length} onClick={() => setSelected([])}>Снять выбор</button>
    </div>
    {free === 0 && !showApproved && <p className="pa-scope-hint">Лимит TEST: 30 товаров. Новые допуски сейчас недоступны.</p>}
    {free > 0 && eligible.length > free && <p className="pa-scope-hint">Выбери вручную до {free} товаров.</p>}
    <div className="pa-scope-list">
      {visible.slice(0, limit).map(p => <label key={p.id}>
        <input type="checkbox" checked={approved.has(p.oneCId!) || selected.includes(p.oneCId!)}
          disabled={busy || disabled || !enabled || approved.has(p.oneCId!) || (chosen.length >= free && !selected.includes(p.oneCId!))}
          onChange={e => setSelected(ids => e.target.checked ? [...ids, p.oneCId!] : ids.filter(id => id !== p.oneCId))}/>
        <span>{p.name}<small>{p.category.name.split(' / ').at(-1)}</small></span>
      </label>)}
      {!visible.length && <p>Нет товаров по этому запросу.</p>}
    </div>
    {visible.length > limit && <button className="pa-action pa-secondary" type="button" disabled={busy || disabled} onClick={() => setLimit(n => n + 40)}>Показать ещё</button>}
    <button className="pa-action pa-primary" type="button" disabled={busy || disabled || !enabled || !chosen.length || chosen.length > free} onClick={() => void add()}>
      {busy ? 'Сохраняем…' : 'Разрешить обмен (' + chosen.length + ')'}
    </button>
    {error && <p className="pa-error" role="alert">{error}</p>}
    {notice && <p className="pa-message" role="status">{notice}</p>}
  </section>
}
