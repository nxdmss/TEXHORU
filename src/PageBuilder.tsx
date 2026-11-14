import { useEffect, useMemo, useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react'
import { api, type PromoBanner, type StorefrontLayoutState } from './api'
import { defaultStorefrontLayout, normalizeStorefrontLayout, type StorefrontBlock, type StorefrontBlockType, type StorefrontBlockWidth, type StorefrontDevice, type StorefrontLayout } from './page-layout'
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
const cloneLayout = (layout: StorefrontLayout): StorefrontLayout => ({
  version: 2,
  devices: {
    desktop: cloneBlocks(layout.devices.desktop),
    tablet: cloneBlocks(layout.devices.tablet),
    mobile: cloneBlocks(layout.devices.mobile),
  },
})
const deviceLabels: Record<StorefrontDevice, { label: string; hint: string }> = {
  desktop: { label: 'Компьютер', hint: 'Широкая версия' },
  tablet: { label: 'Планшет', hint: 'Средний экран' },
  mobile: { label: 'Телефон', hint: 'Отдельная мобильная версия' },
}
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
  if (block.type === 'collections') return <div className="page-builder-mock page-builder-mock--collections"><strong>{block.title || 'Категории'}</strong><div>{[1,2,3,4].map((item) => <i key={item} />)}</div></div>
  if (block.type === 'products') return <div className="page-builder-mock page-builder-mock--products"><strong>{block.title || 'Популярные товары'}</strong><div>{[1,2,3,4].map((item) => <i key={item} />)}</div></div>
  if (block.type === 'smartphones') return <div className="page-builder-mock page-builder-mock--phone"><span>Каталог</span><b>Смартфоны</b><i>→</i></div>
  return <div className="page-builder-mock page-builder-mock--text"><span>{block.eyebrow || 'TEXHORU'}</span><b>{block.title || 'Новый заголовок'}</b><p>{block.body || 'Текст для покупателей'}</p></div>
}

const inlinePromoFrame = (value: string) => {
  const marker = '#txframe=', markerIndex = value.lastIndexOf(marker)
  if (markerIndex < 0) return { src: value, x: 50, y: 50, zoom: 1 }
  const [x, y, zoom] = value.slice(markerIndex + marker.length).split(',').map(Number)
  return {
    src: value.slice(0, markerIndex),
    x: Number.isFinite(x) ? x : 50,
    y: Number.isFinite(y) ? y : 50,
    zoom: Number.isFinite(zoom) ? zoom : 1,
  }
}

const inlinePromoStyle = (image: string): CSSProperties => {
  const frame = inlinePromoFrame(image)
  return { objectPosition: `${frame.x}% ${frame.y}%`, transform: `scale(${frame.zoom})` }
}

type PageBuilderProps = {
  promos: PromoBanner[]
  onCreatePromo: (blockId: string, device: StorefrontDevice) => void
  onEditPromo: (promo: PromoBanner, device: StorefrontDevice) => void
  onTogglePromo: (promo: PromoBanner) => void
  onDeletePromo: (promo: PromoBanner) => void
}

const promoImageForDevice = (promo: PromoBanner, device: StorefrontDevice) => device === 'mobile'
  ? promo.imageMobile || promo.imageTablet || promo.image
  : device === 'tablet' ? promo.imageTablet || promo.image : promo.image

function PromoBlockPreview({ promos, onManage, device }: {
  promos: PromoBanner[]
  onManage: () => void
  device: StorefrontDevice
}) {
  const slides = [...promos].sort((a, b) => a.sortOrder - b.sortOrder)
  const featured = slides.find((item) => item.isActive) || slides[0]
  const manage = (event: MouseEvent) => { event.stopPropagation(); onManage() }
  return <div className="page-builder-promo" onDragStart={(event) => event.stopPropagation()}>
    <div className={featured ? 'page-builder-promo__hero' : 'page-builder-promo__hero is-empty'}>
      {featured ? <>
        <img src={inlinePromoFrame(promoImageForDevice(featured, device)).src} style={inlinePromoStyle(promoImageForDevice(featured, device))} alt="" draggable={false} />
        <div className="page-builder-promo__shade" />
        <div className="page-builder-promo__copy"><span>{featured.kicker || 'Реклама'}</span><strong>{featured.title || 'Рекламный баннер'}</strong><small>{slides.length} {slides.length === 1 ? 'слайд' : 'слайдов'} в этом блоке</small></div>
        <button type="button" className="page-builder-promo__edit" onClick={manage}>Редактировать баннер</button>
      </> : <button type="button" className="page-builder-promo__empty" onClick={manage}><b>＋</b><strong>Настроить рекламный блок</strong><span>У этого блока будет собственный набор фото</span></button>}
    </div>
  </div>
}

