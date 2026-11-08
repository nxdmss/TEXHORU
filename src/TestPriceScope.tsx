import { useEffect, useMemo, useState } from 'react'
import { api, type ApiProduct, type OneCPriceSyncStatus } from './api'

export function TestPriceScope({ products, scope, enabled, path, onChanged }: {
  products: ApiProduct[]; scope: OneCPriceSyncStatus['scope']; enabled: boolean;
  path: string; onChanged: () => Promise<unknown>;
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(40)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => { setSelected([]); setSearch(''); setLimit(40); setNotice(''); setError('') }, [path])
  const approved = useMemo(() => new Set(scope.map(p => p.oneCId)), [scope])
  const free = Math.max(0, 30 - scope.length)
  const available = products.filter(p => p.oneCId && p.status === 'ACTIVE' && p.price > 0 && p.price <= 5_000_000
    && (!path || p.category.name === path || p.category.name.startsWith(path + ' / ')))
  const visible = available.filter(p => (p.name + ' ' + p.sku).toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')))
  const chosen = available.filter(p => selected.includes(p.oneCId!) && !approved.has(p.oneCId!))
  const eligible = visible.filter(p => !approved.has(p.oneCId!))
  async function add() {
    if (!chosen.length || chosen.length > free || busy || !enabled) return
    if (!window.confirm('Разрешить передачу цен для ' + chosen.length + ' товаров в TEST 1С?\n\n'
      + chosen.map(p => p.name).join('\n') + '\n\nЭто только допуск. Цены отправляются отдельно после выбора предложений.')) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.addTestPriceScope(chosen.map(p => p.oneCId!))
      setSelected([])
      setNotice(`Добавлено в TEST: ${result.added}. Всего разрешено ${result.count} из 30. Теперь проверь доступные предложения ниже.`)
      await onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось разрешить товары для TEST') }
    finally { setBusy(false) }
  }
  return <details className="pa-scope">
    <summary>Товары для обмена с TEST 1С: {scope.length} из 30 — выбрать товары</summary>
    <p>Разреши выбранные товары из каталога 1С. Уже разрешённые сохранятся. Затем отдельно выбери цены для отправки.</p>
    {!enabled && <p role="alert">Передача цен в TEST выключена на сервере. Добавление товаров сейчас недоступно.</p>}
    <p>{path ? 'Раздел: ' + path : 'Все разделы'} · Свободных мест: {free}</p>
    <input className="pa-search" aria-label="Найти товар для TEST" placeholder="Название или артикул" value={search}
      onChange={e => { setSearch(e.target.value); setLimit(40) }} />
    <div className="pa-scope-actions">
      <button className="pa-action pa-secondary" type="button" disabled={busy || !enabled || !eligible.length || eligible.length > free}
        onClick={() => setSelected(eligible.map(p => p.oneCId!))}>Выбрать найденные ({eligible.length})</button>
      <button className="pa-action pa-secondary" type="button" disabled={busy || !selected.length} onClick={() => setSelected([])}>Снять выбор</button>
    </div>
    {eligible.length > free && <p>Найдено больше товаров, чем свободных мест. Уточни поиск или отметь нужные вручную.</p>}
    <div className="pa-scope-list">
      {visible.slice(0, limit).map(p => <label key={p.id}>
        <input type="checkbox" checked={approved.has(p.oneCId!) || selected.includes(p.oneCId!)}
          disabled={busy || !enabled || approved.has(p.oneCId!) || (chosen.length >= free && !selected.includes(p.oneCId!))}
          onChange={e => setSelected(ids => e.target.checked ? [...ids, p.oneCId!] : ids.filter(id => id !== p.oneCId))}/>
        <span>{p.name}{approved.has(p.oneCId!) && <small>Уже разрешён</small>}</span>
      </label>)}
      {!visible.length && <p>Товары из 1С по этому запросу не найдены.</p>}
    </div>
    {visible.length > limit && <button className="pa-action pa-secondary" type="button" onClick={() => setLimit(n => n + 40)}>Показать ещё</button>}
    <button className="pa-action pa-primary" type="button" disabled={busy || !enabled || !chosen.length || chosen.length > free} onClick={() => void add()}>
      {busy ? 'Сохраняем…' : 'Разрешить выбранные для TEST (' + chosen.length + ')'}
    </button>
    {error && <p className="pa-error" role="alert">{error}</p>}
    {notice && <p className="pa-message" role="status">{notice}</p>}
  </details>
}
