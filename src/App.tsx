import { AccountPage } from './AccountPage'
import { RemoteCatalogPanel } from './RemoteCatalogPanel'
import { Icon } from './Icon'
import { CartDrawer } from './CartDrawer'
import { BrandNavigation } from './BrandNavigation'
import { CatalogExplorer } from './CatalogExplorer'
import { PwaInstallPrompt } from './PwaInstallPrompt'
import { ProductImage } from './ProductImage'
import { cartLimit, restoreCart } from './store-utils'
import { inCatalogSection } from './catalog-groups'
import { categorySegments, categorySelection, categoryTree, categoryTreeFromCounts, childrenAtPath, selectedCategoryPath } from './onec-category-tree'
import { PriceApprovalDashboard } from './PriceApprovalDashboard'
import { PageBuilder } from './PageBuilder'
import { AdminIcon } from './AdminIcon'
import { AdminCategoryTree } from './AdminCategoryTree'
import { flushSync } from 'react-dom'
import { storefrontPath, featuredProducts, browseLabel } from './catalog-navigation'
import { rankCatalogProducts } from './catalog-search'
import { FormEvent, type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ApiCategory, type ApiProduct, type BusinessReadiness, type PromoBanner, type TrackedOrder } from './api'
import { defaultStorefrontLayout, normalizeStorefrontLayout, storefrontBlocksFor, type StorefrontBlock, type StorefrontDevice, type StorefrontLayout } from './page-layout'
import { TexhoruBrand } from './TexhoruBrand'
import { PROMO_STANDARDS } from './promo-presets'

import type { AccountOrder, CartLine, Category, Product } from './types'

const money = new Intl.NumberFormat('ru-RU')
const restoreFavorites = () => {
  try {
    const value = JSON.parse(localStorage.getItem('texhoru_favorites') || '[]')
    return Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id) && id > 0).slice(0, 100) : []
  } catch { return [] }
}
const scrollProductStory = (productId: number, direction: -1 | 1) => {
  const track = document.getElementById(`product-story-track-${productId}`)
  if (track) track.scrollBy({ left: track.clientWidth * direction, behavior: 'smooth' })
}
type AccountTab = 'active' | 'history' | 'profile'
type AdminTab = 'overview' | 'products' | 'content' | 'prices' | 'orders' | 'notifications' | 'sync' | 'audit'
type CreatedOrder = { number: number; trackingToken: string; paymentMethod: 'ONLINE' | 'ON_RECEIPT' }

const statusLabels: Record<string, string> = {
  NEW: 'Заказ создан', AWAITING_PAYMENT: 'Ожидает оплаты', PAID: 'Оплачен', ASSEMBLING: 'Собирается', READY: 'Готов к выдаче', DELIVERING: 'В доставке', COMPLETED: 'Получен', CANCELLED: 'Отменён',
}
const paymentLabels: Record<string, string> = { NOT_STARTED: 'Не начата', PENDING: 'В процессе', PAID: 'Оплачено', FAILED: 'Ошибка', REFUNDED: 'Возврат' }


function OrderCard({ order }: { order: AccountOrder }) {
  return <article className="order-card">
    <div className="order-card__head"><div><span className="order-card__label">Заказ</span><strong>№ {order.id.replace('T-', '')}</strong><span className="order-card__date">Оформлен {order.date}</span></div><div className={`status-badge status-badge--${order.status === 'Получен' ? 'done' : order.status === 'Отменён' ? 'cancelled' : 'active'}`}>{order.status}</div></div>
    <div className="order-card__section"><span className="order-card__label">Товары</span><p className="order-card__items">{order.items.join(', ')}</p></div>
    <div className="order-card__section"><span className="order-card__label">Получение</span><p className="order-card__delivery">{order.delivery}</p></div>
    <div className="order-card__total"><span>Сумма заказа</span><strong>{money.format(order.total)} ₽</strong></div>
  </article>
}

// A catalog card stays on the current page while its photo flies to the visible cart.
function animateProductToCart(card: HTMLElement | null) {
  if (!card || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const media = card.querySelector<HTMLElement>('.product-media')
  const image = media?.querySelector<HTMLImageElement>('img')
  if (!media || !image?.complete || !image.naturalWidth) return

  // On phones the bottom dock is the destination; on desktop it is the header.
  const target = [
    document.querySelector<HTMLElement>('.mobile-dock [data-cart-target]'),
    document.querySelector<HTMLElement>('.header-actions [data-cart-target]'),
  ].find(element => element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
  if (!target) return

  const from = media.getBoundingClientRect()
  const to = target.getBoundingClientRect()
  if (!from.width || !from.height || !to.width || !to.height) return

  const flyer = image.cloneNode(false) as HTMLImageElement
  flyer.loading = 'eager'
  flyer.alt = ''
  flyer.setAttribute('aria-hidden', 'true')
  Object.assign(flyer.style, {
    position: 'fixed',
    left: from.left + 'px',
    top: from.top + 'px',
    width: from.width + 'px',
    height: from.height + 'px',
    objectFit: 'contain',
    objectPosition: 'center',
    pointerEvents: 'none',
    zIndex: '9999',
    margin: '0',
    padding: '0',
    border: '0',
    background: 'transparent',
    filter: 'drop-shadow(0 12px 18px rgba(0,0,0,.16))',
    transformOrigin: 'center',
  })
  document.body.appendChild(flyer)

  const dx = to.left + to.width / 2 - (from.left + from.width / 2)
  const dy = to.top + to.height / 2 - (from.top + from.height / 2)
  const lift = Math.min(140, Math.max(55, Math.abs(dy) * .22))
  const flight = flyer.animate([
    { transform: 'translate3d(0,0,0) scale(1)', opacity: 1, offset: 0 },
    { transform: `translate3d(${dx * .52}px,${dy * .52 - lift}px,0) scale(.55)`, opacity: .92, offset: .55 },
    { transform: `translate3d(${dx}px,${dy}px,0) scale(.06)`, opacity: 0, offset: 1 },
  ], { duration: 680, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' })
  flight.addEventListener('finish', () => flyer.remove(), { once: true })
  flight.addEventListener('cancel', () => flyer.remove(), { once: true })
  target.animate([
    { transform: 'scale(1)' },
    { transform: 'scale(1.17)', offset: .45 },
    { transform: 'scale(1)' },
  ], { delay: 500, duration: 300, easing: 'ease-out' })
}

function ProductCard({ product, onOpen, onAdd, cartQuantity, onCartOpen, favorite, onFavorite }: {
  product: Product; onOpen: (product: Product) => void; onAdd: (product: Product) => void;
  cartQuantity: number; onCartOpen: () => void; favorite?: boolean; onFavorite?: (product: Product) => void;
}) {
  return <article className="product-card" data-product-id={product.id}>
    <button className="product-open" onClick={() => onOpen(product)} aria-label={`Открыть ${product.name}`}>
      <div className="product-media"><ProductImage name={product.name} image={product.image} /></div>
      <div className="product-card__copy">
        <span className="product-card__brand">{product.brand}</span>
        <div className="product-card__title-row">
          <h3>{product.name}</h3>
        </div>
        <div className="product-card__price"><strong>{money.format(product.price)} ₽</strong>{product.oldPrice != null && product.oldPrice > product.price && <del>{money.format(product.oldPrice)} ₽</del>}</div>
      </div>
    </button>
    {onFavorite && <button type="button" className={'product-card__favorite' + (favorite ? ' is-active' : '')}
      aria-pressed={favorite} aria-label={favorite ? `Убрать ${product.name} из избранного` : `Добавить ${product.name} в избранное`}
      onClick={() => onFavorite(product)}><Icon name="heart" /></button>}
    {product.badge && <span className="product-card__badge">{product.badge}</span>}
    <div className="product-card__footer">
      <span className="product-card__stock" data-stock={product.stock === 'Под заказ' ? 'preorder' : cartLimit(product) ? 'in' : 'out'}><i aria-hidden="true" />{product.stock === 'Под заказ' ? 'Под заказ' : cartLimit(product) ? 'В наличии' : 'Нет в наличии'}</span>
      <button className={'product-card__add' + (cartQuantity ? ' is-in-cart' : '')} disabled={!cartLimit(product)}
        onClick={event => {
          if (cartQuantity) { onCartOpen(); return }
          animateProductToCart(event.currentTarget.closest<HTMLElement>('.product-card'))
          onAdd(product)
        }} aria-label={cartQuantity ? `Открыть корзину: ${product.name}` : `Добавить ${product.name} в корзину`}>
        <span>{cartQuantity ? `В корзине · ${cartQuantity}` : 'В корзину'}</span><Icon name={cartQuantity ? 'arrow' : 'plus'} />
      </button>
    </div>
  </article>
}

function CheckoutPage({ cart, onBack, onCreated }: { cart: CartLine[]; onBack: () => void; onCreated: (order: CreatedOrder) => void }) {
  const [form, setForm] = useState({ customerName: '', customerPhone: '', customerEmail: '', deliveryMethod: 'PICKUP' as 'PICKUP' | 'COURIER', deliveryAddress: '', paymentMethod: 'ON_RECEIPT' as 'ONLINE' | 'ON_RECEIPT', comment: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [onlinePayment, setOnlinePayment] = useState(false)
  const orderAttempt = useRef<{ signature: string; key: string } | null>(null)
  useEffect(() => {
    let active = true
    void api.customerProfile().then(profile => { if (active) setForm(current => ({ ...current, customerName: current.customerName || profile.name, customerPhone: current.customerPhone || profile.phone || '', customerEmail: current.customerEmail || profile.email, deliveryAddress: current.deliveryAddress || profile.deliveryAddress })) }).catch(() => undefined)
    void api.paymentStatus().then(status => { if (active) setOnlinePayment(status.configured) }).catch(() => undefined)
    return () => { active = false }
  }, [])
  const total = cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0)

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setLoading(true); setError('')
    try {
      const deliveryAddress = form.deliveryMethod === 'PICKUP' ? 'Самовывоз · Кизилюрт' : form.deliveryAddress
      const input = { ...form, deliveryAddress, customerEmail: form.customerEmail || undefined,
        comment: form.comment || undefined, items: cart.map(item => ({ productId: item.product.id, quantity: item.quantity })) }
      const signature = JSON.stringify(input)
      if (orderAttempt.current?.signature !== signature) orderAttempt.current = { signature, key: crypto.randomUUID() }
      const result = await api.createOrder({ ...input, idempotencyKey: orderAttempt.current.key })
      onCreated({ number: result.number, trackingToken: result.trackingToken, paymentMethod: result.paymentMethod })
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось создать заказ') } finally { setLoading(false) }
  }

  if (!cart.length) return <section className="checkout-page checkout-empty"><p className="eyebrow">TEXHORU / Покупки</p><h1>Корзина пока пуста</h1><p>Добавьте товары, чтобы оформить заказ.</p><button className="checkout-submit" onClick={onBack}>Открыть каталог <Icon name="arrow" /></button></section>
  return <section className="checkout-page">
    <button className="back-link" onClick={onBack}><Icon name="back" /> Вернуться к покупкам</button>
    <div className="checkout-layout">
      <form className="checkout-form" onSubmit={submit}>
        <p className="eyebrow">TEXHORU / Оформление</p><h1>Ваш заказ</h1><p className="checkout-intro">Оставьте контакты. Товары будут временно зарезервированы, а менеджер подтвердит наличие.</p>
        <div className="form-grid">
          <label><span>Имя</span><input name="name" autoComplete="name" minLength={2} required value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} placeholder="Как к вам обращаться" /></label>
          <label><span>Телефон</span><input type="tel" name="tel" autoComplete="tel" minLength={6} required value={form.customerPhone} onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} placeholder="+7 999 000-00-00" /></label>
          <label className="form-grid__wide"><span>Email · необязательно</span><input name="email" autoComplete="email" type="email" value={form.customerEmail} onChange={(e) => setForm({ ...form, customerEmail: e.target.value })} placeholder="mail@example.com" /></label>
        </div>
        <div className="choice-block"><span className="choice-title">Получение</span><div className="choice-grid"><button type="button" aria-pressed={form.deliveryMethod === 'PICKUP'} className={form.deliveryMethod === 'PICKUP' ? 'choice-card active' : 'choice-card'} onClick={() => setForm({ ...form, deliveryMethod: 'PICKUP' })}><strong>Самовывоз</strong><span>Кизилюрт</span></button><button type="button" aria-pressed={form.deliveryMethod === 'COURIER'} className={form.deliveryMethod === 'COURIER' ? 'choice-card active' : 'choice-card'} onClick={() => setForm({ ...form, deliveryMethod: 'COURIER' })}><strong>Доставка</strong><span>Кизилюрт и Дагестан</span></button></div></div>
        {form.deliveryMethod === 'COURIER' && <label className="checkout-single"><span>Адрес доставки</span><input required value={form.deliveryAddress} onChange={(e) => setForm({ ...form, deliveryAddress: e.target.value })} /></label>}
        <div className="choice-block"><span className="choice-title">Оплата</span><div className="choice-grid"><button type="button" aria-pressed={form.paymentMethod === 'ON_RECEIPT'} className={form.paymentMethod === 'ON_RECEIPT' ? 'choice-card active' : 'choice-card'} onClick={() => setForm({ ...form, paymentMethod: 'ON_RECEIPT' })}><strong>При получении</strong><span>Карта или наличные</span></button>{onlinePayment && <button type="button" aria-pressed={form.paymentMethod === 'ONLINE'} className={form.paymentMethod === 'ONLINE' ? 'choice-card active' : 'choice-card'} onClick={() => setForm({ ...form, paymentMethod: 'ONLINE' })}><strong>Онлайн</strong><span>Картой на сайте</span></button>}</div></div>
        <details className="checkout-comment"><summary>Добавить комментарий</summary><label className="checkout-single"><span>Комментарий к заказу</span><textarea value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} placeholder="Пожелания к заказу" /></label></details>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="checkout-submit" disabled={!cart.length || loading}>{loading ? 'Создаём заказ…' : `Оформить заказ · ${money.format(total)} ₽`}</button>
        {form.paymentMethod === 'ONLINE' && <p className="checkout-note">Оплата откроется на защищённой странице. Данные карты не сохраняются в магазине.</p>}
      </form>
      <aside className="checkout-summary"><p className="eyebrow">Ваш выбор</p><details className="checkout-order-items" open><summary>Состав заказа · {cart.reduce((sum, item) => sum + item.quantity, 0)} шт.</summary>{cart.map((item) => <div className="checkout-item" key={item.product.id}><span className="checkout-item__image"><ProductImage name={item.product.name} image={item.product.image} alt="" /></span><div><strong>{item.product.name}</strong><span>{item.quantity} × {money.format(item.product.price)} ₽</span></div></div>)}</details><div className="checkout-total"><span>Итого</span><strong>{money.format(total)} ₽</strong></div><small className="checkout-summary-note">{form.deliveryMethod === 'PICKUP' ? 'Самовывоз · Кизилюрт' : 'Доставку согласуем при подтверждении'}</small></aside>
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
    {order && <div className="order-track__layout"><div className="order-track__main"><p className="eyebrow">Заказ принят</p><h1>№ {order.number}</h1><div className="order-track__status"><span>Статус</span><strong>{statusLabels[order.status] ?? order.status}</strong></div>{order.stockVerification === 'AWAITING_MANAGER' && <div className="checkout-note">Товары временно зарезервированы. Менеджер проверяет фактическое наличие.</div>}<div className="order-track__items">{order.items.map((item) => <div key={`${item.name}-${item.quantity}`}><span>{item.name} × {item.quantity}</span><strong>{money.format(item.price * item.quantity)} ₽</strong></div>)}</div><div className="order-track__total"><span>Итого</span><strong>{money.format(order.total)} ₽</strong></div></div><aside className="order-track__side"><div><span>Оплата</span><strong>{paymentLabels[order.paymentStatus] ?? order.paymentStatus}</strong></div><div><span>Получение</span><strong>{order.deliveryMethod === 'PICKUP' ? 'Самовывоз' : 'Доставка'}</strong></div><div><span>Наличие</span><strong>{order.stockVerification === 'VERIFIED' ? 'Подтверждено' : order.stockVerification === 'RELEASED' ? 'Резерв снят' : 'Проверяется'}</strong></div>{order.paymentMethod === 'ONLINE' && order.paymentStatus !== 'PAID' && order.status !== 'CANCELLED' && <button className="checkout-submit" onClick={pay} disabled={paying}>{paying ? 'Открываем…' : 'Оплатить онлайн'}</button>}<small>Страница обновляет статус автоматически.</small></aside></div>}
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

function StorefrontPromoCarousel({ items, onOpen }: { items: PromoBanner[]; onOpen: (promo: PromoBanner) => void }) {
  const [slideIndex, setSlideIndex] = useState(0)
  const [dragOffset, setDragOffset] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const clickBlocked = useRef(false)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ pointerId: number; startX: number; currentX: number; width: number } | null>(null)

  useEffect(() => {
    if (items.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = window.setInterval(() => {
      if (!document.hidden && !drag.current && !viewportRef.current?.matches(':hover, :focus-within')) setSlideIndex((current) => (current + 1) % items.length)
    }, 6000)
    return () => window.clearInterval(timer)
  }, [items.length])
  useEffect(() => { if (slideIndex >= items.length) setSlideIndex(0) }, [slideIndex, items.length])

  const move = (delta: number) => setSlideIndex((current) => (current + delta + items.length) % items.length)
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (items.length < 2 || (event.target as Element).closest('button:not(.storefront-slide__link)')) return
    drag.current = { pointerId: event.pointerId, startX: event.clientX, currentX: event.clientX, width: event.currentTarget.getBoundingClientRect().width }
    clickBlocked.current = false
    setDragOffset(0); setIsDragging(true)
  }
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    current.currentX = event.clientX
    if (Math.abs(event.clientX - current.startX) > 8) {
      clickBlocked.current = true
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId)
    }
    setDragOffset(event.clientX - current.startX)
  }
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const delta = current.currentX - current.startX
    const threshold = Math.max(56, current.width * .1)
    drag.current = null
    window.setTimeout(() => { clickBlocked.current = false }, 0)
    setDragOffset(0); setIsDragging(false)
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
    if (Math.abs(delta) >= threshold) move(delta < 0 ? 1 : -1)
  }

  return <section className="storefront-carousel" aria-label="Предложения TEXHORU">
    <div className="storefront-carousel__layout"><div ref={viewportRef} className={isDragging ? 'storefront-carousel__viewport is-dragging' : 'storefront-carousel__viewport'}
      onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <div className="storefront-carousel__track" style={{ transform: `translateX(calc(-${slideIndex * 100}% + ${dragOffset}px))` }}>
        {items.map((promo, index) => {
          const frame = parsePromoFrame(promo.image)
          return <div key={promo.id} className={`storefront-slide storefront-slide--${promo.tone || 'light'}`} aria-hidden={index !== slideIndex}>
            <button className="storefront-slide__link" tabIndex={index === slideIndex ? 0 : -1} onClick={() => { if (!clickBlocked.current) onOpen(promo) }} aria-label={promo.title || `Открыть предложение ${index + 1}`}><img src={frame.src} loading={index ? 'lazy' : 'eager'} style={promoFrameStyle(frame)} alt={promo.title || `Предложение ${index + 1}`} draggable={false} /></button>
          </div>
        })}
      </div>
      {items.length > 1 && <><button className="carousel-hit carousel-hit--left" onClick={() => move(-1)} aria-label="Предыдущий баннер"><Icon name="chevronLeft" /></button><button className="carousel-hit carousel-hit--right" onClick={() => move(1)} aria-label="Следующий баннер"><Icon name="chevronRight" /></button></>}
    </div></div>
  </section>
}