export function PageBuilder({ promos, onCreatePromo, onEditPromo, onTogglePromo, onDeletePromo }: PageBuilderProps) {
  const [layout, setLayout] = useState<StorefrontLayout>(() => defaultStorefrontLayout())
  const [savedLayout, setSavedLayout] = useState<StorefrontLayout>(() => defaultStorefrontLayout())
  const [selectedId, setSelectedId] = useState('home-collections')
  const [device, setDevice] = useState<StorefrontDevice>('desktop')
  const [past, setPast] = useState<StorefrontLayout[]>([])
  const [future, setFuture] = useState<StorefrontLayout[]>([])
  const [draggingId, setDraggingId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [publishedAt, setPublishedAt] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [promoManagerBlockId, setPromoManagerBlockId] = useState('')

  useEffect(() => {
    let active = true
    api.adminStorefrontLayout().then((state) => {
      if (!active) return
      const draft = normalizeStorefrontLayout(state.draft)
      setLayout(cloneLayout(draft)); setSavedLayout(cloneLayout(draft)); setPublishedAt(state.publishedAt)
      setSelectedId(draft.devices.desktop[0]?.id || '')
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Не удалось открыть макет') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!expanded) return
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !promoManagerBlockId) setExpanded(false) }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [expanded, promoManagerBlockId])

  useEffect(() => {
    if (!promoManagerBlockId) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPromoManagerBlockId('') }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [promoManagerBlockId])

  const blocks = layout.devices[device]
  const selected = blocks.find((block) => block.id === selectedId) || null
  const promoManagerBlock = blocks.find((block) => block.id === promoManagerBlockId && block.type === 'promo') || null
  const promoManagerItems = useMemo(() => promos.filter((item) => item.blockId === promoManagerBlockId).sort((a, b) => a.sortOrder - b.sortOrder), [promos, promoManagerBlockId])
  const dirty = useMemo(() => JSON.stringify(layout) !== JSON.stringify(savedLayout), [layout, savedLayout])
  const mutate = (change: (current: StorefrontBlock[]) => StorefrontBlock[]) => {
    setLayout((current) => {
      const currentBlocks = current.devices[device]
      const next = change(cloneBlocks(currentBlocks))
      if (JSON.stringify(next) === JSON.stringify(currentBlocks)) return current
      setPast((items) => [...items.slice(-29), cloneLayout(current)])
      setFuture([]); setNotice('')
      return { version: 2, devices: { ...current.devices, [device]: next } }
    })
  }
  const selectDevice = (nextDevice: StorefrontDevice) => {
    setDevice(nextDevice)
    setSelectedId(layout.devices[nextDevice][0]?.id || '')
    setPromoManagerBlockId('')
  }
  const copyDesktopToCurrent = () => {
    if (device === 'desktop') return
    mutate(() => cloneBlocks(layout.devices.desktop))
    setSelectedId(layout.devices.desktop[0]?.id || '')
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
    if (promoManagerBlockId === selected.id) setPromoManagerBlockId('')
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
    setFuture((items) => [cloneLayout(layout), ...items].slice(0, 30)); setLayout(cloneLayout(previous)); setPast((items) => items.slice(0, -1)); setNotice('')
    setSelectedId(previous.devices[device][0]?.id || '')
  }
  const redo = () => {
    const next = future[0]; if (!next) return
    setPast((items) => [...items, cloneLayout(layout)].slice(-30)); setLayout(cloneLayout(next)); setFuture((items) => items.slice(1)); setNotice('')
    setSelectedId(next.devices[device][0]?.id || '')
  }
  const save = async () => {
    setSaving(true); setError(''); setNotice('')
    try {
      const state = await api.saveStorefrontDraft(layout)
      const draft = normalizeStorefrontLayout(state.draft)
      setLayout(cloneLayout(draft)); setSavedLayout(cloneLayout(draft)); setNotice('Три версии сохранены в черновик')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить') }
    finally { setSaving(false) }
  }
  const publish = async () => {
    setPublishing(true); setError(''); setNotice('')
    try {
      const state: StorefrontLayoutState = await api.publishStorefrontLayout(layout)
      const draft = normalizeStorefrontLayout(state.draft)
      setLayout(cloneLayout(draft)); setSavedLayout(cloneLayout(draft)); setPublishedAt(state.publishedAt); setNotice('Компьютерная, планшетная и мобильная версии опубликованы')
      window.dispatchEvent(new Event('texhoru:layout-changed'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось опубликовать') }
    finally { setPublishing(false) }
  }

  if (loading) return <div className="page-builder-loading">Открываем редактор страницы…</div>

  return <section className={`page-builder${expanded ? ' is-expanded' : ''}`} aria-label="Редактор главной страницы">
    <header className="page-builder__topbar">
      <div><span className="page-builder__kicker">Главная страница</span><h2>Редактор витрины</h2></div>
      <div className="page-builder__history"><button type="button" onClick={undo} disabled={!past.length} aria-label="Отменить">↶</button><button type="button" onClick={redo} disabled={!future.length} aria-label="Повторить">↷</button></div>
      <div className="page-builder__devices" aria-label="Независимые версии страницы">{(['desktop','tablet','mobile'] as const).map((item) => <button type="button" key={item} className={device === item ? 'active' : ''} onClick={() => selectDevice(item)} aria-pressed={device === item}><b>{item === 'desktop' ? '▱' : item === 'tablet' ? '▯' : '▯'}</b><span>{deviceLabels[item].label}</span><small>{layout.devices[item].length}</small></button>)}</div>
      <div className="page-builder__actions"><button type="button" className="page-builder__expand" onClick={() => setExpanded((value) => !value)} aria-pressed={expanded}>{expanded ? 'Свернуть' : 'На весь экран'} <b aria-hidden="true">{expanded ? '×' : '⛶'}</b></button><span className={dirty ? 'is-dirty' : ''}>{dirty ? 'Есть изменения' : publishedAt ? 'Всё сохранено' : 'Ещё не опубликовано'}</span><button type="button" onClick={save} disabled={saving || publishing || !dirty}>{saving ? 'Сохраняем…' : 'Сохранить'}</button><button type="button" className="primary" onClick={publish} disabled={saving || publishing}>{publishing ? 'Публикуем…' : 'Опубликовать'}</button></div>
    </header>
    {(notice || error) && <div className={error ? 'page-builder__message is-error' : 'page-builder__message'} role={error ? 'alert' : 'status'}>{error || notice}</div>}
    <div className="page-builder__workspace">
      <aside className="page-builder__library">
        <div><strong>Блоки · {deviceLabels[device].label}</strong><span>{deviceLabels[device].hint}</span></div>
        <div className="page-builder__palette">{definitions.map((item) => <button type="button" key={item.type} onClick={() => addBlock(item.type)}><i>{item.mark}</i><span><strong>{item.label}</strong><small>{item.hint}</small></span><b>+</b></button>)}</div>
        {device !== 'desktop' && <button type="button" className="page-builder__copy-layout" onClick={copyDesktopToCurrent}>Скопировать макет компьютера</button>}
        <div className="page-builder__tip"><span>Независимый холст</span><p>Порядок, размеры и видимость меняются только для {device === 'desktop' ? 'компьютера' : device === 'tablet' ? 'планшета' : 'телефона'}.</p></div>
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
            {block.type === 'promo'
              ? <PromoBlockPreview device={device} promos={promos.filter((item) => item.blockId === block.id)} onManage={() => setPromoManagerBlockId(block.id)} />
              : <BlockPreview block={block} />}
          </article>)}</div>
        </div>
      </div>

      <aside className="page-builder__inspector">
        {selected ? <>
          <div className="page-builder__inspector-head"><div><span>{deviceLabels[device].label} · настройки</span><strong>{labels[selected.type].label}</strong></div><button type="button" onClick={() => updateSelected({ visible: !selected.visible })}>{selected.visible ? 'Скрыть здесь' : 'Показать здесь'}</button></div>
          <label className="page-builder__field"><span>Название</span><input value={selected.title || ''} onChange={(event) => updateSelected({ title: event.target.value })} /></label>
          {selected.type === 'text' && <>
            <label className="page-builder__field"><span>Надзаголовок</span><input value={selected.eyebrow || ''} onChange={(event) => updateSelected({ eyebrow: event.target.value })} /></label>
            <label className="page-builder__field"><span>Описание</span><textarea rows={4} value={selected.body || ''} onChange={(event) => updateSelected({ body: event.target.value })} /></label>
            <label className="page-builder__field"><span>Текст кнопки</span><input value={selected.ctaLabel || ''} onChange={(event) => updateSelected({ ctaLabel: event.target.value })} /></label>
          </>}
          <div className="page-builder__field"><span>Ширина в версии «{deviceLabels[device].label}»</span><div className="page-builder__widths">{widths.map((item) => <button type="button" key={item.value} className={selected.width === item.value ? 'active' : ''} onClick={() => updateSelected({ width: item.value })}>{item.label}</button>)}</div><small>Настройка не меняет остальные устройства.</small></div>
          {selected.type === 'promo' && <button type="button" className="page-builder__secondary" onClick={() => setPromoManagerBlockId(selected.id)}>Баннеры для «{deviceLabels[device].label}» · {promos.filter((item) => item.blockId === selected.id).length}</button>}
          <div className="page-builder__inspector-actions"><button type="button" onClick={duplicateSelected}>Дублировать здесь</button><button type="button" className="danger" onClick={removeSelected} disabled={blocks.length === 1}>Убрать отсюда</button></div>
        </> : <p>Выберите блок на холсте.</p>}
      </aside>
    </div>
    {promoManagerBlock && <div className="page-builder-promo-modal" onMouseDown={(event) => { if (event.currentTarget === event.target) setPromoManagerBlockId('') }}>
      <section className="page-builder-promo-dialog" role="dialog" aria-modal="true" aria-label={`Фотографии блока ${promoManagerBlock.title || 'Реклама'}`}>
        <header><div><span>Реклама · {deviceLabels[device].label}</span><h3>{promoManagerBlock.title || 'Реклама'}</h3><p>{promoManagerItems.length ? `${promoManagerItems.length} слайдов · у каждого отдельные изображения для трёх экранов` : 'Добавьте первый слайд и загрузите отдельные версии изображений'}</p></div><button type="button" onClick={() => setPromoManagerBlockId('')} aria-label="Закрыть">×</button></header>
        <div className="page-builder-promo-dialog__actions"><button type="button" onClick={() => onCreatePromo(promoManagerBlock.id, device)}>+ Добавить слайд</button><span>Сейчас редактируется версия «{deviceLabels[device].label}».</span></div>
        {promoManagerItems.length ? <div className="page-builder-promo-dialog__grid">{promoManagerItems.map((item, index) => <article className={item.isActive ? '' : 'is-hidden'} key={item.id}>
          <button type="button" className={`page-builder-promo-dialog__image is-${device}`} onClick={() => onEditPromo(item, device)} aria-label={`Редактировать фото ${index + 1}`}><img src={inlinePromoFrame(promoImageForDevice(item, device)).src} style={inlinePromoStyle(promoImageForDevice(item, device))} alt="" /><b>{index + 1}</b>{!item.isActive && <em>Скрыто</em>}</button>
          <div><strong>{item.title || `Фото ${index + 1}`}</strong><span>Порядок: {item.sortOrder}</span></div>
          <footer><button type="button" onClick={() => onEditPromo(item, device)}>Изменить</button><button type="button" onClick={() => onTogglePromo(item)}>{item.isActive ? 'Скрыть' : 'Показать'}</button><button type="button" className="danger" onClick={() => onDeletePromo(item)}>Удалить везде</button></footer>
        </article>)}</div> : <div className="page-builder-promo-dialog__empty"><b>▰</b><strong>В этом блоке ещё нет слайдов</strong><span>Добавьте слайд, затем загрузите изображения отдельно для компьютера, планшета и телефона.</span><button type="button" onClick={() => onCreatePromo(promoManagerBlock.id, device)}>Добавить первый слайд</button></div>}
      </section>
    </div>}
  </section>
}
