import { FormEvent, type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, useEffect, useMemo, useRef, useState } from 'react'
import { api, API_URL, type ApiCategory, type ApiProduct, type PriceMonitorItem, type PromoBanner, type TrackedOrder } from './api'
import { activeOrders, categories, orderHistory, products as fallbackProducts } from './data'
import type { AccountOrder, CartLine, Category, Product } from './types'

const money = new Intl.NumberFormat('ru-RU')
type AccountTab = 'active' | 'history' | 'profile'
type AdminTab = 'overview' | 'products' | 'content' | 'prices' | 'orders' | 'notifications' | 'sync' | 'audit'
type CreatedOrder = { number: number; trackingToken: string; paymentMethod: 'ONLINE' | 'ON_RECEIPT' }

const defaultPromos: PromoBanner[] = [
  { id: 'fallback-new', kicker: 'НОВИНКА', title: 'iPhone 18 Pro', body: 'Новая Pro-линейка Apple. Большой акцент на камеру, производительность и автономность.', ctaLabel: 'Смотреть смартфоны', category: 'Смартфоны', image: '/products/phone.svg', tone: 'light', sortOrder: 0, isActive: true },
  { id: 'fallback-sale', kicker: 'АКЦИИ', title: 'Телевизоры выгоднее', body: 'Подборка моделей со сниженной ценой и предложениями на большие диагонали.', ctaLabel: 'Перейти к акции', category: 'Телевизоры', image: '/products/tv.svg', tone: 'dark', sortOrder: 1, isActive: true },
  { id: 'fallback-installment', kicker: 'РАССРОЧКА', title: 'Ноутбук сейчас. Платёж потом.', body: 'MacBook и Windows-ноутбуки в одной подборке без лишних переходов.', ctaLabel: 'Выбрать ноутбук', category: 'Ноутбуки', image: '/products/laptop.svg', tone: 'red', sortOrder: 2, isActive: true },
  { id: 'fallback-audio', kicker: 'АУДИО', title: 'Sony WH-1000XM5', body: 'Наушники и портативное аудио.', ctaLabel: 'Смотреть аудио', category: 'Аудио', image: '/products/headphones.svg', tone: 'dark', sortOrder: 3, isActive: true },
  { id: 'fallback-home', kicker: 'ДЛЯ ДОМА', title: 'Dyson V12 Detect Slim', body: 'Техника для дома и уборки.', ctaLabel: 'Смотреть для дома', category: 'Для дома', image: '/products/vacuum.svg', tone: 'light', sortOrder: 4, isActive: true },
]

const statusLabels: Record<string, string> = {
  NEW: 'Заказ создан', AWAITING_PAYMENT: 'Ожидает оплаты', PAID: 'Оплачен', ASSEMBLING: 'Собирается', READY: 'Готов к выдаче', DELIVERING: 'В доставке', COMPLETED: 'Получен', CANCELLED: 'Отменён',
}
const paymentLabels: Record<string, string> = { NOT_STARTED: 'Не начата', PENDING: 'В процессе', PAID: 'Оплачено', FAILED: 'Ошибка', REFUNDED: 'Возврат' }

function Icon({ name }: { name: 'search' | 'cart' | 'arrow' | 'close' | 'minus' | 'plus' | 'user' | 'box' | 'back' | 'menu' | 'chevronLeft' | 'chevronRight' }) {
  const paths = {
    search: <><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
    cart: <><path d="M3.5 5h2l1.8 9.2h9.6l2-6.3H6.2"/><circle cx="9" cy="18.5" r="1"/><circle cx="16.5" cy="18.5" r="1"/></>,
    arrow: <><path d="M4 12h15"/><path d="m14 7 5 5-5 5"/></>,
    back: <><path d="M20 12H5"/><path d="m10 7-5 5 5 5"/></>,
    close: <><path d="m5 5 14 14"/><path d="M19 5 5 19"/></>,
    minus: <path d="M5 12h14"/>,
    plus: <><path d="M5 12h14"/><path d="M12 5v14"/></>,
    user: <><circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.8-3.6 4.2-5.4 7-5.4s5.2 1.8 7 5.4"/></>,
    box: <><path d="M4 8.2 12 4l8 4.2v7.6L12 20l-8-4.2z"/><path d="M12 4v16"/><path d="M4 8.2 12 12l8-3.8"/></>,
    menu: <><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></>,
    chevronLeft: <path d="m15 5-7 7 7 7"/>,
    chevronRight: <path d="m9 5 7 7-7 7"/>,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}

function OrderCard({ order }: { order: AccountOrder }) {
  return <article className="order-card">
    <div className="order-card__head"><div><span className="order-card__label">Заказ</span><strong>№ {order.id.replace('T-', '')}</strong><span className="order-card__date">Оформлен {order.date}</span></div><div className={`status-badge status-badge--${order.status === 'Получен' ? 'done' : order.status === 'Отменён' ? 'cancelled' : 'active'}`}>{order.status}</div></div>
    <div className="order-card__section"><span className="order-card__label">Товары</span><p className="order-card__items">{order.items.join(', ')}</p></div>
    <div className="order-card__section"><span className="order-card__label">Получение</span><p className="order-card__delivery">{order.delivery}</p></div>
    <div className="order-card__total"><span>Сумма заказа</span><strong>{money.format(order.total)} ₽</strong></div>
  </article>
}

function ProductCard({ product, onOpen, onAdd }: { product: Product; onOpen: (product: Product) => void; onAdd: (product: Product) => void }) {
  return <article className="product-card">
    <button className="product-open" onClick={() => onOpen(product)} aria-label={`Открыть ${product.name}`}>
      <div className="product-media"><img src={product.image} alt={product.name} /></div>
      <div className="product-card__copy">
        <div className="product-card__title-row">
          <h3>{product.name}</h3>
          {product.badge && <span className="product-card__badge">{product.badge}</span>}
        </div>
        <div className="product-card__price"><strong>{money.format(product.price)} ₽</strong>{product.oldPrice && <del>{money.format(product.oldPrice)} ₽</del>}</div>
      </div>
    </button>
    <button className="product-card__add" onClick={() => onAdd(product)} aria-label={`Добавить ${product.name} в корзину`}><Icon name="plus" /></button>
  </article>
}

function CheckoutPage({ cart, onBack, onCreated }: { cart: CartLine[]; onBack: () => void; onCreated: (order: CreatedOrder) => void }) {
  const [form, setForm] = useState({ customerName: '', customerPhone: '', customerEmail: '', deliveryMethod: 'PICKUP' as 'PICKUP' | 'COURIER', deliveryAddress: 'Кизилюрт, Дагестан', paymentMethod: 'ON_RECEIPT' as 'ONLINE' | 'ON_RECEIPT', comment: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const total = cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0)

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setLoading(true); setError('')
    try {
      const deliveryAddress = form.deliveryMethod === 'PICKUP' ? 'Самовывоз · Кизилюрт' : form.deliveryAddress
      const result = await api.createOrder({ ...form, deliveryAddress, customerEmail: form.customerEmail || undefined, comment: form.comment || undefined, idempotencyKey: crypto.randomUUID(), items: cart.map((item) => ({ productId: item.product.id, quantity: item.quantity })) })
      onCreated({ number: result.number, trackingToken: result.trackingToken, paymentMethod: result.paymentMethod })
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось создать заказ') } finally { setLoading(false) }
  }

  return <section className="checkout-page">
    <button className="back-link" onClick={onBack}><Icon name="back" /> Вернуться к покупкам</button>
    <div className="checkout-layout">
      <form className="checkout-form" onSubmit={submit}>
        <p className="eyebrow">Оформление</p><h1>Ваш заказ</h1>
        <div className="form-grid">
          <label><span>Имя</span><input required value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} placeholder="Умар Мутаев" /></label>
          <label><span>Телефон</span><input required value={form.customerPhone} onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} placeholder="+7 999 000-00-00" /></label>
          <label className="form-grid__wide"><span>Email</span><input type="email" value={form.customerEmail} onChange={(e) => setForm({ ...form, customerEmail: e.target.value })} placeholder="mail@example.com" /></label>
        </div>
        <div className="choice-block"><span className="choice-title">Получение</span><div className="choice-grid"><button type="button" className={form.deliveryMethod === 'PICKUP' ? 'choice-card active' : 'choice-card'} onClick={() => setForm({ ...form, deliveryMethod: 'PICKUP' })}><strong>Самовывоз</strong><span>Кизилюрт</span></button><button type="button" className={form.deliveryMethod === 'COURIER' ? 'choice-card active' : 'choice-card'} onClick={() => setForm({ ...form, deliveryMethod: 'COURIER' })}><strong>Доставка</strong><span>Кизилюрт и Дагестан</span></button></div></div>
        {form.deliveryMethod === 'COURIER' && <label className="checkout-single"><span>Адрес доставки</span><input required value={form.deliveryAddress} onChange={(e) => setForm({ ...form, deliveryAddress: e.target.value })} /></label>}
        <div className="choice-block"><span className="choice-title">Оплата</span><div className="choice-grid"><button type="button" className={form.paymentMethod === 'ON_RECEIPT' ? 'choice-card active' : 'choice-card'} onClick={() => setForm({ ...form, paymentMethod: 'ON_RECEIPT' })}><strong>При получении</strong><span>Карта или наличные</span></button><button type="button" className={form.paymentMethod === 'ONLINE' ? 'choice-card active' : 'choice-card'} onClick={() => setForm({ ...form, paymentMethod: 'ONLINE' })}><strong>Онлайн</strong><span>Через платёжного провайдера</span></button></div></div>
        <label className="checkout-single"><span>Комментарий</span><textarea value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} placeholder="Необязательно" /></label>
        {error && <div className="form-error">{error}. Проверьте, что backend запущен на {API_URL}.</div>}
        <button className="checkout-submit" disabled={!cart.length || loading}>{loading ? 'Создаём заказ…' : `Оформить заказ · ${money.format(total)} ₽`}</button>
        <p className="checkout-note">TEXHORU не хранит данные банковских карт. Онлайн-оплата проходит на стороне платёжного провайдера.</p>
      </form>
      <aside className="checkout-summary"><h2>В заказе</h2>{cart.map((item) => <div className="checkout-item" key={item.product.id}><img src={item.product.image} alt="" /><div><strong>{item.product.name}</strong><span>{item.quantity} × {money.format(item.product.price)} ₽</span></div></div>)}<div className="checkout-total"><span>Итого</span><strong>{money.format(total)} ₽</strong></div></aside>
    </div>
  </section>
}