type PromoImageDraft = { image: string; imageX: number; imageY: number; imageZoom: number }

type PromoDraft = {
  kicker: string
  title: string
  body: string
  ctaLabel: string
  category: string
  link: string
  images: Record<StorefrontDevice, PromoImageDraft>
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
  link: `/catalog?category=${encodeURIComponent(category)}`,
  images: {
    desktop: { image: '', imageX: 50, imageY: 50, imageZoom: 1 },
    tablet: { image: '', imageX: 50, imageY: 50, imageZoom: 1 },
    mobile: { image: '', imageX: 50, imageY: 50, imageZoom: 1 },
  },
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
  value, categories: categoryOptions, editing, saving, saveError, oneCProduct, onChange, onClose, onSave,
}: {
  value: AdminProductDraft
  categories: ApiCategory[]
  editing: boolean
  saving: boolean
  saveError?: string
  oneCProduct?: ApiProduct
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
              <label className="admin-field"><span>Цена, ₽</span><input required type="number" min="0" disabled={Boolean(oneCProduct?.oneCId && !oneCProduct.priceSyncEnabled)} value={value.price} onChange={(e) => update('price', e.target.value)} placeholder="139990" /></label>
              <label className="admin-field"><span>Старая цена, ₽</span><input type="number" min="0" value={value.oldPrice} onChange={(e) => update('oldPrice', e.target.value)} placeholder="149990" /></label>
              <label className="admin-field"><span>Остаток, шт.</span><input required type="number" min="0" value={value.stockQty} onChange={(e) => update('stockQty', e.target.value)} /></label>
            </div>
            {oneCProduct?.oneCId && <p className="admin-field-note">{oneCProduct.priceSyncEnabled
              ? 'Связь с 1С активна. После изменения цена сохранится на сайте и попадёт в очередь 1С. Готово только после подтверждения 1С.'
              : 'Цена загружена из 1С и защищена от расхождения. Чтобы менять её на сайте, сначала включи товар в группу обмена на стороне 1С.'}</p>}
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
                <strong>Перетащи фото сюда</strong><span>Без фона: PNG / WEBP · до 8 МБ</span>
              </div>
              {value.image && <div className="admin-image-upload__status"><span>Сохранено:</span><code>{value.image}</code></div>}
              {imageError && <div className="form-error">{imageError}</div>}
            </div>
            <label className="admin-field admin-field--wide"><span>Или URL изображения</span><input value={value.image} onChange={(e) => update('image', e.target.value)} placeholder="https://..." /><small>Прозрачные поля и масштаб выравниваются автоматически.</small></label>
            <label className="admin-field admin-field--wide"><span>Короткие характеристики</span><input value={value.shortSpec} onChange={(e) => update('shortSpec', e.target.value)} placeholder="6.3″ · 256 GB · 5G · Titanium" /></label>
            <label className="admin-field admin-field--wide"><span>Описание</span><textarea value={value.description} onChange={(e) => update('description', e.target.value)} placeholder="Коротко и понятно опиши товар для страницы товара." /></label>
          </div>

          <div className="admin-editor__section">
            <div className="admin-editor__section-head"><strong>Характеристики</strong><button type="button" onClick={addSpec}><Icon name="plus" />Добавить</button></div>
            <div className="admin-spec-editor">{value.specs.map((spec, index) => <div className="admin-spec-row" key={index}><input value={spec.label} onChange={(e) => updateSpec(index, 'label', e.target.value)} placeholder="Параметр: Экран" /><input value={spec.value} onChange={(e) => updateSpec(index, 'value', e.target.value)} placeholder="Значение: 6.3 OLED" /><button type="button" onClick={() => removeSpec(index)} aria-label="Удалить характеристику"><Icon name="close" /></button></div>)}</div>
          </div>

          <div className="admin-editor__section">
            <div className="admin-editor__section-head"><strong>Сервис</strong><span>Показывается на странице товара</span></div>
            <div className="admin-field-grid">
              <label className="admin-field"><span>Гарантия</span><input value={value.warranty} onChange={(e) => update('warranty', e.target.value)} placeholder="1 год" /></label>
              <label className="admin-field"><span>Доставка</span><input value={value.deliveryNote} onChange={(e) => update('deliveryNote', e.target.value)} placeholder="Кизилюрт и Дагестан" /></label>
            </div>
          </div>

          {saveError && <p className="form-error" role="alert">{saveError}</p>}
          <div className="admin-editor__actions"><button type="button" onClick={onClose}>Отмена</button><button className="admin-editor__save" disabled={saving}>{saving ? 'Сохраняем…' : editing ? 'Сохранить изменения' : 'Добавить товар'}</button></div>
        </form>

        <aside className="admin-editor__preview">
          <div className="admin-editor__preview-sticky">
            <span className="admin-preview-label">Предпросмотр карточки</span>
            <article className="admin-live-card">
              <div className="admin-live-card__media">{value.badge && <span className="badge">{value.badge}</span>}<ProductImage name={value.name} image={value.image} alt="" /></div>
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
  const [priceSetup, setPriceSetup] = useState(false)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [products, setProducts] = useState<AdminProduct[]>([])
  const [orders, setOrders] = useState<any[]>([])
  const [notifications, setNotifications] = useState<any[]>([])
  const [audit, setAudit] = useState<any[]>([])
  const [readiness, setReadiness] = useState<BusinessReadiness | null>(null)
  const [promos, setPromos] = useState<PromoBanner[]>([])
  const [apiCategories, setApiCategories] = useState<ApiCategory[]>([])
  const [promoEditorOpen, setPromoEditorOpen] = useState(false)
  const [editingPromoId, setEditingPromoId] = useState<string | null>(null)
  const [editingPromoBlockId, setEditingPromoBlockId] = useState('home-promos')
  const [promoDraft, setPromoDraft] = useState<PromoDraft>(() => blankPromoDraft())
  const [promoDevice, setPromoDevice] = useState<StorefrontDevice>('desktop')
  const [promoUploading, setPromoUploading] = useState(false)
  const [promoSaving, setPromoSaving] = useState(false)
  const [promoImageInfo, setPromoImageInfo] = useState('Рекомендуется 1920×720 px · 8:3 · JPG/WEBP · до 2 МБ')
  const promoCropDrag = useRef<{ pointerId: number; clientX: number; clientY: number; imageX: number; imageY: number; width: number; height: number } | null>(null)
  const [categoryCreating, setCategoryCreating] = useState(false)
  const [categoryDraft, setCategoryDraft] = useState({ name: '', slug: '' })
  const [productSearch, setProductSearch] = useState('')
  const [adminCategory, setAdminCategory] = useState('ALL')
  const [adminSection, setAdminSection] = useState('')
  const [adminLimit, setAdminLimit] = useState(36)
  const [productVisibility, setProductVisibility] = useState<'ALL' | 'ACTIVE' | 'ARCHIVED'>('ALL')
  const [showDuplicateRows, setShowDuplicateRows] = useState(false)
  useEffect(() => { setAdminLimit(36) }, [adminSection, adminCategory, productSearch, productVisibility, showDuplicateRows])
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingProductId, setEditingProductId] = useState<number | null>(null)
  const [productDraft, setProductDraft] = useState<AdminProductDraft>(() => blankProductDraft())
  const [savingProduct, setSavingProduct] = useState(false)
  const [productEditorError, setProductEditorError] = useState('')
  const [priceSyncNotice, setPriceSyncNotice] = useState('')

  const load = async () => {
    setLoading(true); setError('')
    try {
      const [p, o, n, c, promosData, auditData, readinessData] = await Promise.all([api.adminProducts(), api.adminOrders(), api.adminNotifications(), api.adminCategories(), api.adminPromos(), api.auditLogs(), api.businessReadiness()])
      setProducts(p); setOrders(o); setNotifications(n); setApiCategories(c); setPromos(promosData); setAudit(auditData); setReadiness(readinessData)
      setProductDraft((value) => value.categoryId ? value : { ...value, categoryId: c[0]?.id ?? '' })
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить админку') } finally { setLoading(false) }
  }

  useEffect(() => {
    api.me().then(async user => { if (!['ADMIN', 'MANAGER', 'DIRECTOR'].includes(user.role)) throw new Error('Недостаточно прав'); setAuthenticated(true); await load() }).catch(() => setAuthenticated(false)).finally(() => setCheckingSession(false))
  }, [])

  const login = async (event: FormEvent) => {
    event.preventDefault(); setLoading(true); setError('')
    try { await api.login(email, password); setAuthenticated(true); await load() }
    catch (e) { setError(e instanceof Error ? e.message : 'Ошибка входа'); setLoading(false) }
  }

  const openCreateProduct = (categoryId?: string) => {
    const preferredCategory = categoryId ?? (adminCategory !== 'ALL' && apiCategories.some((item) => item.id === adminCategory && item.isActive !== false) ? adminCategory : apiCategories.find((item) => item.isActive !== false)?.id ?? '')
    setEditingProductId(null)
    setProductEditorError('')
    setProductDraft(blankProductDraft(preferredCategory))
    setEditorOpen(true)
  }

  const openEditProduct = (item: AdminProduct) => {
    setProductEditorError('')
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
    event.preventDefault(); setSavingProduct(true); setError(''); setProductEditorError(''); setPriceSyncNotice('')
    const before = editingProductId !== null ? products.find(item => item.id === editingProductId) : undefined
    const queuePrice = Boolean(before?.oneCId && before.priceSyncEnabled
      && Number(productDraft.price) !== before.price)
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
      if (queuePrice) setPriceSyncNotice('Цена сохранена на сайте и отправлена в очередь 1С. Статус передачи: вкладка «1С».')
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось сохранить товар'
      setError(message); setProductEditorError(message)
    } finally { setSavingProduct(false) }
  }

  const notifyPromoChanged = () => window.dispatchEvent(new Event('texhoru:promos-changed'))

  const promoStandards = PROMO_STANDARDS
  const activePromoImage = promoDraft.images[promoDevice]
  const updatePromoImage = (patch: Partial<PromoImageDraft>) => setPromoDraft((current) => ({
    ...current,
    images: { ...current.images, [promoDevice]: { ...current.images[promoDevice], ...patch } },
  }))

  const openCreatePromo = (blockId: string, device: StorefrontDevice) => {
    const categoryName = apiCategories.find((item) => item.isActive !== false)?.name ?? 'Смартфоны'
    const blockPromos = promos.filter((item) => item.blockId === blockId && item.device === device)
    const nextSort = blockPromos.length ? Math.max(...blockPromos.map((item) => item.sortOrder ?? 0)) + 10 : 0
    setEditingPromoId(null)
    setEditingPromoBlockId(blockId)
    setPromoDevice(device)
    setPromoDraft(blankPromoDraft(nextSort, categoryName))
    setPromoImageInfo(`Рекомендуется ${promoStandards[device].label} · JPG/WEBP · до 2 МБ`)
    setPromoEditorOpen(true)
  }

  const openEditPromo = (item: PromoBanner, device: StorefrontDevice) => {
    setEditingPromoId(item.id)
    setEditingPromoBlockId(item.blockId || 'home-promos')
    setPromoDevice(device)
    const frame = parsePromoFrame(item.image || '')
    const images = blankPromoDraft().images
    images[device] = { image: frame.src, imageX: frame.x, imageY: frame.y, imageZoom: frame.zoom }
    setPromoDraft({
      kicker: item.kicker || 'АКЦИЯ', title: item.title || '', body: item.body || '', ctaLabel: item.ctaLabel || 'Смотреть',
      category: item.category || apiCategories.find((category) => category.isActive !== false)?.name || 'Смартфоны',
      link: item.link || `/catalog?category=${encodeURIComponent(item.category || 'Все')}`,
      images,
      tone: item.tone || 'light', sortOrder: String(item.sortOrder ?? 0), isActive: item.isActive !== false,
    })
    setPromoImageInfo(`Изображение этой версии · ${promoStandards[device].label}`)
    setPromoEditorOpen(true)
  }

  const inspectPromoImage = (file: File, device: StorefrontDevice) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      const ratio = image.naturalWidth / image.naturalHeight
      const standard = promoStandards[device]
      const target = standard.ratio
      const ratioOk = Math.abs(ratio - target) < 0.13
      const sizeOk = image.naturalWidth >= standard.width * .8 && image.naturalHeight >= standard.height * .8
      setPromoImageInfo(`${image.naturalWidth}×${image.naturalHeight} px · ${ratioOk && sizeOk ? 'отлично подходит' : `можно использовать, но лучше ${standard.width}×${standard.height}`}`)
      URL.revokeObjectURL(objectUrl)
    }
    image.onerror = () => URL.revokeObjectURL(objectUrl)
    image.src = objectUrl
  }

  const uploadPromoFile = async (file: File) => {
    setError('')
    if (file.size > 8 * 1024 * 1024) { setError('Фото акции больше 8 МБ'); return }
    const targetDevice = promoDevice
    inspectPromoImage(file, targetDevice)
    setPromoUploading(true)
    try {
      const uploaded = await api.adminUploadPromoImage(file)
      setPromoDraft((current) => ({ ...current, images: { ...current.images, [targetDevice]: { image: uploaded.url, imageX: 50, imageY: 50, imageZoom: 1 } } }))
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить фото акции') }
    finally { setPromoUploading(false) }
  }

  const startPromoCropDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activePromoImage.image || (event.target as HTMLElement).closest('label, button, input')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const rect = event.currentTarget.getBoundingClientRect()
    promoCropDrag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, imageX: activePromoImage.imageX, imageY: activePromoImage.imageY, width: rect.width, height: rect.height }
  }

  const movePromoCropDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = promoCropDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    const dx = event.clientX - drag.clientX
    const dy = event.clientY - drag.clientY
    const zoom = Math.max(1, promoDraft.images[promoDevice].imageZoom)
    setPromoDraft((current) => ({
      ...current,
      images: { ...current.images, [promoDevice]: {
        ...current.images[promoDevice],
        imageX: clampPromo(drag.imageX - (dx / Math.max(1, drag.width)) * 100 / zoom, 0, 100),
        imageY: clampPromo(drag.imageY - (dy / Math.max(1, drag.height)) * 100 / zoom, 0, 100),
      } },
    }))
  }

  const endPromoCropDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (promoCropDrag.current?.pointerId !== event.pointerId) return
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
    promoCropDrag.current = null
  }

  const zoomPromoCrop = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!activePromoImage.image) return
    event.preventDefault()
    const delta = event.deltaY < 0 ? 0.08 : -0.08
    updatePromoImage({ imageZoom: clampPromo(activePromoImage.imageZoom + delta, 1, 2.5) })
  }

  const savePromo = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    if (!activePromoImage.image) { setError('Добавь изображение для этого слайда'); return }
    setPromoSaving(true)
    const payload = {
      blockId: editingPromoBlockId,
      device: promoDevice,
      kicker: promoDraft.kicker.trim() || 'АКЦИЯ',
      title: promoDraft.title.trim() || `Акция ${promos.filter((item) => item.blockId === editingPromoBlockId).length + 1}`,
      body: promoDraft.body.trim(),
      ctaLabel: promoDraft.ctaLabel.trim() || 'Смотреть',
      category: promoDraft.category,
      link: promoDraft.link.trim() || `/catalog?category=${encodeURIComponent(promoDraft.category || 'Все')}`,
      image: encodePromoFrame(activePromoImage.image, activePromoImage.imageX, activePromoImage.imageY, activePromoImage.imageZoom),
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
    const deviceLabel = item.device === 'mobile' ? 'Телефон' : item.device === 'tablet' ? 'Планшет' : 'Компьютер'
    if (!confirm(`Удалить слайд «${item.title || 'Без названия'}» только из версии «${deviceLabel}»?`)) return
    try { await api.adminDeletePromo(item.id); await load(); notifyPromoChanged() }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось удалить акцию') }
  }

  const createCategory = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    try {
      const created = await api.adminCreateCategory({ name: categoryDraft.name.trim(), slug: categoryDraft.slug.trim() || slugifyProduct(categoryDraft.name), sortOrder: apiCategories.length * 10 })
      setCategoryDraft({ name: '', slug: '' }); setCategoryCreating(false); setAdminCategory('ALL'); setAdminSection(categorySelection(created.name)); await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось создать группу') }
  }

  const adminPath = selectedCategoryPath(adminSection) || ''
  const duplicateCount = products.filter(p => Boolean(p.duplicateOf)).length
  const adminCategoryItems = useMemo(() => products.filter(p => showDuplicateRows || !p.duplicateOf)
    .map(p => storefrontPath(p.category?.name || 'Без категории',p.name)), [products, showDuplicateRows])
  const adminTree = useMemo(() => categoryTree([...apiCategories.map(c => c.name),...adminCategoryItems]), [apiCategories,adminCategoryItems])
  const adminFolders = useMemo(() => childrenAtPath(adminTree, adminPath), [adminTree, adminPath])

  const productGroups = useMemo(() => {
    const q = productSearch.trim().toLowerCase()
    const visibleByStatus = (item: AdminProduct) =>
      (showDuplicateRows || !item.duplicateOf) &&
      (productVisibility === 'ALL' || item.status === productVisibility)
    return apiCategories.map((category) => ({
      category,
      items: products.filter((item) => item.category?.id === category.id
        && (productSearch.trim()
          ? inCatalogSection({ name: item.name, categoryName: storefrontPath(item.category?.name || '',item.name) }, adminSection)
          : Boolean(adminPath) && storefrontPath(item.category?.name || '',item.name) === adminPath)
        && (adminCategory === 'ALL' || adminCategory === category.id) && visibleByStatus(item) && (!q || `${item.name} ${item.brand} ${item.sku}`.toLowerCase().includes(q))),
      total: products.filter((item) => item.category?.id === category.id && visibleByStatus(item)).length,
    })).filter((group) => (adminCategory === 'ALL' ? group.items.length > 0 : group.category.id === adminCategory))
  }, [apiCategories, products, productSearch, adminCategory, productVisibility, adminSection, adminPath, showDuplicateRows])

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

  if (checkingSession) return <section className="admin-shell"><div className="admin-loading">Проверяем сессию…</div></section>
  if (!authenticated) return <section className="admin-shell admin-login"><button className="back-link" onClick={onBack}><Icon name="back" /> В магазин</button><form onSubmit={login}><TexhoruBrand subtitle="Управление магазином" /><h1>Вход в управление</h1><label><span>Почта</span><input type="email" autoComplete="username" required placeholder="Почта сотрудника" value={email} onChange={(e) => setEmail(e.target.value)} /></label><label><span>Пароль</span><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>{error && <div className="form-error">{error}</div>}<button className="checkout-submit" disabled={loading}>{loading ? 'Проверяем…' : 'Войти'}</button><small>Доступ для сотрудников TEXHORU.</small></form></section>

  const unread = notifications.filter((item) => !item.isRead).length
  const tabNames: Record<AdminTab, string> = { overview: 'Главная', products: 'Товары', content: 'Оформление', prices: 'Цены', orders: 'Заказы', notifications: 'Сообщения', sync: 'Номенклатура 1С', audit: 'Журнал' }
  const navigationGroups: Array<{ label: string; tabs: AdminTab[] }> = [
    { label: 'Рабочий стол', tabs: ['overview', 'prices', 'sync'] },
    { label: 'Магазин', tabs: ['products', 'orders', 'notifications', 'content'] },
  ]
  const connectProducts = () => { setPriceSetup(true); setTab('prices') }
  return <section className={`admin-shell admin-control${tab === 'content' ? ' admin-control--builder' : ''}`}>
    <aside className={'admin-sidebar' + (navigationOpen ? ' is-open' : '')}>
    <button className="admin-brand" onClick={() => { setTab('overview'); setNavigationOpen(false); window.scrollTo(0,0) }} aria-label="TEXHORU — главная управления"><TexhoruBrand subtitle="Управление магазином" /></button>
    <button type="button" className="admin-mobile-toggle" aria-expanded={navigationOpen} aria-controls="admin-navigation" onClick={() => setNavigationOpen(value => !value)}><Icon name={navigationOpen ? 'close' : 'menu'} />Разделы</button>
    <nav id="admin-navigation" className="admin-tabs" aria-label="Разделы управления магазином">
      {navigationGroups.map(section => <div className="admin-tab-group" key={section.label}>
        <span>{section.label}</span>
        <div>{section.tabs.map(item => <button type="button" aria-current={tab === item ? 'page' : undefined}
          className={tab === item ? 'active' : ''} onClick={() => { setPriceSetup(false); setTab(item); setNavigationOpen(false); if (window.innerWidth <= 780) window.scrollTo(0,0) }} key={item}><AdminIcon name={item} /><span>{tabNames[item]}</span>{item === 'notifications' && unread > 0 && <small>{unread}</small>}</button>)}</div>
      </div>)}
      <details className="admin-tabs-extra" open={tab === 'audit'}>
        <summary>Ещё</summary>
        <button type="button" className={tab === 'audit' ? 'active' : ''} onClick={() => { setTab('audit'); setNavigationOpen(false) }}><AdminIcon name="audit" />Журнал действий</button>
      </details>
    </nav>
    <div className="admin-sidebar-bottom"><button onClick={onBack}>Открыть магазин <AdminIcon name="arrow" /></button><button onClick={async () => { await api.logout().catch(() => undefined); setAuthenticated(false) }}>Выйти из аккаунта</button></div>
    </aside>
    <div className={`admin-workspace${tab === 'content' ? ' admin-workspace--builder' : ''}${tab === 'sync' ? ' admin-workspace--nomenclature' : ''}`}>
    <div className="admin-top"><div><p className="eyebrow">Управление</p><h1>{tab === 'overview' ? 'Рабочий стол' : tabNames[tab]}</h1></div><div className="admin-top__actions"><span className={error ? 'api-state api-state--bad' : 'api-state'}>{error ? 'Ошибка связи' : loading ? 'Синхронизация…' : 'Сайт на связи'}</span><button onClick={() => void load()} disabled={loading} aria-label="Обновить данные"><AdminIcon name="refresh" /><span>Обновить</span></button></div></div>
    {error && <div className="admin-error">{error}</div>}
    {priceSyncNotice && <div className="admin-loading" role="status">{priceSyncNotice}</div>}
    {loading && <div className="admin-loading">Загрузка…</div>}
    {tab === 'overview' && <>
      {readiness && <section className="admin-launch-readiness" aria-label="Готовность магазина">
        <div className="admin-launch-readiness__head"><div><span className={readiness.oneC.orderWritesEnabled || readiness.oneC.priceWritesEnabled ? 'is-warning' : 'is-safe'} /><p><strong>{readiness.oneC.orderWritesEnabled || readiness.oneC.priceWritesEnabled ? 'Проверьте исходящий обмен с 1С' : 'Безопасный предпродакшен'}</strong><small>{readiness.oneC.orderWritesEnabled || readiness.oneC.priceWritesEnabled ? 'Один из каналов записи включён' : 'Покупатели и заказы работают · оплата и запись в 1С выключены'}</small></p></div><b>{readiness.catalog.available} товаров доступно</b></div>
        <div className="admin-launch-readiness__grid">
          <article><span>1С</span><strong>{readiness.oneC.orderWritesEnabled || readiness.oneC.priceWritesEnabled ? 'Есть исходящий обмен' : 'Только чтение'}</strong><small>{readiness.oneC.mode}</small></article>
          <article><span>Письма</span><strong>{readiness.orders.emailConfigured ? 'Подключены' : 'Нужен SMTP'}</strong><small>{readiness.orders.messages.PENDING || 0} ожидают отправки</small></article>
          <article><span>Резервы</span><strong>{readiness.orders.pendingReservations}</strong><small>автоотмена через {Math.round(readiness.orders.reservationMinutes / 60)} ч.</small></article>
          <article><span>Карточки</span><strong>{readiness.catalog.missingImage + readiness.catalog.missingDescription}</strong><small>нужно дополнить фото или текстом</small></article>
        </div>
      </section>}
      <div className="admin-overview-heading">
        <span className="admin-section-kicker">Быстрый старт</span><h2>Что делаем сегодня?</h2>
      </div>
      <div className="admin-quests">
        <button className="admin-quest admin-quest-primary" onClick={() => { setPriceSetup(false); setTab('prices') }}><span className="admin-quest-top"><AdminIcon name="prices" /><small>01 / Цены</small></span><strong>Обновить<br/>цены</strong><span className="admin-quest-footer">05.ru → 1С → сайт <AdminIcon name="arrow" /></span></button>
        <button className="admin-quest" onClick={connectProducts}><span className="admin-quest-top"><AdminIcon name="plus" /><small>02 / Связи</small></span><strong>Связи<br/>с 05.ru</strong><span className="admin-quest-footer">Найти совпадения <AdminIcon name="arrow" /></span></button>
        <button className="admin-quest" onClick={() => setTab('products')}><span className="admin-quest-top"><AdminIcon name="products" /><small>03 / Каталог</small></span><strong>Управлять<br/>товарами</strong><span className="admin-quest-footer">Разделы и карточки <AdminIcon name="arrow" /></span></button>
      </div>
      <div className="admin-metrics admin-metrics-main">
        <article><span>На витрине</span><strong>{products.filter(p => p.status === 'ACTIVE' && !p.duplicateOf && (!p.oneCId || (p.price > 0 && p.stockQty > (p.reservedQty || 0)))).length}</strong><AdminIcon name="products" /></article>
        <article><span>Из 1С</span><strong>{products.filter(p => p.oneCId).length}</strong><AdminIcon name="sync" /></article>
        <article><span>Заказов</span><strong>{orders.length}</strong><AdminIcon name="orders" /></article>
        <article><span>Новых сообщений</span><strong>{unread}</strong><AdminIcon name="notifications" /></article>
      </div>
      <details className="admin-overview-more">
        <summary>Дополнительные сведения</summary>
        <div className="admin-metrics">
          <article><span>Товаров в наличии из 1С</span><strong>{products.filter(p => p.oneCId && p.status === 'ACTIVE' && p.stockQty > (p.reservedQty || 0)).length}</strong></article>
          <article><span>Разделов товаров</span><strong>{apiCategories.length}</strong></article>
          <article><span>Скрытых товаров</span><strong>{products.filter(p => p.status === 'ARCHIVED').length}</strong></article>
          <article><span>Мало товара</span><strong>{products.filter(p => Math.max(0, p.stockQty - (p.reservedQty ?? 0)) <= 3).length}</strong></article>
        </div>
      </details>
    </>}

    {tab === 'products' && <div className="admin-products-v2">
      <details className="admin-category-panel">
        <summary>Разделы каталога</summary>
        <div className="admin-category-panel__head"><div><span>Каталог</span><strong>Группы товаров</strong></div><button className="admin-category-add" onClick={() => setCategoryCreating((value) => !value)}><AdminIcon name="plus" />Группа</button></div>
        {categoryCreating && <form className="admin-category-create" onSubmit={createCategory}><input autoFocus required placeholder="Название группы" value={categoryDraft.name} onChange={(e) => setCategoryDraft({ name: e.target.value, slug: slugifyProduct(e.target.value) })} /><input required placeholder="slug" value={categoryDraft.slug} onChange={(e) => setCategoryDraft({ ...categoryDraft, slug: slugifyProduct(e.target.value) })} /><div><button type="button" onClick={() => setCategoryCreating(false)}>Отмена</button><button>Создать</button></div></form>}
        <AdminCategoryTree categoryNames={apiCategories.filter(c => c.isActive !== false).map(c => c.name)}
          productCategoryNames={adminCategoryItems} selectedPath={adminPath}
          onSelect={value => { setAdminCategory('ALL'); setAdminSection(value ? categorySelection(value) : ''); setProductSearch('') }} />
      </details>

      <div className="admin-catalog-workspace" key={adminPath || 'all'}>
        <div className="admin-catalog-toolbar"><div><p className="eyebrow">Товары</p><h2>{adminPath ? browseLabel(adminPath.split(' / ').at(-1) || '') : 'Каталог товаров'}</h2></div><div className="admin-catalog-toolbar__actions"><label className="admin-product-search"><Icon name="search" /><input value={productSearch} onChange={(e) => setProductSearch(e.target.value)} placeholder="Название, бренд или SKU" /></label><button className="admin-add-product" onClick={connectProducts}><AdminIcon name="sync" />Связи с 05.ru</button><button onClick={() => openCreateProduct()}><AdminIcon name="plus" />Вручную</button></div></div>
        {adminPath && <nav className="admin-category-context" aria-label="Путь категории">
          <button type="button" onClick={() => {setAdminSection('');setProductSearch('')}}>Все разделы</button>
          {categorySegments(adminPath).map((part,index,parts) => <span key={index}><span aria-hidden="true">/</span>
            <button type="button" onClick={() => {setAdminSection(categorySelection(parts.slice(0,index+1).join(' / ')));setProductSearch('')}}>{part}</button></span>)}
        </nav>}
        <p className="admin-category-description">{adminPath ? 'Выбери подраздел ниже или открой карточку товара.' : 'Открой раздел, чтобы увидеть его категории и товары.'}</p>
        <div className="admin-product-visibility" aria-label="Статус товаров">
          <button className={productVisibility === 'ALL' ? 'active' : ''} onClick={() => setProductVisibility('ALL')}>Все <span>{products.filter(p => showDuplicateRows || !p.duplicateOf).length}</span></button>
          <button className={productVisibility === 'ACTIVE' ? 'active' : ''} onClick={() => setProductVisibility('ACTIVE')}>На сайте <span>{products.filter((item) => item.status === 'ACTIVE' && (showDuplicateRows || !item.duplicateOf)).length}</span></button>
          <button className={productVisibility === 'ARCHIVED' ? 'active' : ''} onClick={() => setProductVisibility('ARCHIVED')}>Скрытые <span>{products.filter((item) => item.status === 'ARCHIVED' && (showDuplicateRows || !item.duplicateOf)).length}</span></button>
          {duplicateCount > 0 && <button className={showDuplicateRows ? 'active' : ''} onClick={() => setShowDuplicateRows(value => !value)}>
            {showDuplicateRows ? 'Скрыть повторы' : 'Посмотреть повторы'} <span>{duplicateCount}</span>
          </button>}
        </div>

        {!productSearch.trim() && adminFolders.length > 0 &&
          <div className="admin-folder-cards">{adminFolders.map(child =>
            <button key={child.path} className="admin-folder-card" onClick={() => { setAdminCategory('ALL'); setAdminSection(categorySelection(child.path)) }}>
              <b><AdminIcon name="products" />{browseLabel(child.title)}</b>
              <span>{products.filter(p => (showDuplicateRows || !p.duplicateOf) && (storefrontPath(p.category?.name || '', p.name) === child.path || storefrontPath(p.category?.name || '', p.name).startsWith(child.path + ' / '))).length} товаров</span>
              <AdminIcon name="arrow" />
            </button>)}
          </div>}
        {<>{(productGroups.length > 0 || productSearch.trim()) && <div className="catalog-result-count">{productGroups.reduce((n, g) => n + g.items.length, 0)} товаров · показано до {adminLimit}</div>}
        <div className="admin-product-groups">{productGroups.filter((_, i) => productGroups.slice(0, i).reduce((n, g) => n + g.items.length, 0) < adminLimit).map((group) => <section className="admin-product-group" key={group.category.id}>
          <div className="admin-product-group__head"><div><h3>{browseLabel(adminPath.split(' / ').at(-1) || group.category.name.split(' / ').at(-1) || '')}</h3><span>{group.total} {group.total === 1 ? 'товар' : 'товаров'}</span></div><button onClick={() => openCreateProduct(group.category.id)}><AdminIcon name="plus" />Добавить в группу</button></div>
          {group.items.length ? <div className="admin-product-grid">{group.items.slice(0, Math.max(0, adminLimit - productGroups.slice(0, productGroups.indexOf(group)).reduce((n, g) => n + g.items.length, 0))).map((item) => <article className={item.status === 'ARCHIVED' ? 'admin-product-tile is-archived' : 'admin-product-tile'} key={item.id}>
            <button className="admin-product-tile__main" onClick={() => openEditProduct(item)}>
              <div className="admin-product-tile__image"><ProductImage name={item.name} image={item.image} alt="" />{item.status === 'ARCHIVED' && <span>Скрыт</span>}</div>
              <div className="admin-product-tile__copy"><small>{item.brand} · {item.sku}</small><strong>{item.name}</strong><div><b>{money.format(item.price)} ₽</b><span>{item.stockQty} шт.</span></div></div>
            </button>
            <div className="admin-product-tile__actions">
              <button onClick={() => openEditProduct(item)}>Редактировать</button>
              {item.status === 'ARCHIVED' ? <button className="is-restore" onClick={() => restoreProduct(item)}>Вернуть на сайт</button> : <button onClick={() => archiveProduct(item)}>Скрыть</button>}
              <button className="is-danger" onClick={() => deleteProduct(item)}>Удалить</button>
            </div>
          </article>)}</div> : <div className="admin-group-empty">По этому фильтру товаров нет.</div>}
        </section>)}</div>
        {productGroups.reduce((n, g) => n + g.items.length, 0) > adminLimit && <button className="catalog-more" onClick={() => setAdminLimit(n => n + 36)}>Показать ещё 36</button>}
        {productGroups.length === 0 && adminFolders.length === 0 && <div className="admin-group-empty admin-group-empty--large">Ничего не найдено. Измени поиск или выбери другую группу.</div>}</>}
      </div>
    </div>}

    {tab === 'content' && <div className="admin-content-editor">
      <PageBuilder promos={promos} onCreatePromo={openCreatePromo} onEditPromo={openEditPromo} onTogglePromo={togglePromo} onDeletePromo={deletePromo} />

      {promoEditorOpen && <div className="promo-editor-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setPromoEditorOpen(false) }}>
        <form className="promo-editor" onSubmit={savePromo}>
          <div className="promo-editor__head"><div><p className="eyebrow">{promoDevice === 'desktop' ? 'Компьютер' : promoDevice === 'tablet' ? 'Планшет' : 'Телефон'} · отдельная лента</p><h2>{editingPromoId ? 'Изменить слайд' : 'Новый слайд'}</h2><span>Этот слайд существует только в выбранной версии сайта.</span></div><button type="button" onClick={() => setPromoEditorOpen(false)} aria-label="Закрыть"><Icon name="close" /></button></div>
          <div className="promo-editor__body">
            <div className={`promo-editor__visual is-${promoDevice}`}>
              <div
                className={`promo-editor__crop-stage is-${promoDevice}${activePromoImage.image ? ' has-image' : ''}`}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void uploadPromoFile(file) }}
                onPointerDown={startPromoCropDrag}
                onPointerMove={movePromoCropDrag}
                onPointerUp={endPromoCropDrag}
                onPointerCancel={endPromoCropDrag}
                onWheel={zoomPromoCrop}
              >
                {activePromoImage.image ? <>
                  <img
                    className="promo-editor__crop-image"
                    src={activePromoImage.image}
                    style={promoFrameStyle({ src: activePromoImage.image, x: activePromoImage.imageX, y: activePromoImage.imageY, zoom: activePromoImage.imageZoom })}
                    alt="Предпросмотр акции"
                    draggable={false}
                  />
                  <span className="promo-editor__crop-grid" aria-hidden="true" />
                  <span className="promo-editor__crop-hint">Перетаскивай фото · колесо меняет масштаб</span>
                  <label className="promo-editor__replace">{promoUploading ? 'Загрузка…' : 'Заменить фото'}<input type="file" accept="image/jpeg,image/png,image/webp,image/avif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadPromoFile(file); event.currentTarget.value = '' }} /></label>
                </> : <label className="promo-editor__dropzone promo-editor__dropzone--empty"><div><strong>Фото для версии «{promoDevice === 'desktop' ? 'Компьютер' : promoDevice === 'tablet' ? 'Планшет' : 'Телефон'}»</strong><span>{promoDevice === 'desktop' ? 'Перетащи сюда или выбери файл' : 'Если не загрузить, возьмём фото компьютера'}</span></div><input type="file" accept="image/jpeg,image/png,image/webp,image/avif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadPromoFile(file); event.currentTarget.value = '' }} /><span className="promo-editor__replace">{promoUploading ? 'Загрузка…' : 'Выбрать фото'}</span></label>}
              </div>
              {activePromoImage.image && <div className="promo-editor__crop-controls">
                <div className="promo-editor__crop-label"><span>Масштаб</span><strong>{Math.round(activePromoImage.imageZoom * 100)}%</strong></div>
                <div className="promo-editor__crop-slider"><button type="button" onClick={() => updatePromoImage({ imageZoom: clampPromo(activePromoImage.imageZoom - .08, 1, 2.5) })} aria-label="Уменьшить масштаб"><Icon name="minus" /></button><input type="range" min="1" max="2.5" step="0.01" value={activePromoImage.imageZoom} onChange={(event) => updatePromoImage({ imageZoom: Number(event.target.value) })} /><button type="button" onClick={() => updatePromoImage({ imageZoom: clampPromo(activePromoImage.imageZoom + .08, 1, 2.5) })} aria-label="Увеличить масштаб"><Icon name="plus" /></button><button type="button" className="promo-editor__crop-reset" onClick={() => updatePromoImage({ imageX: 50, imageY: 50, imageZoom: 1 })}>Сбросить</button></div>
                <small>Положение и масштаб сохраняются только для выбранной версии экрана.</small>
              </div>}
              <div className="promo-editor__image-info"><strong>{promoStandards[promoDevice].label}</strong><span>{promoImageInfo}</span></div>
            </div>
            <div className="promo-editor__fields">
              <label><span>Название в админке</span><input value={promoDraft.title} onChange={(e) => setPromoDraft({ ...promoDraft, title: e.target.value })} placeholder="Например: Осенняя акция" /></label>
              <div className="promo-editor__row"><label><span>Категория</span><select value={promoDraft.category} onChange={(e) => { const category = e.target.value; setPromoDraft({ ...promoDraft, category, link: `/catalog?category=${encodeURIComponent(category)}` }) }}>{apiCategories.filter((item) => item.isActive !== false).map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label><label><span>Порядок</span><input type="number" min="0" value={promoDraft.sortOrder} onChange={(e) => setPromoDraft({ ...promoDraft, sortOrder: e.target.value })} /></label></div>
              <label><span>Куда ведёт баннер</span><input value={promoDraft.link} onChange={(e) => setPromoDraft({ ...promoDraft, link: e.target.value })} placeholder="/product/123 или /catalog?search=iPhone" /><small>Внутренняя ссылка начинается с /, внешняя — с https://</small></label>
              <label className="promo-editor__switch"><input type="checkbox" checked={promoDraft.isActive} onChange={(e) => setPromoDraft({ ...promoDraft, isActive: e.target.checked })} /><span><strong>Показывать на сайте</strong><small>Количество активных карточек и есть количество слайдов.</small></span></label>
              <div className="promo-editor__tip"><strong>Независимая лента</strong><span>Добавление, порядок, скрытие или удаление этого слайда никак не изменит рекламу на других устройствах.</span></div>
            </div>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="promo-editor__footer"><button type="button" onClick={() => setPromoEditorOpen(false)}>Отмена</button><button className="promo-editor__save" disabled={promoSaving || promoUploading}>{promoSaving ? 'Сохраняем…' : 'Сохранить слайд'}</button></div>
        </form>
      </div>}
    </div>}
    {tab === 'prices' && <PriceApprovalDashboard products={products} initialSetup={priceSetup} onInventoryRefresh={load} />}
    {tab === 'orders' && <div className="admin-table"><div className="admin-row admin-row--orders admin-row--head"><span>№</span><span>Клиент</span><span>Сумма</span><span>Статус</span></div>{orders.map((item) => <div className="admin-row admin-row--orders" key={item.id}><span>#{item.number}<small>{item.oneCSyncedAt ? 'подтверждён 1С' : item.stockVerifiedAt ? 'наличие подтверждено' : 'временный резерв сайта'}</small></span><span><strong>{item.customerName}</strong><small>{item.customerPhone}</small></span><span>{money.format(item.total)} ₽<small>{paymentLabels[item.paymentStatus] ?? item.paymentStatus}</small></span><span><select className="admin-status-select" value={item.status} onChange={async (e) => { try { await api.adminUpdateOrderStatus(item.id, e.target.value); await load() } catch (err) { setError(err instanceof Error ? err.message : 'Ошибка статуса') } }}>{['NEW','AWAITING_PAYMENT','PAID','ASSEMBLING','READY','DELIVERING','COMPLETED','CANCELLED'].map((status) => <option key={status} value={status}>{statusLabels[status] ?? status}</option>)}</select></span></div>)}</div>}
    {tab === 'notifications' && <div className="admin-feed">{notifications.map((item) => <article key={item.id} className={item.isRead ? 'is-read' : ''}><span>{new Date(item.createdAt).toLocaleString('ru-RU')}</span><strong>{item.title}</strong><p>{item.body}</p>{!item.isRead && <button onClick={async () => { await api.adminMarkNotificationRead(item.id); await load() }}>Прочитано</button>}</article>)}</div>}
    {tab === 'sync' && <section className="admin-sync"><RemoteCatalogPanel /></section>}
    {tab === 'audit' && <div className="admin-feed">{audit.map((item) => <article key={item.id}><span>{new Date(item.createdAt).toLocaleString('ru-RU')} · {item.user?.email ?? 'system'}</span><strong>{item.action} · {item.entity}</strong><p>{item.entityId || '—'}</p></article>)}</div>}
    {editorOpen && <ProductEditor value={productDraft} categories={apiCategories.filter((item) => item.isActive !== false)} editing={editingProductId !== null} saving={savingProduct} saveError={productEditorError} oneCProduct={products.find(item => item.id === editingProductId)} onChange={setProductDraft} onClose={() => setEditorOpen(false)} onSave={saveProduct} />}
    </div>
    <nav className="admin-phone-dock" aria-label="Быстрые разделы управления">
      {(['overview','products','prices','sync'] as AdminTab[]).map(item => <button key={item} type="button" aria-current={tab === item ? 'page' : undefined} onClick={() => { setPriceSetup(false); setTab(item); setNavigationOpen(false); window.scrollTo(0,0) }}><AdminIcon name={item}/><span>{item === 'sync' ? '1С' : tabNames[item]}</span></button>)}
      <button type="button" aria-expanded={navigationOpen} aria-controls="admin-navigation" aria-label="Все разделы управления" className={['orders','content','notifications','audit'].includes(tab) ? 'active' : ''} onClick={() => setNavigationOpen(value => !value)}><Icon name={navigationOpen ? 'close' : 'menu'}/><span>Ещё{unread > 0 && <i aria-label={unread + ' новых сообщений'} />}</span></button>
    </nav>
  </section>
}

let catalogTransition: { finished: Promise<void>; skipTransition: () => void } | undefined
function animateCatalog(update: () => void, source?: HTMLElement | null) {
  catalogTransition?.skipTransition()
  const doc = document as Document & { startViewTransition?: (update: () => void) => { finished: Promise<void>; skipTransition: () => void } }
  if (!doc.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update()
    return
  }
  // Give the clicked label the identity of the next heading.
  const previousHeading = document.querySelector<HTMLElement>('.phone-journey__heading')
  const brandSwitch = Boolean(source && previousHeading)
  if (brandSwitch) {
    document.documentElement.classList.add('phone-brand-switch')
    previousHeading!.style.viewTransitionName = 'none'
    source!.style.viewTransitionName = 'phone-brand-title'
  }
  const transition = doc.startViewTransition(() => {
    flushSync(update)
    source?.style.removeProperty('view-transition-name')
    previousHeading?.style.removeProperty('view-transition-name')
  })
  catalogTransition = transition
  void transition.finished.catch(() => undefined).finally(() => {
    if (catalogTransition === transition) {
      catalogTransition = undefined
      document.documentElement.classList.remove('phone-brand-switch')
    }
  })
}

function App() {
  const [category, setCategory] = useState<Category>('Все')
  const [storeSection, setStoreSection] = useState('')
  const [storeLimit, setStoreLimit] = useState(24)
  const [sort, setSort] = useState('recommended')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [onlyAvailable, setOnlyAvailable] = useState(false)
  const [brandFilter, setBrandFilter] = useState('')
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(() => /^\/favorites\/?$/.test(window.location.pathname))
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [query, setQuery] = useState('')
  const [catalogGroups, setCatalogGroups] = useState<Array<{ path: string; brand: string; count: number }>>([])
  const [remoteCatalog, setRemoteCatalog] = useState<{ items: Product[]; total: number; hasMore: boolean }>({ items: [], total: 0, hasMore: false })
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState('')
  const [detailProduct, setDetailProduct] = useState<Product | undefined>()
  const [detailLoading, setDetailLoading] = useState(false)
  const [catalogProducts, setCatalogProducts] = useState<Product[]>([])
  const [favoriteIds, setFavoriteIds] = useState<number[]>(restoreFavorites)
  const [favoriteProducts, setFavoriteProducts] = useState<Product[]>([])
  const [promos, setPromos] = useState<PromoBanner[]>([])
  const [promosLoaded, setPromosLoaded] = useState(false)
  const [homeLayout, setHomeLayout] = useState<StorefrontLayout>(() => defaultStorefrontLayout())
  const [storefrontDevice, setStorefrontDevice] = useState<StorefrontDevice>(() => window.innerWidth < 700 ? 'mobile' : window.innerWidth < 1100 ? 'tablet' : 'desktop')
  const [apiOnline, setApiOnline] = useState(false)
  const [cart, setCart] = useState<CartLine[]>(() => { try { return restoreCart(localStorage.getItem('texhoru_cart')) } catch { return [] } })
  const [path, setPath] = useState(() => window.location.pathname)

  const refreshPromos = () => api.promos().then((items) => { setPromos(items); setPromosLoaded(true) }).catch(() => { setPromos([]); setPromosLoaded(false) })
  const refreshHomeLayout = () => api.storefrontLayout().then((state) => setHomeLayout(normalizeStorefrontLayout(state.layout))).catch(() => setHomeLayout(defaultStorefrontLayout()))

  useEffect(() => {
    api.products().then(async items => {
      setCatalogProducts(items); setApiOnline(true)
      try {
        const current = restoreCart(localStorage.getItem('texhoru_cart'))
        const available = current.length ? await api.cartProducts(current.map(line => line.product.id)) : []
        setCart(lines => lines.flatMap(line => { if (!current.some(saved => saved.product.id === line.product.id)) return [line]; const product = available.find(item => item.id === line.product.id) || items.find(item => item.id === line.product.id); return product && cartLimit(product) > 0 ? [{ product, quantity: Math.min(line.quantity, cartLimit(product)) }] : [] }))
      } catch { /* Keep the basket until stock can be revalidated at checkout. */ }
    }).catch(() => { setApiOnline(false); setCatalogError('Не удалось загрузить каталог. Проверьте соединение и попробуйте ещё раз.') }).finally(() => setCatalogLoading(false))
    void api.catalogSummary().then(data => setCatalogGroups(data.groups)).catch(() => undefined)
    void refreshPromos()
    void refreshHomeLayout()
    const onPromosChanged = () => { void refreshPromos() }
    const onLayoutChanged = () => { void refreshHomeLayout() }
    window.addEventListener('texhoru:promos-changed', onPromosChanged)
    window.addEventListener('texhoru:layout-changed', onLayoutChanged)
    return () => { window.removeEventListener('texhoru:promos-changed', onPromosChanged); window.removeEventListener('texhoru:layout-changed', onLayoutChanged) }
  }, [])
  useEffect(() => {
    const syncDevice = () => setStorefrontDevice(window.innerWidth < 700 ? 'mobile' : window.innerWidth < 1100 ? 'tablet' : 'desktop')
    window.addEventListener('resize', syncDevice, { passive: true })
    return () => window.removeEventListener('resize', syncDevice)
  }, [])
  useEffect(() => { try { localStorage.setItem('texhoru_cart', JSON.stringify(cart)) } catch { /* Shopping remains available when storage is blocked. */ } }, [cart])
  useEffect(() => {
    try { localStorage.setItem('texhoru_favorites', JSON.stringify(favoriteIds)) } catch { /* Favorites remain available for this session. */ }
    if (!favoriteIds.length) { setFavoriteProducts([]); return }
    let active = true
    void api.cartProducts(favoriteIds).then(items => { if (active) setFavoriteProducts(items) }).catch(() => undefined)
    return () => { active = false }
  }, [favoriteIds])
  useEffect(() => { const onPopState = () => animateCatalog(() => setPath(window.location.pathname)); window.addEventListener('popstate', onPopState); return () => window.removeEventListener('popstate', onPopState) }, [])

  const navigate = (nextPath: string, replace = false) => {
    if (window.location.pathname === nextPath) return
    const update = () => {
      window.history[replace ? 'replaceState' : 'pushState']({}, '', nextPath)
      setPath(nextPath)
      window.scrollTo({ top: 0, behavior: 'instant' })
    }
    if (/^\/(catalog\/smartphones|product\/)/.test(path) || /^\/(catalog\/smartphones|product\/)/.test(nextPath)) animateCatalog(update)
    else update()
  }
  const goHome = () => {
    setCategory('Все')
    setStoreSection('')
    setQuery('')
    setSort('recommended')
    setOnlyAvailable(false)
    setBrandFilter('')
    setMinPrice('')
    setMaxPrice('')
    setFavoritesOnly(false)
    setStoreLimit(24)
    navigate('/')
    window.scrollTo({ top: 0, behavior: 'instant' })
  }
  const journeyMatch = path.match(/^\/catalog\/smartphones(?:\/([^/]+))?\/?$/)
  const productMatch = path.match(/^\/product\/(\d+)\/?$/)
  const orderMatch = path.match(/^\/order\/([^/]+)\/?$/)
  const mockPaymentMatch = path.match(/^\/payment\/mock\/([^/]+)\/?$/)
  const selectedProduct = productMatch ? detailProduct?.id === Number(productMatch[1]) ? detailProduct : catalogProducts.find((item) => item.id === Number(productMatch[1])) : undefined
  useEffect(() => {
    if (!productMatch) return
    let active = true
    setDetailLoading(true)
    void api.product(Number(productMatch[1])).then(product => { if (active) setDetailProduct(product) }).catch(() => { if (active) setDetailProduct(undefined) }).finally(() => { if (active) setDetailLoading(false) })
    return () => { active = false }
  }, [path])
  const authScreen = /^\/register\/?$/.test(path) ? 'register' : /^\/login\/?$/.test(path) ? 'login' : null
  const isProductPage = Boolean(productMatch), isAccountPage = /^\/account\/?$/.test(path), isCheckoutPage = /^\/checkout\/?$/.test(path), isAdminPage = /^\/admin\/?$/.test(path)
  const isCatalogPage = /^\/catalog\/?$/.test(path), isCartPage = /^\/cart\/?$/.test(path), isFavoritesPage = /^\/favorites\/?$/.test(path)
  useEffect(() => { setFavoritesOnly(isFavoritesPage) }, [isFavoritesPage])
  useEffect(() => { setStoreLimit(24) }, [storeSection, category, query, sort, onlyAvailable, brandFilter, minPrice, maxPrice, favoritesOnly])
  const catalogTotal = catalogGroups.reduce((sum, group) => sum + group.count, 0) || catalogProducts.length
  const useRemoteCatalog = !favoritesOnly && catalogTotal > catalogProducts.length
  const categoryRoots = useMemo(() => catalogGroups.length
    ? categoryTreeFromCounts(catalogGroups)
    : categoryTree(catalogProducts.map(p => storefrontPath(p.category,p.name))), [catalogProducts, catalogGroups])
  const filterBrands = useMemo(() => [...new Set((catalogGroups.length ? catalogGroups.map(group => group.brand) : catalogProducts.map(product => product.brand))
    .filter(Boolean))].sort((left, right) => left.localeCompare(right, 'ru')), [catalogGroups, catalogProducts])
  const selectedBrowsePath = selectedCategoryPath(storeSection)
  const browseChildren = childrenAtPath(categoryRoots, selectedBrowsePath || '')
  const browseDepth = selectedBrowsePath ? categorySegments(selectedBrowsePath).length : 0
  const isFeaturedView = path === '/' && !favoritesOnly && !query.trim() && !storeSection && category === 'Все'
    && !brandFilter && !minPrice && !maxPrice && !onlyAvailable
  const folderOnly = false
  const localFiltered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (path === '/' && !favoritesOnly && !q && !storeSection && category === 'Все') return featuredProducts(catalogProducts, 10)
    const source = favoritesOnly ? favoriteProducts : catalogProducts
    const found = source.filter(product => {
      const virtualPath = storefrontPath(product.category, product.name)
      return (!onlyAvailable || (product.stockQty ?? 0) > 0) && (category === 'Все' || product.category === category || product.category.endsWith(' / ' + category)) &&
        (!selectedBrowsePath || virtualPath === selectedBrowsePath || virtualPath.startsWith(selectedBrowsePath + ' / ')) &&
        (!brandFilter || product.brand === brandFilter) && (!minPrice || product.price >= Number(minPrice)) && (!maxPrice || product.price <= Number(maxPrice)) &&
        (!q || `${product.name} ${product.brand} ${product.category} ${product.shortSpec} ${product.sku || ''}`.toLowerCase().includes(q))
    })
    return sort === 'price-asc' ? found.sort((a,b) => a.price-b.price) : sort === 'price-desc' ? found.sort((a,b) => b.price-a.price)
      : sort === 'name' ? found.sort((a,b) => a.name.localeCompare(b.name, 'ru')) : q ? rankCatalogProducts(found, q) : found
  }, [path, category, query, catalogProducts, favoriteProducts, favoritesOnly, storeSection, selectedBrowsePath, browseChildren.length, sort, onlyAvailable, brandFilter, minPrice, maxPrice])
  const filtered = useRemoteCatalog && !isFeaturedView ? remoteCatalog.items : localFiltered
  useEffect(() => {
    if (!useRemoteCatalog || (path !== '/' && path !== '/catalog') || isFeaturedView) return
    let active = true
    const page = Math.ceil(storeLimit / 24)
    setRemoteLoading(true); setRemoteError('')
    if (page === 1) setRemoteCatalog({ items: [], total: 0, hasMore: false })
    const timer = window.setTimeout(() => {
      void api.catalogPage({ page, take: 24, q: query.trim(), path: selectedBrowsePath || (category !== 'Все' ? category : undefined),
        brand: brandFilter || undefined, minPrice: minPrice ? Number(minPrice) : undefined, maxPrice: maxPrice ? Number(maxPrice) : undefined,
        sort, available: onlyAvailable ? 'true' : undefined,
      }).then(result => { if (active) setRemoteCatalog(current => ({ ...result, items: page === 1 ? result.items : [...current.items, ...result.items.filter(item => !current.items.some(old => old.id === item.id))] })) })
        .catch(() => { if (active) setRemoteError('Не удалось загрузить товары. Попробуйте обновить страницу.') })
        .finally(() => { if (active) setRemoteLoading(false) })
    }, query.trim() ? 200 : 0)
    return () => { active = false; clearTimeout(timer) }
  }, [useRemoteCatalog, isFeaturedView, path, query, category, selectedBrowsePath, sort, onlyAvailable, brandFilter, minPrice, maxPrice, storeLimit])
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0)
  const addToCart = (product: Product, openCart = true) => {
    if (!cartLimit(product)) return
    setCart(current => {
      const existing = current.find(item => item.product.id === product.id)
      return existing ? current.map(item => item.product.id === product.id
        ? { ...item, quantity: Math.min(cartLimit(product), item.quantity + 1) } : item) : [...current, { product, quantity: 1 }]
    })
    if (openCart) navigate('/cart')
  }
  const toggleFavorite = (product: Product) => setFavoriteIds(current => current.includes(product.id)
    ? current.filter(id => id !== product.id) : [...current, product.id].slice(-100))
  const showFavorites = () => {
    setFavoritesOnly(true); setQuery(''); setCategory('Все'); setStoreSection(''); setBrandFilter(''); setMinPrice(''); setMaxPrice('')
    if (window.location.pathname !== '/favorites') navigate('/favorites')
    else window.scrollTo({ top: 0, behavior: 'instant' })
  }
  const changeQuantity = (productId: number, delta: number) => setCart(current => current.map(item => item.product.id === productId
    ? { ...item, quantity: Math.max(1, Math.min(cartLimit(item.product), item.quantity + delta)) } : item))
  const openProduct = (product: Product) => {
    navigate(`/product/${product.id}`)
  }
  const jumpToCatalog = (nextCategory: Category = 'Все', preserveSearch = false) => {
    setFavoritesOnly(false)
    setCategory(nextCategory)
    if (!preserveSearch) setQuery('')
    setStoreSection('')
    if (window.location.pathname !== '/') {
      navigate('/')
      window.setTimeout(() => document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
    } else {
      window.requestAnimationFrame(() => document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }
  const openBrandModel = (model: string) => {
    setFavoritesOnly(false)
    setCategory('Все')
    setStoreSection('')
    setBrandFilter('')
    setMinPrice('')
    setMaxPrice('')
    setOnlyAvailable(false)
    setQuery(model)
    setStoreLimit(24)
    navigate('/catalog')
    window.requestAnimationFrame(() => document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const openPromo = (promo: PromoBanner) => {
    const target = promo.link?.trim()
    if (!target) { jumpToCatalog((promo.category || 'Все') as Category); return }
    if (/^https:\/\//i.test(target)) { window.location.assign(target); return }
    const url = new URL(target, window.location.origin)
    const product = url.pathname.match(/^\/products?\/(\d+)\/?$/)
    if (product) { navigate(`/product/${product[1]}`); return }
    if (url.pathname === '/catalog') {
      const search = url.searchParams.get('search') || url.searchParams.get('q')
      if (search) { openBrandModel(search); return }
      const targetCategory = url.searchParams.get('category')
      jumpToCatalog((targetCategory || promo.category || 'Все') as Category)
      return
    }
    navigate(url.pathname + url.search + url.hash)
  }

  const renderPromoBlock = (block: StorefrontBlock) => {
    const items = promosLoaded ? promos.filter((item) => item.blockId === block.id && item.device === storefrontDevice && item.isActive !== false).sort((a, b) => a.sortOrder - b.sortOrder) : []
    if (!items.length) return null
    return <StorefrontPromoCarousel items={items} onOpen={openPromo} />
  }

  const renderCatalogBlock = (block?: StorefrontBlock, anchor = true) => <section className={'catalog' + (isFeaturedView ? ' catalog-featured' : '') + (favoritesOnly ? ' catalog--favorites' : '')} id={anchor ? 'catalog' : undefined}>
      {favoritesOnly ? <h1 className="visually-hidden">Избранное, {filtered.length} товаров</h1> : <div className={'section-head' + (!isFeaturedView ? ' section-head--catalog' : '')}><div><p className="eyebrow">{isFeaturedView ? 'Выбор TEXHORU' : 'Каталог'}</p>
        <h2>{query.trim() ? 'Результаты поиска' : isFeaturedView ? block?.title || 'Популярные товары' : selectedBrowsePath ? browseLabel(selectedBrowsePath.split(' / ').at(-1) || '') : 'Все товары'}</h2>
      </div>{!isFeaturedView && <div className={'catalog-toolbar__controls' + (filtersOpen ? ' is-open' : '')}>
          <button type="button" className="catalog-filter-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}>
            <span>Фильтры</span><small>{[onlyAvailable, brandFilter, minPrice || maxPrice, sort !== 'recommended'].filter(Boolean).length || 'Все'}</small><Icon name={filtersOpen ? 'chevronUp' : 'chevronDown'} />
          </button>
          <label className={'catalog-filter-field catalog-stock-toggle' + (onlyAvailable ? ' is-active' : '')}><span>Наличие</span><span className="catalog-stock-toggle__control"><input type="checkbox" checked={onlyAvailable} onChange={e => setOnlyAvailable(e.target.checked)} /><b>В наличии</b></span></label>
          <label className={'catalog-filter-field' + (brandFilter ? ' is-active' : '')}><span>Бренд</span><select aria-label="Фильтр по бренду" value={brandFilter} onChange={e => setBrandFilter(e.target.value)}><option value="">Все</option>{filterBrands.map(brand => <option key={brand}>{brand}</option>)}</select></label>
          <div className={'catalog-price-filter' + (minPrice || maxPrice ? ' is-active' : '')} role="group" aria-label="Цена"><span>Цена</span><div className="catalog-price-filter__inputs"><input inputMode="numeric" aria-label="Цена от" placeholder="от" value={minPrice} onChange={e => setMinPrice(e.target.value.replace(/\D/g, '').slice(0, 7))} /><input inputMode="numeric" aria-label="Цена до" placeholder="до" value={maxPrice} onChange={e => setMaxPrice(e.target.value.replace(/\D/g, '').slice(0, 7))} /></div></div>
          <label className={'catalog-filter-field' + (sort !== 'recommended' ? ' is-active' : '')}><span>Порядок</span><select aria-label="Сортировка товаров" value={sort} onChange={e => setSort(e.target.value)}><option value="recommended">Сначала подходящие</option><option value="price-asc">Сначала дешевле</option><option value="price-desc">Сначала дороже</option><option value="name">По названию</option></select></label>
          <button className="catalog-reset" type="button" disabled={!Boolean(brandFilter || minPrice || maxPrice || onlyAvailable || sort !== 'recommended')} onClick={() => { setBrandFilter(''); setMinPrice(''); setMaxPrice(''); setOnlyAvailable(false); setSort('recommended') }}>Сбросить</button>
        </div>}</div>}

      {!folderOnly && <>
        {!favoritesOnly && isFeaturedView && <div className="catalog-toolbar catalog-toolbar--featured"><div className="catalog-result-count" aria-live="polite">{String(filtered.length)} популярных моделей в наличии</div></div>}
        {(catalogLoading || (useRemoteCatalog && remoteLoading && !remoteCatalog.items.length)) && <div className="catalog-loading" role="status">Загружаем товары…</div>}
        {(catalogError || remoteError) && <div className="empty-search" role="alert">{catalogError || remoteError}<button className="catalog-more" onClick={() => window.location.reload()}>Повторить</button></div>}
        <div className="product-grid">{filtered.slice(0,isFeaturedView ? 10 : storeLimit).map(product =>
          <ProductCard key={product.id} product={product} onOpen={openProduct} onAdd={product => addToCart(product, false)} cartQuantity={cart.find(line => line.product.id === product.id)?.quantity || 0} onCartOpen={() => navigate('/cart')} favorite={favoriteIds.includes(product.id)} onFavorite={toggleFavorite}/>)}</div>
        {!isFeaturedView && (useRemoteCatalog ? remoteCatalog.hasMore : filtered.length > storeLimit) &&
          <button className="catalog-more" disabled={remoteLoading} onClick={() => setStoreLimit(n => n + 24)}>{remoteLoading ? 'Загружаем…' : 'Показать ещё 24'}</button>}
        {!catalogLoading && !catalogError && !(useRemoteCatalog && (remoteLoading || remoteError)) && filtered.length === 0 && (favoritesOnly
          ? <section className="favorites-empty"><span className="favorites-empty__icon"><Icon name="heart" /></span><p className="eyebrow">Избранное</p><h2>Сохраняйте то, что нравится</h2><p>Нажмите на сердце у товара — он останется здесь, и его не придётся искать заново.</p><button type="button" onClick={() => navigate('/catalog')}>Открыть каталог <Icon name="arrow" /></button></section>
          : <div className="empty-search">Товары не найдены. Попробуйте другое название или выберите другой раздел.</div>)}
      </>}
    </section>

  const renderTextBlock = (block: StorefrontBlock) => <section className="storefront-text-block">
    <div><span>{block.eyebrow || 'TEXHORU'}</span><h2>{block.title || 'Новый заголовок'}</h2><p>{block.body}</p></div>
    {block.ctaLabel && <button type="button" onClick={() => jumpToCatalog((block.category || 'Все') as Category)}>{block.ctaLabel}<Icon name="arrow" /></button>}
  </section>

  const visibleHomeBlocks = storefrontBlocksFor(homeLayout, storefrontDevice).filter((block) => block.visible)
  const firstProductBlock = visibleHomeBlocks.find((block) => block.type === 'products')?.id
  const renderFeaturedBlock = (block: StorefrontBlock) => {
    const content = block.type === 'promo' ? renderPromoBlock(block)
      : block.type === 'products' ? renderCatalogBlock(block, block.id === firstProductBlock)
      : renderTextBlock(block)
    if (!content) return null
    return <div key={block.id} className={`storefront-layout__block storefront-layout__block--${block.type}`} data-width={block.width}
      style={{ '--storefront-block-span': block.width } as CSSProperties}>{content}</div>
  }

  const renderHome = () => isFeaturedView
    ? <div className="storefront-page-grid" data-device={storefrontDevice}>{visibleHomeBlocks.map(renderFeaturedBlock)}</div>
    : renderCatalogBlock(undefined, true)

  const selectCatalogPath = (nextPath: string) => {
    setStoreSection(categorySelection(nextPath))
    setCategory('Все')
    setQuery('')
    setStoreLimit(24)
    window.requestAnimationFrame(() => document.querySelector('.catalog-explorer')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  const resetCatalogPath = () => {
    setStoreSection('')
    setCategory('Все')
    setQuery('')
    setStoreLimit(24)
  }
  const renderCatalogPage = () => <div className="catalog-page-v2">
    <label className="mobile-page-search catalog-page-search"><Icon name="search" /><input value={query} onChange={event => { setQuery(event.target.value); setStoreSection(''); setCategory('Все') }} placeholder="Найти товар" aria-label="Поиск по каталогу" />{query && <button type="button" onClick={() => setQuery('')} aria-label="Очистить поиск">Очистить</button>}</label>
    {!query.trim() && <CatalogExplorer roots={categoryRoots} selectedPath={selectedBrowsePath || ''} total={catalogTotal}
      onSelect={selectCatalogPath} onReset={resetCatalogPath} />}
    {(query.trim() || (selectedBrowsePath && (browseDepth >= 2 || browseChildren.length === 0))) && renderCatalogBlock(undefined, true)}
  </div>

  const renderProductPage = (product: Product) => {
    const related = catalogProducts.filter((item) => item.category === product.category && item.id !== product.id).slice(0, 6)
    const favorite = favoriteIds.includes(product.id)
    const cartQuantity = cart.find(line => line.product.id === product.id)?.quantity || 0
    const available = Boolean(cartLimit(product))
    return <section className="product-page product-studio" key={product.id}>
      <button className="back-link product-studio__back" onClick={() => navigate('/')}><Icon name="back" /><span>Каталог</span></button>

      <div className="product-page__layout product-studio__hero">
        <div className="product-page__visual product-studio__visual">
          {product.badge && <span className="badge">{product.badge}</span>}
          <ProductImage name={product.name} image={product.image} loading="eager" />
          <div className="product-studio__visual-meta"><span>{product.brand}</span>{product.sku && <span>Арт. {product.sku}</span>}</div>
        </div>

        <aside className="product-page__summary product-studio__summary">
          <div className="product-studio__identity"><p className="eyebrow">{product.brand}</p><span>{product.category.split(' / ').at(-1)}</span></div>
          <h1>{product.name}</h1>
          <p className="product-page__short">{product.shortSpec}</p>

          <div className="product-studio__purchase">
            <div className="product-page__price"><strong>{money.format(product.price)} ₽</strong>{product.oldPrice != null && product.oldPrice > product.price && <del>{money.format(product.oldPrice)} ₽</del>}</div>
            <div className="product-page__stock" data-stock={product.stock === 'Под заказ' ? 'preorder' : available ? 'in' : 'out'}><i aria-hidden="true" />{product.stock}</div>
          </div>

          <div className="product-page__actions">
            <button className="product-page__buy" disabled={!available} onClick={() => cartQuantity ? navigate('/cart') : addToCart(product)}><Icon name={cartQuantity ? 'arrow' : 'cart'} />{cartQuantity ? `В корзине · ${cartQuantity}` : 'Добавить в корзину'}</button>
            <button type="button" className={'product-page__favorite' + (favorite ? ' is-active' : '')} aria-pressed={favorite} onClick={() => toggleFavorite(product)}><Icon name="heart" /><span>{favorite ? 'Сохранено' : 'Избранное'}</span></button>
          </div>
        </aside>
      </div>

      <section className="product-story" aria-labelledby={`product-story-${product.id}`}>
        <header className="product-story__head"><h2 id={`product-story-${product.id}`}>Детали</h2></header>
        <div className="product-story__stage">
          <button type="button" className="editorial-arrow editorial-arrow--left" onClick={() => scrollProductStory(product.id, -1)} aria-label="Предыдущий блок"><Icon name="chevronLeft" /></button>
          <div className="product-story__track" id={`product-story-track-${product.id}`} tabIndex={0} aria-label="Описание, характеристики и сервис">
            <article className="product-story__panel product-story__panel--description">
              <span className="product-story__index">О товаре</span>
              <h3>{product.shortSpec || product.name}</h3>
              {product.description && product.description !== product.shortSpec && <p>{product.description}</p>}
            </article>

            <article className="product-story__panel product-story__panel--specs" id="product-specifications">
              <span className="product-story__index">Характеристики</span>
              <dl className="spec-list">{product.specs.map((spec, index) => <div key={spec.sourceId || `${spec.label}-${index}`}><dt>{spec.label}</dt><dd>{spec.value}</dd></div>)}</dl>
            </article>

            <article className="product-story__panel product-story__panel--service">
              <span className="product-story__index">Сервис</span>
              <div className="product-page__service"><div><span>Получение</span><strong>{product.deliveryNote}</strong></div><div><span>Гарантия</span><strong>{product.warranty}</strong></div><div><span>Оплата</span><strong>При оформлении заказа</strong></div></div>
            </article>
          </div>
          <button type="button" className="editorial-arrow editorial-arrow--right" onClick={() => scrollProductStory(product.id, 1)} aria-label="Следующий блок"><Icon name="chevronRight" /></button>
        </div>
      </section>

      {related.length > 0 && <div className="related-block"><div className="section-head section-head--compact"><h2>Похожее</h2></div><div className="product-grid product-grid--related">{related.map((item) => <ProductCard key={item.id} product={item} onOpen={openProduct} onAdd={product => addToCart(product, false)} cartQuantity={cart.find(line => line.product.id === item.id)?.quantity || 0} onCartOpen={() => navigate('/cart')} favorite={favoriteIds.includes(item.id)} onFavorite={toggleFavorite} />)}</div></div>}
    </section>
  }

  const tokenFromQuery = new URLSearchParams(window.location.search).get('token') || ''
  let content
  if (isAdminPage) content = <AdminPage onBack={goHome} />
  else if (isCatalogPage) content = renderCatalogPage()
  else if (isCartPage) content = <CartDrawer page cart={cart} online={apiOnline} onClose={goHome} onOpenProduct={openProduct} onQuantity={changeQuantity} onRemove={id => setCart(current => current.filter(item => item.product.id !== id))} onCheckout={() => navigate('/checkout')} />
  else if (journeyMatch) content = <section className="catalog-empty-page" aria-label="Каталог" />
  else if (mockPaymentMatch) content = <MockPaymentPage paymentId={mockPaymentMatch[1]} trackingToken={tokenFromQuery} onDone={() => navigate(`/order/${tokenFromQuery}`)} />
  else if (orderMatch) content = <OrderStatusPage trackingToken={orderMatch[1]} onHome={goHome} />
  else if (isCheckoutPage) content = <CheckoutPage cart={cart} onBack={goHome} onCreated={(order) => { setCart([]); navigate(`/order/${order.trackingToken}`) }} />
  else if (isAccountPage || authScreen) content = <AccountPage screen={authScreen || 'account'} onNavigate={navigate} onHome={goHome} onOrder={token => navigate(`/order/${token}`)} />
  else if (isProductPage) content = selectedProduct ? renderProductPage(selectedProduct) : detailLoading || catalogLoading ? <div className="catalog-loading" role="status">Открываем товар…</div> : <section className="not-found"><p className="eyebrow">404</p><h1>Товар не найден</h1><button className="hero-link" onClick={() => navigate('/')}>Вернуться в магазин <Icon name="arrow" /></button></section>
  else content = renderHome()

  const headerSection = isCartPage ? 'Корзина' : isCatalogPage ? 'Каталог' : isFavoritesPage ? 'Избранное'
    : isCheckoutPage ? 'Оформление' : isAccountPage || authScreen ? 'Личный кабинет'
    : orderMatch ? 'Заказ' : mockPaymentMatch ? 'Оплата' : isProductPage ? 'Товар'
    : journeyMatch || (path === '/' && !isFeaturedView) ? 'Каталог' : 'Главная'
  const headerHasSearch = !isFavoritesPage && !isCartPage && !isAccountPage && !authScreen
    && !isCheckoutPage && !orderMatch && !mockPaymentMatch

  return <div className={isAdminPage ? "app-shell" : "app-shell storefront"}>
  {!isAdminPage && <a className="skip-link" href="#main-content">Перейти к товарам</a>}
  {!isAdminPage && <header className={'header header--storefront' + (!headerHasSearch ? ' header--no-search' : '')}>
    <button className="brand brand-button" onClick={goHome} aria-label="TEXHORU — на главную"><TexhoruBrand section={headerSection} sectionCount={isFavoritesPage ? favoriteIds.length : undefined} /></button>
    {headerHasSearch && <label className="header-search-inline"><Icon name="search" /><input value={query} onChange={event => { if (journeyMatch || isCartPage) navigate('/'); setFavoritesOnly(false); setQuery(event.target.value); setCategory('Все'); setStoreSection('') }} onKeyDown={event => { if (event.key === 'Enter' && !isCatalogPage) jumpToCatalog('Все', true) }} placeholder="Найти товар" aria-label="Поиск по каталогу" />{query && <button type="button" onClick={() => setQuery('')} aria-label="Очистить поиск"><span>Очистить</span></button>}</label>}
    {!headerHasSearch && <div className="header-search-spacer" aria-hidden="true" />}
    <div className="header-actions">
      {!isFavoritesPage && <button className={'ghost-button header-favorites' + (favoritesOnly ? ' is-active' : '')} onClick={showFavorites} aria-pressed={favoritesOnly}><Icon name="heart" /><span>Избранное</span></button>}
      {!isAccountPage && !authScreen && <button className="ghost-button header-account" onClick={() => navigate('/account')}><Icon name="user" /><span>Личный кабинет</span></button>}
      {!isCartPage && <button className="cart-button" data-cart-target onClick={() => navigate('/cart')}><Icon name="cart" /><span className="header-cart-label">Корзина</span><span>{cartCount}</span></button>}
    </div>
    {!isCatalogPage && <div className="header-tools"><button className="header-tool header-menu-button" onClick={() => navigate('/catalog')} aria-label="Открыть каталог"><Icon name="menu" /><span>Каталог</span></button></div>}
  </header>}
  {!isAdminPage && path === '/' && isFeaturedView && <BrandNavigation products={catalogProducts} onSelectModel={openBrandModel} />}
  {!isAdminPage && !isCatalogPage && !isCartPage && !isFavoritesPage && <label className="mobile-page-search"><Icon name="search" /><input value={query} onChange={event => { if (journeyMatch) navigate('/'); setFavoritesOnly(false); setQuery(event.target.value); setCategory('Все'); setStoreSection('') }} onKeyDown={event => { if (event.key === 'Enter') jumpToCatalog('Все', true) }} placeholder="Найти товар" aria-label="Поиск по каталогу" />{query && <button type="button" onClick={() => setQuery('')}>Очистить</button>}</label>}
  <main id="main-content" tabIndex={-1}>{content}</main>{!isAdminPage && <footer className="footer footer--minimal"><button className="brand brand-button" onClick={goHome} aria-label="TEXHORU — на главную"><TexhoruBrand /></button><span className="footer-location">Кизилюрт · Дагестан</span><nav aria-label="Ссылки магазина"><button onClick={() => navigate('/catalog')}>Каталог</button><button onClick={() => navigate('/account')}>Личный кабинет</button><button className="footer-admin" onClick={() => navigate('/admin')}>Управление</button></nav></footer>}
  {!isAdminPage && <PwaInstallPrompt />}
  {!isAdminPage && <nav className="mobile-dock" aria-label="Основная навигация"><button type="button" className={path === '/' && !favoritesOnly ? 'active' : ''} onClick={goHome}><Icon name="box" /><span>Главная</span></button><button type="button" className={isCatalogPage ? 'active' : ''} onClick={() => navigate('/catalog')}><Icon name="menu" /><span>Каталог</span></button><button type="button" className={isFavoritesPage ? 'active' : ''} onClick={showFavorites}><Icon name="heart" /><span>Избранное</span>{favoriteIds.length > 0 && <b>{favoriteIds.length}</b>}</button><button type="button" className={isCartPage ? 'active' : ''} data-cart-target onClick={() => navigate('/cart')}><Icon name="cart" /><span>Корзина</span>{cartCount > 0 && <b>{cartCount}</b>}</button></nav>}

  </div>
}

export default App
