import { useEffect, useMemo, useState, type CSSProperties, type DragEvent } from 'react'
import { api, type StorefrontLayoutState } from './api'
import { defaultStorefrontLayout, normalizeStorefrontLayout, type StorefrontBlock, type StorefrontBlockType, type StorefrontBlockWidth } from './page-layout'
import './page-builder.css'

const definitions: Array<{ type: StorefrontBlockType; label: string; hint: string; mark: string }> = [
  { type: 'promo', label: 'Реклама', hint: 'Акционный слайдер', mark: '▰' },
  { type: 'collections', label: 'Разделы', hint: 'Категории магазина', mark: '▦' },
  { type: 'products', label: 'Товары', hint: 'Популярные позиции', mark: '◇' },
  { type: 'smartphones', label: 'Смартфоны', hint: 'Большой вход в раздел', mark: '◫' },
  { type: 'text', label: 'Текст', hint: 'Заголовок и описание', mark: 'T' },
]

const labels = Object.fromEntries(definitions.map((item) => [item.type, item])) as Record<StorefrontBlockType, typeof definitions[number]>
const widths: Array<{ value: StorefrontBlockWidth; label: string }> = [
  { value: 12, label: 'На всю' }, { value: 8, label: '⅔' }, { value: 6, label: '½' }, { value: 4, label: '⅓' },
]
const cloneBlocks = (blocks: StorefrontBlock[]) => blocks.map((block) => ({ ...block }))
const blockId = (type: StorefrontBlockType) => `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const freshBlock = (type: StorefrontBlockType): StorefrontBlock => ({
  id: blockId(type), type, width: 12, visible: true,
  title: type === 'text' ? 'Новый заголовок' : labels[type].label,
  eyebrow: type === 'text' ? 'TEXHORU' : '',
  body: type === 'text' ? 'Добавьте короткий и понятный текст для покупателей.' : '',
  ctaLabel: type === 'text' ? 'Перейти в каталог' : '',
  category: '',
})

function BlockPreview({ block }: { block: StorefrontBlock }) {
  if (block.type === 'promo') return <div className="page-builder-mock page-builder-mock--promo"><span>Акция</span><b>Ваш рекламный слайдер</b><i /></div>
  if (block.type === 'collections') return <div className="page-builder-mock page-builder-mock--collections"><strong>{block.title || 'Категории'}</strong><div>{[1,2,3,4].map((item) => <i key={item} />)}</div></div>
  if (block.type === 'products') return <div className="page-builder-mock page-builder-mock--products"><strong>{block.title || 'Популярные товары'}</strong><div>{[1,2,3,4].map((item) => <i key={item} />)}</div></div>
  if (block.type === 'smartphones') return <div className="page-builder-mock page-builder-mock--phone"><span>Каталог</span><b>Смартфоны</b><i>→</i></div>
  return <div className="page-builder-mock page-builder-mock--text"><span>{block.eyebrow || 'TEXHORU'}</span><b>{block.title || 'Новый заголовок'}</b><p>{block.body || 'Текст для покупателей'}</p></div>
}

export function PageBuilder({ onEditPromos }: { onEditPromos?: () => void }) {
  const [blocks, setBlocks] = useState<StorefrontBlock[]>(() => defaultStorefrontLayout().blocks)
  const [savedBlocks, setSavedBlocks] = useState<StorefrontBlock[]>(() => defaultStorefrontLayout().blocks)
  const [selectedId, setSelectedId] = useState('home-collections')
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop')
  const [past, setPast] = useState<StorefrontBlock[][]>([])
  const [future, setFuture] = useState<StorefrontBlock[][]>([])
  const [draggingId, setDraggingId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [publishedAt, setPublishedAt] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api.adminStorefrontLayout().then((state) => {
      if (!active) return
      const draft = normalizeStorefrontLayout(state.draft)
      setBlocks(cloneBlocks(draft.blocks)); setSavedBlocks(cloneBlocks(draft.blocks)); setPublishedAt(state.publishedAt)
      setSelectedId(draft.blocks[0]?.id || '')
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Не удалось открыть макет') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const selected = blocks.find((block) => block.id === selectedId) || null
  const dirty = useMemo(() => JSON.stringify(blocks) !== JSON.stringify(savedBlocks), [blocks, savedBlocks])
  const mutate = (change: (current: StorefrontBlock[]) => StorefrontBlock[]) => {
    setBlocks((current) => {
      const next = change(cloneBlocks(current))
      if (JSON.stringify(next) === JSON.stringify(current)) return current
      setPast((items) => [...items.slice(-29), cloneBlocks(current)])
      setFuture([]); setNotice('')
      return next
    })
  }
  const updateSelected = (patch: Partial<StorefrontBlock>) => selected && mutate((items) => items.map((item) => item.id === selected.id ? { ...item, ...patch } : item))
  const addBlock = (type: StorefrontBlockType) => {
    const block = freshBlock(type)
    mutate((items) => [...items, block]); setSelectedId(block.id)
  }
  const removeSelected = () => {
    if (!selected || blocks.length === 1) return
    const index = blocks.findIndex((item) => item.id === selected.id)
    const remaining = blocks.filter((item) => item.id !== selected.id)
    mutate((items) => items.filter((item) => item.id !== selected.id))
    setSelectedId(remaining[Math.min(index, remaining.length - 1)]?.id || '')
  }
  const duplicateSelected = () => {
    if (!selected) return
    const duplicate = { ...selected, id: blockId(selected.type), title: selected.title ? `${selected.title} — копия` : selected.title }
    mutate((items) => { const index = items.findIndex((item) => item.id === selected.id); items.splice(index + 1, 0, duplicate); return items })
    setSelectedId(duplicate.id)
  }
  const move = (id: string, delta: number) => mutate((items) => {
    const index = items.findIndex((item) => item.id === id), target = index + delta
    if (index < 0 || target < 0 || target >= items.length) return items
    const [item] = items.splice(index, 1); items.splice(target, 0, item); return items
  })
  const dropBefore = (event: DragEvent, targetId: string) => {
    event.preventDefault()
    const sourceId = event.dataTransfer.getData('text/plain') || draggingId
    setDraggingId('')
    if (!sourceId || sourceId === targetId) return
    mutate((items) => {
      const sourceIndex = items.findIndex((item) => item.id === sourceId)
      const targetIndex = items.findIndex((item) => item.id === targetId)
      if (sourceIndex < 0 || targetIndex < 0) return items
      const [item] = items.splice(sourceIndex, 1)
      items.splice(sourceIndex < targetIndex ? targetIndex - 1 : targetIndex, 0, item)
      return items
    })
  }
  const undo = () => {
    const previous = past.at(-1); if (!previous) return
    setFuture((items) => [cloneBlocks(blocks), ...items].slice(0, 30)); setBlocks(cloneBlocks(previous)); setPast((items) => items.slice(0, -1)); setNotice('')
  }
  const redo = () => {
    const next = future[0]; if (!next) return
    setPast((items) => [...items, cloneBlocks(blocks)].slice(-30)); setBlocks(cloneBlocks(next)); setFuture((items) => items.slice(1)); setNotice('')
  }
  const save = async () => {
    setSaving(true); setError(''); setNotice('')
    try {
      const state = await api.saveStorefrontDraft({ version: 1, blocks })
      const draft = normalizeStorefrontLayout(state.draft)
      setBlocks(cloneBlocks(draft.blocks)); setSavedBlocks(cloneBlocks(draft.blocks)); setNotice('Черновик сохранён')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить') }
    finally { setSaving(false) }
  }
  const publish = async () => {
    setPublishing(true); setError(''); setNotice('')
    try {
      const state: StorefrontLayoutState = await api.publishStorefrontLayout({ version: 1, blocks })
      const draft = normalizeStorefrontLayout(state.draft)
      setBlocks(cloneBlocks(draft.blocks)); setSavedBlocks(cloneBlocks(draft.blocks)); setPublishedAt(state.publishedAt); setNotice('Изменения опубликованы на сайте')
      window.dispatchEvent(new Event('texhoru:layout-changed'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось опубликовать') }
    finally { setPublishing(false) }
  }

  if (loading) return <div className="page-builder-loading">Открываем редактор страницы…</div>

  return <section className="page-builder" aria-label="Редактор главной страницы">
    <header className="page-builder__topbar">
      <div><span className="page-builder__kicker">Главная страница</span><h2>Редактор витрины</h2></div>
      <div className="page-builder__history"><button type="button" onClick={undo} disabled={!past.length} aria-label="Отменить">↶</button><button type="button" onClick={redo} disabled={!future.length} aria-label="Повторить">↷</button></div>
      <div className="page-builder__devices" aria-label="Размер предпросмотра">{(['desktop','tablet','mobile'] as const).map((item) => <button type="button" key={item} className={device === item ? 'active' : ''} onClick={() => setDevice(item)} aria-label={item === 'desktop' ? 'Компьютер' : item === 'tablet' ? 'Планшет' : 'Телефон'}>{item === 'desktop' ? '▱' : item === 'tablet' ? '▯' : '▯'}</button>)}</div>
      <div className="page-builder__actions"><span className={dirty ? 'is-dirty' : ''}>{dirty ? 'Есть изменения' : publishedAt ? 'Всё сохранено' : 'Ещё не опубликовано'}</span><button type="button" onClick={save} disabled={saving || publishing || !dirty}>{saving ? 'Сохраняем…' : 'Сохранить'}</button><button type="button" className="primary" onClick={publish} disabled={saving || publishing}>{publishing ? 'Публикуем…' : 'Опубликовать'}</button></div>
    </header>
    {(notice || error) && <div className={error ? 'page-builder__message is-error' : 'page-builder__message'} role={error ? 'alert' : 'status'}>{error || notice}</div>}
    <div className="page-builder__workspace">
      <aside className="page-builder__library">
        <div><strong>Блоки</strong><span>Нажмите, чтобы добавить</span></div>
        <div className="page-builder__palette">{definitions.map((item) => <button type="button" key={item.type} onClick={() => addBlock(item.type)}><i>{item.mark}</i><span><strong>{item.label}</strong><small>{item.hint}</small></span><b>+</b></button>)}</div>
        <div className="page-builder__tip"><span>12 колонок</span><p>Ставьте два блока шириной ½ рядом — они автоматически образуют одну строку.</p></div>
      </aside>

      <div className="page-builder__stage">
        <div className={`page-builder__viewport is-${device}`}>
          <div className="page-builder__browser"><i /><i /><i /><span>технору.com</span></div>
          <div className="page-builder__canvas">{blocks.map((block, index) => <article
            key={block.id} draggable onDragStart={(event) => { setDraggingId(block.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', block.id) }}
            onDragEnd={() => setDraggingId('')} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }} onDrop={(event) => dropBefore(event, block.id)}
            onClick={() => setSelectedId(block.id)} style={{ '--block-span': block.width } as CSSProperties}
            className={`page-builder__block${selectedId === block.id ? ' is-selected' : ''}${block.visible ? '' : ' is-hidden'}${draggingId === block.id ? ' is-dragging' : ''}`}>
            <div className="page-builder__blockbar"><button type="button" className="page-builder__grab" aria-label="Перетащить блок">⠿</button><span>{index + 1} · {labels[block.type].label}</span><small>{block.width === 12 ? '100%' : block.width === 8 ? '66%' : block.width === 6 ? '50%' : '33%'}</small><button type="button" onClick={(event) => { event.stopPropagation(); move(block.id, -1) }} disabled={!index} aria-label="Выше">↑</button><button type="button" onClick={(event) => { event.stopPropagation(); move(block.id, 1) }} disabled={index === blocks.length - 1} aria-label="Ниже">↓</button></div>
            <BlockPreview block={block} />
          </article>)}</div>
        </div>
      </div>

      <aside className="page-builder__inspector">
        {selected ? <>
          <div className="page-builder__inspector-head"><div><span>Настройки блока</span><strong>{labels[selected.type].label}</strong></div><button type="button" onClick={() => updateSelected({ visible: !selected.visible })}>{selected.visible ? 'Скрыть' : 'Показать'}</button></div>
          <label className="page-builder__field"><span>Название</span><input value={selected.title || ''} onChange={(event) => updateSelected({ title: event.target.value })} /></label>
          {selected.type === 'text' && <>
            <label className="page-builder__field"><span>Надзаголовок</span><input value={selected.eyebrow || ''} onChange={(event) => updateSelected({ eyebrow: event.target.value })} /></label>
            <label className="page-builder__field"><span>Описание</span><textarea rows={4} value={selected.body || ''} onChange={(event) => updateSelected({ body: event.target.value })} /></label>
            <label className="page-builder__field"><span>Текст кнопки</span><input value={selected.ctaLabel || ''} onChange={(event) => updateSelected({ ctaLabel: event.target.value })} /></label>
          </>}
          <div className="page-builder__field"><span>Ширина</span><div className="page-builder__widths">{widths.map((item) => <button type="button" key={item.value} className={selected.width === item.value ? 'active' : ''} onClick={() => updateSelected({ width: item.value })}>{item.label}</button>)}</div><small>На телефоне блок всегда занимает всю ширину.</small></div>
          {selected.type === 'promo' && <button type="button" className="page-builder__secondary" onClick={onEditPromos}>Настроить рекламные слайды</button>}
          <div className="page-builder__inspector-actions"><button type="button" onClick={duplicateSelected}>Дублировать</button><button type="button" className="danger" onClick={removeSelected} disabled={blocks.length === 1}>Удалить</button></div>
        </> : <p>Выберите блок на холсте.</p>}
      </aside>
    </div>
  </section>
}