function OrderStatusPage({ trackingToken, onHome }: { trackingToken: string; onHome: () => void }) {
  const [order, setOrder] = useState<TrackedOrder | null>(null)
  const [error, setError] = useState('')
  const [paying, setPaying] = useState(false)

  const load = () => api.trackOrder(trackingToken).then(setOrder).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить заказ'))
  useEffect(() => { load(); const timer = window.setInterval(load, 15000); return () => window.clearInterval(timer) }, [trackingToken])

  const pay = async () => {
    setPaying(true); setError('')
    try {
      const session = await api.createPaymentSession(trackingToken)
      if (session.paid) return load()
      if (session.checkoutUrl) window.location.assign(session.checkoutUrl)
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось начать оплату') } finally { setPaying(false) }
  }

  return <section className="order-track">
    <button className="back-link" onClick={onHome}><Icon name="back" /> В магазин</button>
    {!order && !error && <div className="admin-loading">Загружаем заказ…</div>}
    {error && <div className="form-error">{error}</div>}
    {order && <div className="order-track__layout"><div className="order-track__main"><p className="eyebrow">Заказ принят</p><h1>№ {order.number}</h1><div className="order-track__status"><span>Статус</span><strong>{statusLabels[order.status] ?? order.status}</strong></div><div className="order-track__items">{order.items.map((item) => <div key={`${item.name}-${item.quantity}`}><span>{item.name} × {item.quantity}</span><strong>{money.format(item.price * item.quantity)} ₽</strong></div>)}</div><div className="order-track__total"><span>Итого</span><strong>{money.format(order.total)} ₽</strong></div></div><aside className="order-track__side"><div><span>Оплата</span><strong>{paymentLabels[order.paymentStatus] ?? order.paymentStatus}</strong></div><div><span>Получение</span><strong>{order.deliveryMethod === 'PICKUP' ? 'Самовывоз' : 'Доставка'}</strong></div>{order.paymentMethod === 'ONLINE' && order.paymentStatus !== 'PAID' && order.status !== 'CANCELLED' && <button className="checkout-submit" onClick={pay} disabled={paying}>{paying ? 'Открываем…' : 'Оплатить онлайн'}</button>}<small>Страница обновляет статус автоматически.</small></aside></div>}
  </section>
}

function MockPaymentPage({ paymentId, trackingToken, onDone }: { paymentId: string; trackingToken: string; onDone: () => void }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const complete = async () => { setLoading(true); setError(''); try { await api.completeMockPayment(paymentId, trackingToken); onDone() } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось провести DEV-оплату') } finally { setLoading(false) } }
  return <section className="mock-payment"><p className="eyebrow">DEV PAYMENT</p><h1>Тестовая оплата</h1><p>Этот экран существует только для разработки. Реальный провайдер будет использовать свой защищённый checkout и webhook.</p>{error && <div className="form-error">{error}</div>}<button className="checkout-submit" onClick={complete} disabled={loading}>{loading ? 'Проводим…' : 'Имитировать успешную оплату'}</button></section>
}

type AdminProduct = ApiProduct & { reservedQty?: number }

type PromoFrame = { src: string; x: number; y: number; zoom: number }

const clampPromo = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const parsePromoFrame = (value: string): PromoFrame => {
  const marker = '#txframe='
  const markerIndex = value.lastIndexOf(marker)
  if (markerIndex < 0) return { src: value, x: 50, y: 50, zoom: 1 }
  const src = value.slice(0, markerIndex)
  const raw = value.slice(markerIndex + marker.length).split(',')
  const x = Number(raw[0]), y = Number(raw[1]), zoom = Number(raw[2])
  return {
    src,
    x: Number.isFinite(x) ? clampPromo(x, 0, 100) : 50,
    y: Number.isFinite(y) ? clampPromo(y, 0, 100) : 50,
    zoom: Number.isFinite(zoom) ? clampPromo(zoom, 1, 2.5) : 1,
  }
}

const encodePromoFrame = (src: string, x: number, y: number, zoom: number) =>
  `${parsePromoFrame(src).src}#txframe=${clampPromo(x, 0, 100).toFixed(2)},${clampPromo(y, 0, 100).toFixed(2)},${clampPromo(zoom, 1, 2.5).toFixed(3)}`

const promoFrameStyle = (frame: PromoFrame): CSSProperties => ({
  '--promo-x': `${frame.x}%`,
  '--promo-y': `${frame.y}%`,
  '--promo-zoom': String(frame.zoom),
} as CSSProperties)

type PromoDraft = {
  kicker: string
  title: string
  body: string
  ctaLabel: string
  category: string
  image: string
  imageX: number
  imageY: number
  imageZoom: number
  tone: string
  sortOrder: string
  isActive: boolean
}

const blankPromoDraft = (sortOrder = 0, category = 'Смартфоны'): PromoDraft => ({
  kicker: 'АКЦИЯ',
  title: '',
  body: '',
  ctaLabel: 'Смотреть',
  category,
  image: '',
  imageX: 50,
  imageY: 50,
  imageZoom: 1,
  tone: 'light',
  sortOrder: String(sortOrder),
  isActive: true,
})

type AdminProductDraft = {
  name: string
  sku: string
  slug: string
  brand: string
  categoryId: string
  price: string
  oldPrice: string
  stockQty: string
  stockState: 'IN_STOCK' | 'LOW' | 'PREORDER' | 'OUT_OF_STOCK'
  badge: string
  image: string
  shortSpec: string
  description: string
  warranty: string
  deliveryNote: string
  specs: Array<{ label: string; value: string }>
}

const blankProductDraft = (categoryId = ''): AdminProductDraft => ({
  name: '', sku: '', slug: '', brand: '', categoryId,
  price: '', oldPrice: '', stockQty: '0', stockState: 'IN_STOCK', badge: '',
  image: '/products/phone.svg', shortSpec: '', description: '', warranty: '1 год',
  deliveryNote: 'Кизилюрт и Дагестан', specs: [{ label: '', value: '' }],
})

const slugifyProduct = (value: string) => value
  .toLowerCase()
  .trim()
  .replace(/[^a-zа-яё0-9]+/gi, '-')
  .replace(/^-+|-+$/g, '')

function ProductEditor({
  value, categories: categoryOptions, editing, saving, onChange, onClose, onSave,
}: {
  value: AdminProductDraft
  categories: ApiCategory[]
  editing: boolean
  saving: boolean
  onChange: (value: AdminProductDraft) => void
  onClose: () => void
  onSave: (event: FormEvent) => void
}) {
  const selectedCategory = categoryOptions.find((item) => item.id === value.categoryId)?.name ?? 'Категория'
  const update = <K extends keyof AdminProductDraft>(key: K, next: AdminProductDraft[K]) => onChange({ ...value, [key]: next })
  const updateSpec = (index: number, key: 'label' | 'value', next: string) => update('specs', value.specs.map((item, i) => i === index ? { ...item, [key]: next } : item))
  const addSpec = () => update('specs', [...value.specs, { label: '', value: '' }])
  const removeSpec = (index: number) => update('specs', value.specs.filter((_, i) => i !== index).length ? value.specs.filter((_, i) => i !== index) : [{ label: '', value: '' }])
  const previewPrice = Number(value.price || 0)
  const previewOldPrice = Number(value.oldPrice || 0)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [imageError, setImageError] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const uploadImage = async (file?: File) => {
    if (!file) return
    setImageError('')
    setUploadingImage(true)
    try {
      const uploaded = await api.adminUploadProductImage(file)
      update('image', uploaded.url)
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'Не удалось загрузить изображение')
    } finally {
      setUploadingImage(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return <div className="admin-editor-backdrop" role="dialog" aria-modal="true" aria-label={editing ? 'Редактирование товара' : 'Новый товар'}>
    <section className="admin-editor">
      <div className="admin-editor__top">
        <div><p className="eyebrow">Карточка товара</p><h2>{editing ? 'Редактировать товар' : 'Новый товар'}</h2></div>
        <button type="button" className="admin-editor__close" onClick={onClose} aria-label="Закрыть"><Icon name="close" /></button>
      </div>

      <div className="admin-editor__layout">
        <form className="admin-editor__form" onSubmit={onSave}>
          <div className="admin-editor__section">
            <div className="admin-editor__section-head"><strong>Основное</strong><span>То, что покупатель увидит первым</span></div>
            <label className="admin-field admin-field--wide"><span>Название товара</span><input required value={value.name} onChange={(e) => { const name = e.target.value; onChange({ ...value, name, slug: value.slug && editing ? value.slug : slugifyProduct(name) }) }} placeholder="Например, iPhone 18 Pro 256 GB" /></label>
            <div className="admin-field-grid">
              <label className="admin-field"><span>Бренд</span><input required value={value.brand} onChange={(e) => update('brand', e.target.value)} placeholder="Apple" /></label>
              <label className="admin-field"><span>Категория</span><select required value={value.categoryId} onChange={(e) => update('categoryId', e.target.value)}>{categoryOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="admin-field"><span>SKU / артикул</span><input required value={value.sku} onChange={(e) => update('sku', e.target.value)} placeholder="IPH18P256" /></label>
              <label className="admin-field"><span>Slug</span><input required value={value.slug} onChange={(e) => update('slug', slugifyProduct(e.target.value))} placeholder="iphone-18-pro-256" /></label>
            </div>
          </div>

          <div className="admin-editor__section">
            <div className="admin-editor__section-head"><strong>Цена и наличие</strong><span>Данные, которые потом сможет обновлять 1С</span></div>
            <div className="admin-field-grid admin-field-grid--three">
              <label className="admin-field"><span>Цена, ₽</span><input required type="number" min="0" value={value.price} onChange={(e) => update('price', e.target.value)} placeholder="139990" /></label>
              <label className="admin-field"><span>Старая цена, ₽</span><input type="number" min="0" value={value.oldPrice} onChange={(e) => update('oldPrice', e.target.value)} placeholder="149990" /></label>
              <label className="admin-field"><span>Остаток, шт.</span><input required type="number" min="0" value={value.stockQty} onChange={(e) => update('stockQty', e.target.value)} /></label>
            </div>
            <div className="admin-field-grid">
              <label className="admin-field"><span>Статус наличия</span><select value={value.stockState} onChange={(e) => update('stockState', e.target.value as AdminProductDraft['stockState'])}><option value="IN_STOCK">В наличии</option><option value="LOW">Мало</option><option value="PREORDER">Под заказ</option><option value="OUT_OF_STOCK">Нет в наличии</option></select></label>
              <label className="admin-field"><span>Бейдж</span><input value={value.badge} onChange={(e) => update('badge', e.target.value)} placeholder="Новинка / Хит / Скидка" /></label>
            </div>
          </div>

          <div className="admin-editor__section">
            <div className="admin-editor__section-head"><strong>Фото и описание</strong><span>Загрузи фото прямо с компьютера</span></div>
            <div className="admin-image-upload">
              <input ref={fileInputRef} className="admin-image-upload__input" type="file" accept="image/jpeg,image/png,image/webp,image/avif" onChange={(e) => uploadImage(e.target.files?.[0])} />
              <button type="button" className="admin-image-upload__button" onClick={() => fileInputRef.current?.click()} disabled={uploadingImage}>{uploadingImage ? 'Загружаем…' : 'Выбрать фото с компьютера'}</button>
              <div className="admin-image-upload__drop" onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('is-over') }} onDragLeave={(e) => e.currentTarget.classList.remove('is-over')} onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('is-over'); uploadImage(e.dataTransfer.files?.[0]) }}>
                <strong>Перетащи фото сюда</strong><span>JPG, PNG, WEBP или AVIF · до 8 МБ</span>
              </div>
              {value.image && <div className="admin-image-upload__status"><span>Сохранено:</span><code>{value.image}</code></div>}
              {imageError && <div className="form-error">{imageError}</div>}
            </div>
            <label className="admin-field admin-field--wide"><span>Или URL изображения</span><input value={value.image} onChange={(e) => update('image', e.target.value)} placeholder="https://..." /><small>После загрузки файла адрес заполнится автоматически.</small></label>
            <label className="admin-field admin-field--wide"><span>Короткие характеристики</span><input value={value.shortSpec} onChange={(e) => update('shortSpec', e.target.value)} placeholder="6.3″ · 256 GB · 5G · Titanium" /></label>
            <label className="admin-field admin-field--wide"><span>Описание</span><textarea value={value.description} onChange={(e) => update('description', e.target.value)} placeholder="Коротко и понятно опиши товар для страницы товара." /></label>
          </div>

          <div className="admin-editor__section">
            <div className="admin-editor__section-head"><strong>Характеристики</strong><button type="button" onClick={addSpec}>+ Добавить</button></div>
            <div className="admin-spec-editor">{value.specs.map((spec, index) => <div className="admin-spec-row" key={index}><input value={spec.label} onChange={(e) => updateSpec(index, 'label', e.target.value)} placeholder="Параметр: Экран" /><input value={spec.value} onChange={(e) => updateSpec(index, 'value', e.target.value)} placeholder="Значение: 6.3 OLED" /><button type="button" onClick={() => removeSpec(index)} aria-label="Удалить характеристику">×</button></div>)}</div>
          </div>

          <div className="admin-editor__section">
            <div className="admin-editor__section-head"><strong>Сервис</strong><span>Показывается на странице товара</span></div>
            <div className="admin-field-grid">
              <label className="admin-field"><span>Гарантия</span><input value={value.warranty} onChange={(e) => update('warranty', e.target.value)} placeholder="1 год" /></label>
              <label className="admin-field"><span>Доставка</span><input value={value.deliveryNote} onChange={(e) => update('deliveryNote', e.target.value)} placeholder="Кизилюрт и Дагестан" /></label>
            </div>
          </div>

          <div className="admin-editor__actions"><button type="button" onClick={onClose}>Отмена</button><button className="admin-editor__save" disabled={saving}>{saving ? 'Сохраняем…' : editing ? 'Сохранить изменения' : 'Добавить товар'}</button></div>
        </form>

        <aside className="admin-editor__preview">
          <div className="admin-editor__preview-sticky">
            <span className="admin-preview-label">Предпросмотр карточки</span>
            <article className="admin-live-card">
              <div className="admin-live-card__media">{value.badge && <span className="badge">{value.badge}</span>}<img src={value.image || '/products/phone.svg'} alt="" onError={(e) => { e.currentTarget.src = '/products/phone.svg' }} /></div>
              <div className="admin-live-card__copy"><span>{value.brand || 'Бренд'} · {selectedCategory}</span><h3>{value.name || 'Название товара'}</h3><p>{value.shortSpec || 'Короткие характеристики товара'}</p><div><strong>{money.format(previewPrice)} ₽</strong>{previewOldPrice > 0 && <del>{money.format(previewOldPrice)} ₽</del>}</div></div>
            </article>
            <div className="admin-preview-note"><strong>Так карточка читается покупателем.</strong><span>Полное описание и характеристики будут на отдельной странице товара.</span></div>
          </div>
        </aside>
      </div>
    </section>
  </div>
}

function AdminPage({ onBack }: { onBack: () => void }) {
  const [authenticated, setAuthenticated] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)
  const [tab, setTab] = useState<AdminTab>('overview')
  const [email, setEmail] = useState('director@texhoru.local')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [products, setProducts] = useState<AdminProduct[]>([])
  const [orders, setOrders] = useState<any[]>([])
  const [notifications, setNotifications] = useState<any[]>([])
  const [logs, setLogs] = useState<any[]>([])
  const [audit, setAudit] = useState<any[]>([])
  const [promos, setPromos] = useState<PromoBanner[]>([])
  const [apiCategories, setApiCategories] = useState<ApiCategory[]>([])
  const [promoEditorOpen, setPromoEditorOpen] = useState(false)
  const [editingPromoId, setEditingPromoId] = useState<string | null>(null)
  const [promoDraft, setPromoDraft] = useState<PromoDraft>(() => blankPromoDraft())
  const [promoUploading, setPromoUploading] = useState(false)
  const [promoSaving, setPromoSaving] = useState(false)
  const [promoImageInfo, setPromoImageInfo] = useState('Рекомендуется 1600×720 px · широкий баннер · JPG/WEBP · до 2 МБ')
  const promoCropDrag = useRef<{ pointerId: number; clientX: number; clientY: number; imageX: number; imageY: number; width: number; height: number } | null>(null)
  const [categoryCreating, setCategoryCreating] = useState(false)
  const [categoryDraft, setCategoryDraft] = useState({ name: '', slug: '' })
  const [productSearch, setProductSearch] = useState('')
  const [adminCategory, setAdminCategory] = useState('ALL')
  const [productVisibility, setProductVisibility] = useState<'ALL' | 'ACTIVE' | 'ARCHIVED'>('ALL')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingProductId, setEditingProductId] = useState<number | null>(null)
  const [productDraft, setProductDraft] = useState<AdminProductDraft>(() => blankProductDraft())
  const [savingProduct, setSavingProduct] = useState(false)
  const [priceItems, setPriceItems] = useState<PriceMonitorItem[]>([])
  const [priceUrl, setPriceUrl] = useState('https://05.ru/cat/396f7486/p/smartfon-apple-iphone-17-pro-12-gb-256-gb-oranzheviy-e-sim-bez-rustore-24007/')
  const [priceProductId, setPriceProductId] = useState('')
  const [priceChecking, setPriceChecking] = useState(false)
  const [priceCatalogUrl, setPriceCatalogUrl] = useState('https://05.ru/cat/c/02e38f8a/telefony_i_gadzety/')
  const [priceImportLimit, setPriceImportLimit] = useState('12')
  const [priceImporting, setPriceImporting] = useState(false)
  const [priceImportMessage, setPriceImportMessage] = useState('')
  const [priceApplyingId, setPriceApplyingId] = useState<string | null>(null)
  const [priceClearing, setPriceClearing] = useState(false)

  const load = async () => {
    setLoading(true); setError('')
    try {
      const [p, o, n, l, c, promosData, auditData, priceData] = await Promise.all([api.adminProducts(), api.adminOrders(), api.adminNotifications(), api.syncLogs(), api.adminCategories(), api.adminPromos(), api.auditLogs(), api.adminPriceMonitor()])
      setProducts(p); setOrders(o); setNotifications(n); setLogs(l); setApiCategories(c); setPromos(promosData); setAudit(auditData); setPriceItems(priceData)
      setProductDraft((value) => value.categoryId ? value : { ...value, categoryId: c[0]?.id ?? '' })
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить админку') } finally { setLoading(false) }
  }

  useEffect(() => {
    api.me().then(async () => { setAuthenticated(true); await load() }).catch(() => setAuthenticated(false)).finally(() => setCheckingSession(false))
  }, [])

  const login = async (event: FormEvent) => {
    event.preventDefault(); setLoading(true); setError('')
    try { await api.login(email, password); setAuthenticated(true); await load() }
    catch (e) { setError(e instanceof Error ? e.message : 'Ошибка входа'); setLoading(false) }
  }

  const openCreateProduct = (categoryId?: string) => {
    const preferredCategory = categoryId ?? (adminCategory !== 'ALL' && apiCategories.some((item) => item.id === adminCategory && item.isActive !== false) ? adminCategory : apiCategories.find((item) => item.isActive !== false)?.id ?? '')
    setEditingProductId(null)
    setProductDraft(blankProductDraft(preferredCategory))
    setEditorOpen(true)
  }

  const openEditProduct = (item: AdminProduct) => {
    setEditingProductId(item.id)
    setProductDraft({
      name: item.name ?? '', sku: item.sku ?? '', slug: item.slug ?? '', brand: item.brand ?? '', categoryId: item.category?.id ?? '',
      price: String(item.price ?? 0), oldPrice: item.oldPrice ? String(item.oldPrice) : '', stockQty: String(item.stockQty ?? 0), stockState: item.stockState ?? 'IN_STOCK',
      badge: item.badge ?? '', image: item.image || '/products/phone.svg', shortSpec: item.shortSpec ?? '', description: item.description ?? '',
      warranty: item.warranty || '1 год', deliveryNote: item.deliveryNote || 'Кизилюрт и Дагестан', specs: Array.isArray(item.specs) && item.specs.length ? item.specs : [{ label: '', value: '' }],
    })
    setEditorOpen(true)
  }

  const saveProduct = async (event: FormEvent) => {
    event.preventDefault(); setSavingProduct(true); setError('')
    const stockQty = Number(productDraft.stockQty || 0)
    const payload = {
      name: productDraft.name.trim(), sku: productDraft.sku.trim(), slug: productDraft.slug.trim(), brand: productDraft.brand.trim(), categoryId: productDraft.categoryId,
      price: Number(productDraft.price || 0), oldPrice: productDraft.oldPrice ? Number(productDraft.oldPrice) : undefined, stockQty,
      stockState: productDraft.stockState === 'PREORDER' ? 'PREORDER' : stockQty <= 0 ? 'OUT_OF_STOCK' : stockQty <= 3 ? 'LOW' : 'IN_STOCK',
      badge: productDraft.badge.trim() || undefined, image: productDraft.image.trim() || '/products/phone.svg', shortSpec: productDraft.shortSpec.trim(),
      description: productDraft.description.trim(), warranty: productDraft.warranty.trim() || '1 год', deliveryNote: productDraft.deliveryNote.trim() || 'Кизилюрт и Дагестан',
      specs: productDraft.specs.filter((item) => item.label.trim() || item.value.trim()).map((item) => ({ label: item.label.trim(), value: item.value.trim() })),
    }
    try {
      if (editingProductId !== null) await api.adminUpdateProduct(editingProductId, payload)
      else await api.adminCreateProduct(payload)
      setEditorOpen(false); await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить товар') } finally { setSavingProduct(false) }
  }

  const notifyPromoChanged = () => window.dispatchEvent(new Event('texhoru:promos-changed'))

  const openCreatePromo = () => {
    const categoryName = apiCategories.find((item) => item.isActive !== false)?.name ?? 'Смартфоны'
    const nextSort = promos.length ? Math.max(...promos.map((item) => item.sortOrder ?? 0)) + 10 : 0
    setEditingPromoId(null)
    setPromoDraft(blankPromoDraft(nextSort, categoryName))
    setPromoImageInfo('Рекомендуется 1920×720 px · 8:3 · JPG/WEBP · до 2 МБ')
    setPromoEditorOpen(true)
  }

  const openEditPromo = (item: PromoBanner) => {
    setEditingPromoId(item.id)
    const frame = parsePromoFrame(item.image || '')
    setPromoDraft({
      kicker: item.kicker || 'АКЦИЯ', title: item.title || '', body: item.body || '', ctaLabel: item.ctaLabel || 'Смотреть',
      category: item.category || apiCategories.find((category) => category.isActive !== false)?.name || 'Смартфоны', image: frame.src,
      imageX: frame.x, imageY: frame.y, imageZoom: frame.zoom,
      tone: item.tone || 'light', sortOrder: String(item.sortOrder ?? 0), isActive: item.isActive !== false,
    })
    setPromoImageInfo('Текущее изображение · рекомендуемый стандарт 1920×720 px · 8:3')
    setPromoEditorOpen(true)
  }

  const inspectPromoImage = (file: File) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      const ratio = image.naturalWidth / image.naturalHeight
      const target = 8 / 3
      const ratioOk = Math.abs(ratio - target) < 0.13
      const sizeOk = image.naturalWidth >= 1600 && image.naturalHeight >= 600
      setPromoImageInfo(`${image.naturalWidth}×${image.naturalHeight} px · ${ratioOk && sizeOk ? 'отлично подходит' : 'можно использовать, но лучше 1920×720 (8:3)'}`)
      URL.revokeObjectURL(objectUrl)
    }
    image.onerror = () => URL.revokeObjectURL(objectUrl)
    image.src = objectUrl
  }

  const uploadPromoFile = async (file: File) => {
    setError('')
    if (file.size > 8 * 1024 * 1024) { setError('Фото акции больше 8 МБ'); return }
    inspectPromoImage(file)
    setPromoUploading(true)
    try {
      const uploaded = await api.adminUploadPromoImage(file)
      setPromoDraft((current) => ({ ...current, image: uploaded.url, imageX: 50, imageY: 50, imageZoom: 1 }))
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить фото акции') }
    finally { setPromoUploading(false) }
  }

  const startPromoCropDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!promoDraft.image || (event.target as HTMLElement).closest('label, button, input')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const rect = event.currentTarget.getBoundingClientRect()
    promoCropDrag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, imageX: promoDraft.imageX, imageY: promoDraft.imageY, width: rect.width, height: rect.height }
  }

  const movePromoCropDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = promoCropDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    const dx = event.clientX - drag.clientX
    const dy = event.clientY - drag.clientY
    const zoom = Math.max(1, promoDraft.imageZoom)
    setPromoDraft((current) => ({
      ...current,
      imageX: clampPromo(drag.imageX - (dx / Math.max(1, drag.width)) * 100 / zoom, 0, 100),
      imageY: clampPromo(drag.imageY - (dy / Math.max(1, drag.height)) * 100 / zoom, 0, 100),
    }))
  }

  const endPromoCropDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (promoCropDrag.current?.pointerId !== event.pointerId) return
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
    promoCropDrag.current = null
  }

  const zoomPromoCrop = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!promoDraft.image) return
    event.preventDefault()
    const delta = event.deltaY < 0 ? 0.08 : -0.08
    setPromoDraft((current) => ({ ...current, imageZoom: clampPromo(current.imageZoom + delta, 1, 2.5) }))
  }

  const savePromo = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    if (!promoDraft.image) { setError('Сначала выбери фото для акции'); return }
    setPromoSaving(true)
    const payload = {
      kicker: promoDraft.kicker.trim() || 'АКЦИЯ',
      title: promoDraft.title.trim() || `Акция ${promos.length + 1}`,
      body: promoDraft.body.trim(),
      ctaLabel: promoDraft.ctaLabel.trim() || 'Смотреть',
      category: promoDraft.category,
      image: encodePromoFrame(promoDraft.image, promoDraft.imageX, promoDraft.imageY, promoDraft.imageZoom),
      tone: promoDraft.tone,
      sortOrder: Number(promoDraft.sortOrder || 0),
      isActive: promoDraft.isActive,
    }
    try {
      if (editingPromoId) await api.adminUpdatePromo(editingPromoId, payload)
      else await api.adminCreatePromo(payload)
      setPromoEditorOpen(false)
      await load()
      notifyPromoChanged()
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить акцию') }
    finally { setPromoSaving(false) }
  }

  const togglePromo = async (item: PromoBanner) => {
    try { await api.adminUpdatePromo(item.id, { isActive: !item.isActive }); await load(); notifyPromoChanged() }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить видимость акции') }
  }

  const deletePromo = async (item: PromoBanner) => {
    if (!confirm(`Удалить акцию «${item.title || 'Без названия'}»?`)) return
    try { await api.adminDeletePromo(item.id); await load(); notifyPromoChanged() }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось удалить акцию') }
  }

  const createCategory = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    try {
      const created = await api.adminCreateCategory({ name: categoryDraft.name.trim(), slug: categoryDraft.slug.trim() || slugifyProduct(categoryDraft.name), sortOrder: apiCategories.length * 10 })
      setCategoryDraft({ name: '', slug: '' }); setCategoryCreating(false); setAdminCategory(created.id); await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось создать группу') }
  }

  const productGroups = useMemo(() => {
    const q = productSearch.trim().toLowerCase()
    const visibleByStatus = (item: AdminProduct) => productVisibility === 'ALL' || item.status === productVisibility
    return apiCategories.map((category) => ({
      category,
      items: products.filter((item) => item.category?.id === category.id && (adminCategory === 'ALL' || adminCategory === category.id) && visibleByStatus(item) && (!q || `${item.name} ${item.brand} ${item.sku}`.toLowerCase().includes(q))),
      total: products.filter((item) => item.category?.id === category.id && visibleByStatus(item)).length,
    })).filter((group) => (adminCategory === 'ALL' ? group.items.length > 0 : group.category.id === adminCategory))
  }, [apiCategories, products, productSearch, adminCategory, productVisibility])

  const archiveProduct = async (item: AdminProduct) => {
    if (!confirm(`Скрыть «${item.name}» с сайта? Товар останется в базе и его можно будет вернуть.`)) return
    try { await api.adminArchiveProduct(item.id); await load() } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось скрыть товар') }
  }

  const restoreProduct = async (item: AdminProduct) => {
    try { await api.adminRestoreProduct(item.id); await load() } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось вернуть товар') }
  }

  const deleteProduct = async (item: AdminProduct) => {
    if (!confirm(`Удалить «${item.name}» НАВСЕГДА? Это действие нельзя отменить.`)) return
    try { await api.adminDeleteProduct(item.id); await load() } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось удалить товар') }
  }

  const checkCompetitorPrice = async (event: FormEvent) => {
    event.preventDefault()
    setPriceChecking(true)
    setError('')
    try {
      await api.adminCheckCompetitorPrice({
        url: priceUrl.trim(),
        productId: priceProductId ? Number(priceProductId) : undefined,
      })
      setPriceItems(await api.adminPriceMonitor())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось проверить цену')
      setPriceItems(await api.adminPriceMonitor().catch(() => priceItems))
    } finally {
      setPriceChecking(false)
    }
  }

  const importFiveRuCatalog = async (event: FormEvent) => {
    event.preventDefault()
    setPriceImporting(true)
    setPriceImportMessage('')
    setError('')
    try {
      const result = await api.adminImportFiveRuCatalog({ url: priceCatalogUrl.trim(), limit: Number(priceImportLimit || 12) })
      setPriceImportMessage(`Импортировано: ${result.imported}. Новых: ${result.created}, обновлено: ${result.updated}. Разделов: ${result.categories.length}. Ошибок карточек: ${result.errors}.`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось импортировать раздел 05.ru')
    } finally {
      setPriceImporting(false)
    }
  }

  const applyRecommendedPrice = async (id: string) => {
    setPriceApplyingId(id)
    setError('')
    try {
      await api.adminApplyRecommendedPrice(id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось применить цену')
    } finally {
      setPriceApplyingId(null)
    }
  }

  const clearFiveRuTestImport = async () => {
    if (!confirm('Удалить все тестовые товары с SKU 05RU-* и пустые тестовые разделы 05.ru? Реальные товары и 1С не затрагиваются.')) return
    setPriceClearing(true)
    setError('')
    setPriceImportMessage('')
    try {
      const result = await api.adminClearFiveRuTestImport()
      setPriceImportMessage(`Тестовый импорт очищен. Удалено товаров: ${result.deleted}, архивировано из-за заказов: ${result.archived}, удалено разделов: ${result.categoriesDeleted}.`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось очистить тестовый импорт')
    } finally {
      setPriceClearing(false)
    }
  }

  if (checkingSession) return <section className="admin-shell"><div className="admin-loading">Проверяем сессию…</div></section>
  if (!authenticated) return <section className="admin-shell admin-login"><button className="back-link" onClick={onBack}><Icon name="back" /> В магазин</button><form onSubmit={login}><p className="eyebrow">TEXHORU CONTROL</p><h1>Вход в админку</h1><label><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label><label><span>Пароль</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>{error && <div className="form-error">{error}</div>}<button className="checkout-submit" disabled={loading}>{loading ? 'Проверяем…' : 'Войти'}</button><small>Учётка создаётся seed-скриптом backend. Перед production меняем все секреты.</small></form></section>

  const unread = notifications.filter((item) => !item.isRead).length
  const tabNames: Record<AdminTab, string> = { overview: 'Обзор', products: 'Товары', content: 'Витрина', prices: 'Мониторинг цен', orders: 'Заказы', notifications: 'Уведомления', sync: '1С', audit: 'Аудит' }
  return <section className="admin-shell">
    <div className="admin-top"><div><p className="eyebrow">TEXHORU CONTROL</p><h1>Управление магазином</h1></div><div className="admin-top__actions"><span className={error ? 'api-state api-state--bad' : 'api-state'}>{error ? 'API: ошибка' : 'API: подключён'}</span><button onClick={() => load()}>Обновить</button><button onClick={async () => { await api.logout().catch(() => undefined); setAuthenticated(false) }}>Выйти</button></div></div>
    <div className="admin-tabs">{(Object.keys(tabNames) as AdminTab[]).map((item) => <button className={tab === item ? 'active' : ''} onClick={() => setTab(item)} key={item}>{tabNames[item]}</button>)}</div>
    {error && <div className="admin-error">{error}</div>}{loading && <div className="admin-loading">Загрузка…</div>}
    {tab === 'overview' && <div className="admin-metrics"><article><span>Товаров</span><strong>{products.length}</strong></article><article><span>Категорий</span><strong>{apiCategories.length}</strong></article><article><span>Заказов</span><strong>{orders.length}</strong></article><article><span>Новых уведомлений</span><strong>{unread}</strong></article><article><span>Ошибок обмена 1С</span><strong>{logs.filter((item) => item.status === 'FAILED').length}</strong></article><article><span>Мало товара</span><strong>{products.filter((item) => Math.max(0, item.stockQty - (item.reservedQty ?? 0)) <= 3).length}</strong></article></div>}

    {tab === 'products' && <div className="admin-products-v2">
      <aside className="admin-category-panel">
        <div className="admin-category-panel__head"><div><span>Каталог</span><strong>Группы товаров</strong></div><button className="admin-category-add" onClick={() => setCategoryCreating((value) => !value)}>+ Группа</button></div>
        {categoryCreating && <form className="admin-category-create" onSubmit={createCategory}><input autoFocus required placeholder="Название группы" value={categoryDraft.name} onChange={(e) => setCategoryDraft({ name: e.target.value, slug: slugifyProduct(e.target.value) })} /><input required placeholder="slug" value={categoryDraft.slug} onChange={(e) => setCategoryDraft({ ...categoryDraft, slug: slugifyProduct(e.target.value) })} /><div><button type="button" onClick={() => setCategoryCreating(false)}>Отмена</button><button>Создать</button></div></form>}
        <button className={adminCategory === 'ALL' ? 'active' : ''} onClick={() => setAdminCategory('ALL')}><span>Все товары</span><b>{products.length}</b></button>
        {apiCategories.map((category) => <button key={category.id} className={adminCategory === category.id ? 'active' : ''} onClick={() => setAdminCategory(category.id)}><span>{category.name}{category.isActive === false ? ' · скрыта' : ''}</span><b>{products.filter((item) => item.category?.id === category.id).length}</b></button>)}
      </aside>

      <div className="admin-catalog-workspace">
        <div className="admin-catalog-toolbar"><div><p className="eyebrow">Товары</p><h2>{adminCategory === 'ALL' ? 'Весь каталог' : apiCategories.find((item) => item.id === adminCategory)?.name}</h2></div><div className="admin-catalog-toolbar__actions"><label className="admin-product-search"><Icon name="search" /><input value={productSearch} onChange={(e) => setProductSearch(e.target.value)} placeholder="Название, бренд или SKU" /></label><button className="admin-add-product" onClick={() => openCreateProduct()}>+ Добавить товар</button></div></div>
        <div className="admin-product-visibility" aria-label="Статус товаров">
          <button className={productVisibility === 'ALL' ? 'active' : ''} onClick={() => setProductVisibility('ALL')}>Все <span>{products.length}</span></button>
          <button className={productVisibility === 'ACTIVE' ? 'active' : ''} onClick={() => setProductVisibility('ACTIVE')}>На сайте <span>{products.filter((item) => item.status === 'ACTIVE').length}</span></button>
          <button className={productVisibility === 'ARCHIVED' ? 'active' : ''} onClick={() => setProductVisibility('ARCHIVED')}>Скрытые <span>{products.filter((item) => item.status === 'ARCHIVED').length}</span></button>
        </div>

        <div className="admin-product-groups">{productGroups.map((group) => <section className="admin-product-group" key={group.category.id}>
          <div className="admin-product-group__head"><div><h3>{group.category.name}</h3><span>{group.total} {group.total === 1 ? 'товар' : 'товаров'}</span></div><button onClick={() => openCreateProduct(group.category.id)}>+ Добавить в группу</button></div>
          {group.items.length ? <div className="admin-product-grid">{group.items.map((item) => <article className={item.status === 'ARCHIVED' ? 'admin-product-tile is-archived' : 'admin-product-tile'} key={item.id}>
            <button className="admin-product-tile__main" onClick={() => openEditProduct(item)}>
              <div className="admin-product-tile__image"><img src={item.image || '/products/phone.svg'} alt="" onError={(e) => { e.currentTarget.src = '/products/phone.svg' }} />{item.status === 'ARCHIVED' && <span>Скрыт</span>}</div>
              <div className="admin-product-tile__copy"><small>{item.brand} · {item.sku}</small><strong>{item.name}</strong><div><b>{money.format(item.price)} ₽</b><span>{item.stockQty} шт.</span></div></div>
            </button>
            <div className="admin-product-tile__actions">
              <button onClick={() => openEditProduct(item)}>Редактировать</button>
              {item.status === 'ARCHIVED' ? <button className="is-restore" onClick={() => restoreProduct(item)}>Вернуть на сайт</button> : <button onClick={() => archiveProduct(item)}>Скрыть</button>}
              <button className="is-danger" onClick={() => deleteProduct(item)}>Удалить</button>
            </div>
          </article>)}</div> : <div className="admin-group-empty">По этому фильтру товаров нет.</div>}
        </section>)}</div>
        {productGroups.length === 0 && <div className="admin-group-empty admin-group-empty--large">Ничего не найдено. Измени поиск или выбери другую группу.</div>}
      </div>
    </div>}

    {tab === 'content' && <div className="promo-manager">
      <div className="promo-manager__head">
        <div><p className="eyebrow">Главная страница</p><h2>Акционный слайдер</h2><span>{promos.filter((item) => item.isActive).length} активных · {promos.length} всего</span></div>
        <button className="promo-manager__add" onClick={openCreatePromo}>+ Добавить слайд</button>
      </div>
      <div className="promo-manager__guide"><strong>Стандарт фото: 1600×720 px</strong><span>Широкий баннер в JPG или WEBP до 2 МБ. Держи главный объект ближе к центру — витрина мягко подрежет края на разных экранах.</span></div>
      {promos.length ? <div className="promo-admin-grid promo-admin-grid--visual">{promos.map((item, index) => { const frame = parsePromoFrame(item.image); return <article className={item.isActive ? 'promo-admin-card' : 'promo-admin-card is-hidden'} key={item.id}>
        <button className="promo-admin-card__preview" onClick={() => openEditPromo(item)} aria-label={`Редактировать ${item.title || `слайд ${index + 1}`}`}><img src={frame.src} style={promoFrameStyle(frame)} alt="" /><span>{item.isActive ? `Слайд ${index + 1}` : 'Скрыт'}</span></button>
        <div className="promo-admin-card__meta"><div><strong>{item.title || `Акция ${index + 1}`}</strong><small>{item.category} · порядок {item.sortOrder}</small></div><button onClick={() => openEditPromo(item)}>Изменить</button></div>
        <div className="promo-admin-card__actions"><button onClick={() => togglePromo(item)}>{item.isActive ? 'Скрыть' : 'Показать'}</button><button className="is-danger" onClick={() => deletePromo(item)}>Удалить</button></div>
      </article> })}</div> : <div className="promo-manager__empty"><strong>Акций пока нет</strong><span>Добавь первый слайд. На витрине блок появится автоматически.</span><button onClick={openCreatePromo}>Добавить слайд</button></div>}

      {promoEditorOpen && <div className="promo-editor-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setPromoEditorOpen(false) }}>
        <form className="promo-editor" onSubmit={savePromo}>
          <div className="promo-editor__head"><div><p className="eyebrow">Акционный слайдер</p><h2>{editingPromoId ? 'Изменить слайд' : 'Новый слайд'}</h2></div><button type="button" onClick={() => setPromoEditorOpen(false)} aria-label="Закрыть"><Icon name="close" /></button></div>
          <div className="promo-editor__body">
            <div className="promo-editor__visual">
              <div
                className={promoDraft.image ? 'promo-editor__crop-stage has-image' : 'promo-editor__crop-stage'}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void uploadPromoFile(file) }}
                onPointerDown={startPromoCropDrag}
                onPointerMove={movePromoCropDrag}
                onPointerUp={endPromoCropDrag}
                onPointerCancel={endPromoCropDrag}
                onWheel={zoomPromoCrop}
              >
                {promoDraft.image ? <>
                  <img
                    className="promo-editor__crop-image"
                    src={promoDraft.image}
                    style={promoFrameStyle({ src: promoDraft.image, x: promoDraft.imageX, y: promoDraft.imageY, zoom: promoDraft.imageZoom })}
                    alt="Предпросмотр акции"
                    draggable={false}
                  />
                  <span className="promo-editor__crop-grid" aria-hidden="true" />
                  <span className="promo-editor__crop-hint">Перетаскивай фото · колесо меняет масштаб</span>
                  <label className="promo-editor__replace">{promoUploading ? 'Загрузка…' : 'Заменить фото'}<input type="file" accept="image/jpeg,image/png,image/webp,image/avif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadPromoFile(file); event.currentTarget.value = '' }} /></label>
                </> : <label className="promo-editor__dropzone promo-editor__dropzone--empty"><div><strong>Перетащи фото сюда</strong><span>или нажми, чтобы выбрать файл</span></div><input type="file" accept="image/jpeg,image/png,image/webp,image/avif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadPromoFile(file); event.currentTarget.value = '' }} /><span className="promo-editor__replace">{promoUploading ? 'Загрузка…' : 'Выбрать фото'}</span></label>}
              </div>
              {promoDraft.image && <div className="promo-editor__crop-controls">
                <div className="promo-editor__crop-label"><span>Масштаб</span><strong>{Math.round(promoDraft.imageZoom * 100)}%</strong></div>
                <div className="promo-editor__crop-slider"><button type="button" onClick={() => setPromoDraft((current) => ({ ...current, imageZoom: clampPromo(current.imageZoom - .08, 1, 2.5) }))}>−</button><input type="range" min="1" max="2.5" step="0.01" value={promoDraft.imageZoom} onChange={(event) => setPromoDraft({ ...promoDraft, imageZoom: Number(event.target.value) })} /><button type="button" onClick={() => setPromoDraft((current) => ({ ...current, imageZoom: clampPromo(current.imageZoom + .08, 1, 2.5) }))}>+</button><button type="button" className="promo-editor__crop-reset" onClick={() => setPromoDraft((current) => ({ ...current, imageX: 50, imageY: 50, imageZoom: 1 }))}>Сбросить</button></div>
                <small>Перетащи изображение мышкой или пальцем. Положение и масштаб сохранятся именно так, как ты выставил.</small>
              </div>}
              <div className="promo-editor__image-info"><strong>1600×720 · широкий баннер</strong><span>{promoImageInfo}</span></div>
            </div>
            <div className="promo-editor__fields">
              <label><span>Название в админке</span><input value={promoDraft.title} onChange={(e) => setPromoDraft({ ...promoDraft, title: e.target.value })} placeholder="Например: Осенняя акция" /></label>
              <div className="promo-editor__row"><label><span>Категория</span><select value={promoDraft.category} onChange={(e) => setPromoDraft({ ...promoDraft, category: e.target.value })}>{apiCategories.filter((item) => item.isActive !== false).map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label><label><span>Порядок</span><input type="number" min="0" value={promoDraft.sortOrder} onChange={(e) => setPromoDraft({ ...promoDraft, sortOrder: e.target.value })} /></label></div>
              <label className="promo-editor__switch"><input type="checkbox" checked={promoDraft.isActive} onChange={(e) => setPromoDraft({ ...promoDraft, isActive: e.target.checked })} /><span><strong>Показывать на сайте</strong><small>Количество активных карточек и есть количество слайдов.</small></span></label>
              <div className="promo-editor__tip"><strong>Как будет выглядеть</strong><span>Изображение заполняет весь акционный блок. Масштаб и положение берутся из кадрирования выше. На витрине пользователь нажимает по краям или свайпает.</span></div>
            </div>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="promo-editor__footer"><button type="button" onClick={() => setPromoEditorOpen(false)}>Отмена</button><button className="promo-editor__save" disabled={promoSaving || promoUploading}>{promoSaving ? 'Сохраняем…' : 'Сохранить слайд'}</button></div>
        </form>
      </div>}
    </div>}
    {tab === 'prices' && <div className="price-monitor">
      <form className="price-monitor__check" onSubmit={checkCompetitorPrice}>
        <div className="price-monitor__head"><div><p className="eyebrow">Первый источник</p><h2>05.ru</h2></div><span>Ручная проверка · безопасный режим</span></div>
        <label><span>Ссылка на товар 05.ru</span><input required type="url" value={priceUrl} onChange={(e) => setPriceUrl(e.target.value)} /></label>
        <label><span>Сопоставить с товаром TEXHORU</span><select value={priceProductId} onChange={(e) => setPriceProductId(e.target.value)}><option value="">Пока не сопоставлять</option>{products.filter((item) => item.status !== 'ARCHIVED').map((item) => <option key={item.id} value={item.id}>{item.name} · {item.sku}</option>)}</select></label>
        <button type="submit" disabled={priceChecking}>{priceChecking ? 'Проверяем 05.ru…' : 'Проверить цену'}</button>
        <small>После сопоставления TEXHORU считает рекомендацию: цена 05.ru минус 500 ₽. Применение пока меняет только локальную цену TEXHORU. При следующем импорте из 1С она может быть перезаписана.</small>
      </form>

      <form className="price-monitor__import" onSubmit={importFiveRuCatalog}>
        <div className="price-monitor__head"><div><p className="eyebrow">Тестовое наполнение</p><h2>Скопировать раздел 05.ru</h2></div><span>Товары + разделы · до 24 карточек за запуск</span></div>
        <label><span>Ссылка на раздел 05.ru</span><input required type="url" value={priceCatalogUrl} onChange={(e) => setPriceCatalogUrl(e.target.value)} /></label>
        <label><span>Сколько товаров взять</span><select value={priceImportLimit} onChange={(e) => setPriceImportLimit(e.target.value)}><option value="6">6 товаров</option><option value="12">12 товаров</option><option value="24">24 товара</option></select></label>
        <button type="submit" disabled={priceImporting}>{priceImporting ? 'Импортируем…' : 'Импортировать для теста'}</button>
        <button className="price-monitor__danger" type="button" disabled={priceClearing || priceImporting} onClick={clearFiveRuTestImport}>{priceClearing ? 'Очищаем…' : 'Удалить тестовый импорт'}</button>
        <small>Создаются отдельные группы «ТЕСТ 05.ru · …» и товары с SKU 05RU-*. Берём фактические данные: название, бренд, цену, наличие и раздел. Чужие описания и фотографии специально не копируются.</small>
        {priceImportMessage && <p className="price-monitor__notice">{priceImportMessage}</p>}
      </form>

      <section className="price-monitor__results">
        <div className="price-monitor__results-head"><div><p className="eyebrow">История</p><h2>Проверенные товары</h2></div><strong>{priceItems.length}</strong></div>
        {priceItems.length === 0 ? <div className="price-monitor__empty">Пока пусто. Нажми «Проверить цену» выше.</div> : priceItems.map((item) => <article className={item.lastError ? 'price-monitor__item is-error' : 'price-monitor__item'} key={item.id}>
          <div className="price-monitor__item-main"><span>{item.source?.name || '05.ru'} · {item.lastCheckedAt ? new Date(item.lastCheckedAt).toLocaleString('ru-RU') : 'не проверялся'}</span><strong>{item.externalName || 'Карточка 05.ru'}</strong><a href={item.externalUrl} target="_blank" rel="noreferrer">Открыть товар ↗</a></div>
          <div><span>Цена конкурента</span><strong>{item.latestPrice ? `${money.format(item.latestPrice)} ₽` : '—'}</strong>{item.oldPrice ? <small>старая {money.format(item.oldPrice)} ₽</small> : null}</div>
          <div><span>Рекомендация</span><strong>{item.recommendedPrice ? `${money.format(item.recommendedPrice)} ₽` : '—'}</strong><small>05.ru − 500 ₽</small></div>
          <div><span>Наличие</span><strong>{item.inStock === true ? 'В наличии' : item.inStock === false ? 'Нет в наличии' : '—'}</strong></div>
          <div className="price-monitor__ours"><span>Наш товар</span><strong>{item.product?.name || 'Не сопоставлен'}</strong>{item.product ? <small>наша цена {money.format(item.product.price)} ₽</small> : null}{item.product && item.recommendedPrice && item.inStock !== false && item.product.price !== item.recommendedPrice ? <button type="button" disabled={priceApplyingId === item.id} onClick={() => void applyRecommendedPrice(item.id)}>{priceApplyingId === item.id ? 'Применяем…' : 'Применить рекомендацию'}</button> : null}</div>
          {item.lastError && <p>{item.lastError}</p>}
        </article>)}
      </section>
    </div>}
    {tab === 'orders' && <div className="admin-table"><div className="admin-row admin-row--orders admin-row--head"><span>№</span><span>Клиент</span><span>Сумма</span><span>Статус</span></div>{orders.map((item) => <div className="admin-row admin-row--orders" key={item.id}><span>#{item.number}<small>{item.paymentMethod === 'ONLINE' ? 'онлайн' : 'при получении'}</small></span><span><strong>{item.customerName}</strong><small>{item.customerPhone}</small></span><span>{money.format(item.total)} ₽<small>{paymentLabels[item.paymentStatus] ?? item.paymentStatus}</small></span><span><select className="admin-status-select" value={item.status} onChange={async (e) => { try { await api.adminUpdateOrderStatus(item.id, e.target.value); await load() } catch (err) { setError(err instanceof Error ? err.message : 'Ошибка статуса') } }}>{['NEW','AWAITING_PAYMENT','PAID','ASSEMBLING','READY','DELIVERING','COMPLETED','CANCELLED'].map((status) => <option key={status}>{status}</option>)}</select></span></div>)}</div>}
    {tab === 'notifications' && <div className="admin-feed">{notifications.map((item) => <article key={item.id} className={item.isRead ? 'is-read' : ''}><span>{new Date(item.createdAt).toLocaleString('ru-RU')}</span><strong>{item.title}</strong><p>{item.body}</p>{!item.isRead && <button onClick={async () => { await api.adminMarkNotificationRead(item.id); await load() }}>Прочитано</button>}</article>)}</div>}
    {tab === 'sync' && <div className="admin-feed">{logs.length === 0 && <p>Обмен с 1С ещё не запускался.</p>}{logs.map((item) => <article key={item.id} className={item.status === 'FAILED' ? 'is-error' : ''}><span>{new Date(item.createdAt).toLocaleString('ru-RU')} · {item.direction}</span><strong>{item.entity} · {item.status}</strong><p>{item.message || 'Без сообщения'}</p></article>)}</div>}
    {tab === 'audit' && <div className="admin-feed">{audit.map((item) => <article key={item.id}><span>{new Date(item.createdAt).toLocaleString('ru-RU')} · {item.user?.email ?? 'system'}</span><strong>{item.action} · {item.entity}</strong><p>{item.entityId || '—'}</p></article>)}</div>}
    {editorOpen && <ProductEditor value={productDraft} categories={apiCategories.filter((item) => item.isActive !== false)} editing={editingProductId !== null} saving={savingProduct} onChange={setProductDraft} onClose={() => setEditorOpen(false)} onSave={saveProduct} />}
  </section>
}

function App() {
  const [category, setCategory] = useState<Category>('Все')
  const [query, setQuery] = useState('')
  const [catalogProducts, setCatalogProducts] = useState<Product[]>(fallbackProducts)
  const [promos, setPromos] = useState<PromoBanner[]>(defaultPromos)
  const [promosLoaded, setPromosLoaded] = useState(false)
  const [apiOnline, setApiOnline] = useState(false)
  const [cart, setCart] = useState<CartLine[]>(() => { try { return JSON.parse(localStorage.getItem('texhoru_cart') || '[]') } catch { return [] } })
  const [cartOpen, setCartOpen] = useState(false)
  const [accountTab, setAccountTab] = useState<AccountTab>('active')
  const [path, setPath] = useState(() => window.location.pathname)
  const [menuOpen, setMenuOpen] = useState(false)
  const [slideIndex, setSlideIndex] = useState(0)
  const [sliderDragOffset, setSliderDragOffset] = useState(0)
  const [sliderIsDragging, setSliderIsDragging] = useState(false)
  const sliderDrag = useRef<{ pointerId: number; startX: number; currentX: number; width: number } | null>(null)

  const refreshPromos = () => api.promos().then((items) => { setPromos(items); setPromosLoaded(true) }).catch(() => { setPromos(defaultPromos); setPromosLoaded(false) })

  useEffect(() => {
    api.products().then((items) => { setCatalogProducts(items); setCart((current) => current.filter((line) => items.some((item) => item.id === line.product.id)).map((line) => ({ ...line, product: items.find((item) => item.id === line.product.id)! }))); setApiOnline(true) }).catch(() => setApiOnline(false))
    void refreshPromos()
    const onPromosChanged = () => { void refreshPromos() }
    window.addEventListener('texhoru:promos-changed', onPromosChanged)
    return () => window.removeEventListener('texhoru:promos-changed', onPromosChanged)
  }, [])
  useEffect(() => { localStorage.setItem('texhoru_cart', JSON.stringify(cart)) }, [cart])
  useEffect(() => { const onPopState = () => setPath(window.location.pathname); window.addEventListener('popstate', onPopState); return () => window.removeEventListener('popstate', onPopState) }, [])

  const navigate = (nextPath: string) => { if (window.location.pathname !== nextPath) window.history.pushState({}, '', nextPath); setPath(nextPath); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  const productMatch = path.match(/^\/product\/(\d+)\/?$/)
  const orderMatch = path.match(/^\/order\/([^/]+)\/?$/)
  const mockPaymentMatch = path.match(/^\/payment\/mock\/([^/]+)\/?$/)
  const selectedProduct = productMatch ? catalogProducts.find((item) => item.id === Number(productMatch[1])) : undefined
  const isProductPage = Boolean(productMatch), isAccountPage = /^\/account\/?$/.test(path), isCheckoutPage = /^\/checkout\/?$/.test(path), isAdminPage = /^\/admin\/?$/.test(path)
  const filtered = useMemo(() => { const q = query.trim().toLowerCase(); return catalogProducts.filter((product) => (category === 'Все' || product.category === category) && (!q || `${product.name} ${product.brand} ${product.category} ${product.shortSpec}`.toLowerCase().includes(q))) }, [category, query, catalogProducts])
  const sliderItems = useMemo(() => promosLoaded ? promos.filter((item) => item.isActive !== false) : defaultPromos, [promos, promosLoaded])
  useEffect(() => {
    if (path !== '/' || sliderItems.length < 2) return
    const timer = window.setInterval(() => setSlideIndex((current) => (current + 1) % sliderItems.length), 6000)
    return () => window.clearInterval(timer)
  }, [path, sliderItems.length])
  useEffect(() => { if (slideIndex >= sliderItems.length) setSlideIndex(0) }, [slideIndex, sliderItems.length])
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0), total = cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0)
  const addToCart = (product: Product) => { if (product.stockQty === 0 && product.stock !== 'Под заказ') return; setCart((current) => { const existing = current.find((item) => item.product.id === product.id); return existing ? current.map((item) => item.product.id === product.id ? { ...item, quantity: item.quantity + 1 } : item) : [...current, { product, quantity: 1 }] }); setCartOpen(true) }
  const changeQuantity = (productId: number, delta: number) => setCart((current) => current.map((item) => item.product.id === productId ? { ...item, quantity: item.quantity + delta } : item).filter((item) => item.quantity > 0))
  const openProduct = (product: Product) => navigate(`/product/${product.id}`)
  const jumpToCatalog = (nextCategory: Category = 'Все') => {
    setCategory(nextCategory)
    setMenuOpen(false)
    if (window.location.pathname !== '/') {
      navigate('/')
      window.setTimeout(() => document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
    } else {
      window.requestAnimationFrame(() => document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }
  const moveSlide = (delta: number) => setSlideIndex((current) => (current + delta + sliderItems.length) % sliderItems.length)
  const startSliderDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sliderItems.length < 2) return
    const width = event.currentTarget.getBoundingClientRect().width
    sliderDrag.current = { pointerId: event.pointerId, startX: event.clientX, currentX: event.clientX, width }
    event.currentTarget.setPointerCapture(event.pointerId)
    setSliderDragOffset(0)
    setSliderIsDragging(true)
  }
  const moveSliderDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sliderDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.currentX = event.clientX
    setSliderDragOffset(event.clientX - drag.startX)
  }
  const endSliderDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sliderDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const delta = drag.currentX - drag.startX
    const threshold = Math.max(56, drag.width * 0.1)
    sliderDrag.current = null
    setSliderDragOffset(0)
    setSliderIsDragging(false)
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
    if (Math.abs(delta) < threshold) return
    moveSlide(delta < 0 ? 1 : -1)
  }

  const renderHome = () => <>
    {sliderItems.length > 0 && <section className="storefront-carousel" aria-label="Предложения TEXHORU">
      <div className="storefront-carousel__layout">
        <div
          className={sliderIsDragging ? 'storefront-carousel__viewport is-dragging' : 'storefront-carousel__viewport'}
          onPointerDown={startSliderDrag}
          onPointerMove={moveSliderDrag}
          onPointerUp={endSliderDrag}
          onPointerCancel={endSliderDrag}
        >
          <div className="storefront-carousel__track" style={{ transform: `translateX(calc(-${slideIndex * 100}% + ${sliderDragOffset}px))` }}>
            {sliderItems.map((promo, index) => {
              const frame = parsePromoFrame(promo.image)
              return <div key={`${promo.id}-${index}`} className={`storefront-slide storefront-slide--${promo.tone || 'light'}`} aria-hidden={index !== slideIndex}>
                <img src={frame.src} style={promoFrameStyle(frame)} alt={promo.title || `Предложение ${index + 1}`} draggable={false} />
              </div>
            })}
          </div>
          {sliderItems.length > 1 && <>
            <button className="carousel-hit carousel-hit--left" onClick={() => moveSlide(-1)} aria-label="Предыдущий баннер" />
            <button className="carousel-hit carousel-hit--right" onClick={() => moveSlide(1)} aria-label="Следующий баннер" />
            <div className="carousel-dots" aria-label="Слайды">{sliderItems.map((item, index) => <button key={`${item.id}-dot-${index}`} className={index === slideIndex ? 'active' : ''} onClick={() => setSlideIndex(index)} aria-label={`Слайд ${index + 1}`} />)}</div>
          </>}
        </div>
        <aside className="storefront-carousel__aside">
          <span className="storefront-carousel__aside-kicker">TEXHORU</span>
          <h3>Акции, новинки и цены — в одной зоне</h3>
          <p>Большой баннер листается мышкой или пальцем, а справа всегда стоит аккуратная карточка для внимания.</p>
          <button type="button" className="storefront-carousel__aside-link" onClick={() => document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Открыть каталог <Icon name="arrow" /></button>
        </aside>
      </div>
    </section>}
    <section className="catalog" id="catalog"><div className="section-head"><div><p className="eyebrow">Каталог</p><h2>Товары</h2></div><div className="catalog-source"><span className={apiOnline ? 'source-dot online' : 'source-dot'} />{apiOnline ? 'данные из API' : 'локальный preview'}</div></div><div className="category-row">{categories.map((item) => <button key={item} className={item === category ? 'category active' : 'category'} onClick={() => setCategory(item)}>{item}</button>)}</div><div className="product-grid">{filtered.map((product) => <ProductCard key={product.id} product={product} onOpen={openProduct} onAdd={addToCart} />)}</div>{filtered.length === 0 && <div className="empty-search">Ничего не найдено.</div>}</section>
  </>

  const renderProductPage = (product: Product) => { const related = catalogProducts.filter((item) => item.category === product.category && item.id !== product.id).slice(0, 6); return <section className="product-page"><button className="back-link" onClick={() => navigate('/')}><Icon name="back" /> Вернуться в каталог</button><div className="product-page__layout"><div className="product-page__visual">{product.badge && <span className="badge">{product.badge}</span>}<img src={product.image} alt={product.name} /></div><div className="product-page__summary"><p className="eyebrow">{product.brand} / {product.category}</p><h1>{product.name}</h1><p className="product-page__short">{product.shortSpec}</p><p className="product-page__description">{product.description}</p><div className="product-page__stock">● {product.stock}{product.stockQty !== undefined ? ` · ${product.stockQty} шт.` : ''}</div><div className="product-page__price"><strong>{money.format(product.price)} ₽</strong>{product.oldPrice && <del>{money.format(product.oldPrice)} ₽</del>}</div><button className="product-page__buy" onClick={() => addToCart(product)}><Icon name="cart" /> Добавить в корзину</button><div className="product-page__service"><div><span>Доставка</span><strong>{product.deliveryNote}</strong></div><div><span>Гарантия</span><strong>{product.warranty}</strong></div><div><span>Оплата</span><strong>Картой, наличными или онлайн</strong></div></div></div></div><div className="product-details"><div className="product-details__title"><p className="eyebrow">Характеристики</p><h2>Главное о товаре</h2></div><dl className="spec-list">{product.specs.map((spec) => <div key={spec.label}><dt>{spec.label}</dt><dd>{spec.value}</dd></div>)}</dl></div>{related.length > 0 && <div className="related-block"><div className="section-head section-head--compact"><div><p className="eyebrow">Похожее</p><h2>Ещё в категории</h2></div></div><div className="product-grid product-grid--related">{related.map((item) => <ProductCard key={item.id} product={item} onOpen={openProduct} onAdd={addToCart} />)}</div></div>}</section> }

  const renderAccountPage = () => <section className="account-page"><div className="account-page__top"><button className="back-link" onClick={() => navigate('/')}><Icon name="back" /> В магазин</button><div className="account-simple-head"><div><p className="eyebrow">TEXHORU</p><h1>Личный кабинет</h1></div><div className="account-simple-user"><strong>Умар Мутаев</strong><span>+7 999 123-45-67</span></div></div></div><nav className="account-simple-tabs"><button className={accountTab === 'active' ? 'active' : ''} onClick={() => setAccountTab('active')}>Активные заказы <span>{activeOrders.length}</span></button><button className={accountTab === 'history' ? 'active' : ''} onClick={() => setAccountTab('history')}>История</button><button className={accountTab === 'profile' ? 'active' : ''} onClick={() => setAccountTab('profile')}>Мои данные</button></nav><div className="account-page__content account-page__content--simple">{accountTab === 'active' && <div className="order-list order-list--page">{activeOrders.map((order) => <OrderCard key={order.id} order={order} />)}</div>}{accountTab === 'history' && <div className="order-list order-list--page">{orderHistory.map((order) => <OrderCard key={order.id} order={order} />)}</div>}{accountTab === 'profile' && <div className="profile-simple"><div><span>Имя</span><strong>Умар Мутаев</strong></div><div><span>Телефон</span><strong>+7 999 123-45-67</strong></div><div><span>Email</span><strong>umar@example.com</strong></div><div><span>Город</span><strong>Кизилюрт, Дагестан</strong></div></div>}</div></section>

  const tokenFromQuery = new URLSearchParams(window.location.search).get('token') || ''
  let content
  if (isAdminPage) content = <AdminPage onBack={() => navigate('/')} />
  else if (mockPaymentMatch) content = <MockPaymentPage paymentId={mockPaymentMatch[1]} trackingToken={tokenFromQuery} onDone={() => navigate(`/order/${tokenFromQuery}`)} />
  else if (orderMatch) content = <OrderStatusPage trackingToken={orderMatch[1]} onHome={() => navigate('/')} />
  else if (isCheckoutPage) content = <CheckoutPage cart={cart} onBack={() => navigate('/')} onCreated={(order) => { setCart([]); navigate(`/order/${order.trackingToken}`) }} />
  else if (isAccountPage) content = renderAccountPage()
  else if (isProductPage) content = selectedProduct ? renderProductPage(selectedProduct) : <section className="not-found"><p className="eyebrow">404</p><h1>Товар не найден</h1><button className="hero-link" onClick={() => navigate('/')}>Вернуться в магазин <Icon name="arrow" /></button></section>
  else content = renderHome()

  return <div className="app-shell"><header className="header header--storefront"><button className="brand brand-button" onClick={() => navigate('/')}>TEXHO<span className="brand-ru">RU</span></button><div className="header-tools"><button className="header-tool header-menu-button" onClick={() => setMenuOpen(true)} aria-label="Категории товаров"><Icon name="menu" /><span>Каталог</span></button></div><label className="header-search-inline"><Icon name="search" /><input value={query} onFocus={() => setMenuOpen(false)} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') jumpToCatalog(category) }} placeholder="Поиск по товарам, брендам и моделям" aria-label="Поиск по каталогу" />{query && <button type="button" onClick={() => setQuery('')} aria-label="Очистить поиск"><Icon name="close" /></button>}</label><div className="header-actions"><button className="ghost-button" onClick={() => { setAccountTab('active'); navigate('/account') }}><Icon name="user" />Кабинет</button><button className="cart-button" onClick={() => setCartOpen(true)}><Icon name="cart" />Корзина <span>{cartCount}</span></button></div></header>
  {menuOpen && <div className="menu-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setMenuOpen(false) }}><aside className="category-drawer"><div className="category-drawer__head"><div><span>TEXHORU</span><strong>Категории</strong></div><button onClick={() => setMenuOpen(false)} aria-label="Закрыть меню"><Icon name="close" /></button></div><nav className="category-drawer__list">{categories.map((item) => <button key={item} className={item === category ? 'active' : ''} onClick={() => jumpToCatalog(item)}><span>{item}</span><Icon name="arrow" /></button>)}</nav><div className="category-drawer__footer"><button onClick={() => { setMenuOpen(false); setAccountTab('active'); navigate('/account') }}><Icon name="user" /> Личный кабинет</button><span>КИЗИЛЮРТ · ДАГЕСТАН</span></div></aside></div>}
  <main id="top">{content}</main><footer className="footer"><button className="brand brand-button" onClick={() => navigate('/')}>TEXHO<span className="brand-ru">RU</span></button><button className="footer-admin" onClick={() => navigate('/admin')}>Управление</button><div>КИЗИЛЮРТ · ДАГЕСТАН</div></footer>
  {cartOpen && <div className="overlay" onMouseDown={(event) => { if (event.currentTarget === event.target) setCartOpen(false) }}><aside className="drawer"><div className="drawer-head"><div><p className="eyebrow">Заказ</p><h2>Корзина ({cartCount})</h2></div><button className="icon-button" onClick={() => setCartOpen(false)}><Icon name="close" /></button></div><div className="drawer-body cart-lines">{cart.length === 0 ? <div className="cart-empty">Корзина пока пуста.</div> : cart.map((item) => <div className="cart-line" key={item.product.id}><button className="cart-line__image" onClick={() => { setCartOpen(false); openProduct(item.product) }}><img src={item.product.image} alt={item.product.name} /></button><div className="cart-line-copy"><button className="cart-line__title" onClick={() => { setCartOpen(false); openProduct(item.product) }}>{item.product.name}</button><span>{item.product.shortSpec}</span><b>{money.format(item.product.price)} ₽</b><div className="qty"><button onClick={() => changeQuantity(item.product.id, -1)}><Icon name="minus" /></button><span>{item.quantity}</span><button onClick={() => changeQuantity(item.product.id, 1)}><Icon name="plus" /></button></div></div></div>)}</div><div className="drawer-bottom"><div className="total"><span>Итого</span><strong>{money.format(total)} ₽</strong></div><button className="checkout" disabled={!cart.length} onClick={() => { setCartOpen(false); navigate('/checkout') }}>Перейти к оформлению</button><small>{apiOnline ? 'Цена и остаток будут перепроверены сервером.' : 'Для создания заказа запустите backend.'}</small></div></aside></div>}
  </div>
}

export default App
