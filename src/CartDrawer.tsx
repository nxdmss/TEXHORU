import { useEffect, useRef } from 'react'
import type { CartLine, Product } from './types'
import { Icon } from './Icon'
import { cartLimit, formatMoney, productImage } from './store-utils'

export function CartDrawer({ cart, online, onClose, onOpenProduct, onQuantity, onRemove, onCheckout }: {
  cart: CartLine[]; online: boolean; onClose: () => void; onOpenProduct: (product: Product) => void;
  onQuantity: (id: number, delta: number) => void; onRemove: (id: number) => void; onCheckout: () => void;
}) {
  const panel = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
      if (event.key !== 'Tab') return
      const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
      const first = buttons[0], last = buttons.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', keyboard)
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [])
  const count = cart.reduce((sum, item) => sum + item.quantity, 0)
  const total = cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0)
  return <div className="overlay cart-overlay" onMouseDown={e => { if (e.currentTarget === e.target) onClose() }}>
    <aside className="drawer cart-drawer" ref={panel} role="dialog" aria-modal="true" aria-labelledby="cart-title">
      <div className="drawer-head"><div><p className="eyebrow">TEXHORU / Покупки</p><h2 id="cart-title">Корзина <span>{count}</span></h2></div>
        <button className="icon-button" ref={closeButton} onClick={onClose} aria-label="Закрыть корзину"><Icon name="close" /></button></div>
      <div className="drawer-body cart-lines">
        {!cart.length ? <div className="cart-empty"><Icon name="cart" /><h3>Здесь будут ваши покупки</h3><p>Выберите товары в каталоге и добавьте их в корзину.</p><button onClick={onClose}>Продолжить покупки <Icon name="arrow" /></button></div>
          : cart.map(({ product, quantity }) => <article className="cart-line" key={product.id}>
            <button className="cart-line__image" aria-label={'Открыть ' + product.name} onClick={() => onOpenProduct(product)}>
              <img src={productImage(product)} alt="" onError={e => { e.currentTarget.src = '/products/phone.svg' }} /></button>
            <div className="cart-line-copy"><span className="cart-line-brand">{product.brand}</span>
              <button className="cart-line__title" onClick={() => onOpenProduct(product)}>{product.name}</button>
              <span className="cart-unit-price">{formatMoney(product.price)} / шт.</span>
              <div className="cart-line-controls"><div className="qty" role="group" aria-label={'Количество: ' + product.name}>
                <button disabled={quantity <= 1} aria-label={'Уменьшить количество: ' + product.name} onClick={() => onQuantity(product.id, -1)}><Icon name="minus" /></button>
                <span aria-live="polite">{quantity}</span>
                <button disabled={quantity >= cartLimit(product)} aria-label={'Увеличить количество: ' + product.name} onClick={() => onQuantity(product.id, 1)}><Icon name="plus" /></button>
              </div><strong className="cart-line-total">{formatMoney(product.price * quantity)}</strong></div>
              {quantity >= cartLimit(product) && <small className="cart-stock-limit">В корзине весь доступный остаток</small>}
            </div>
            <button className="cart-line-remove" aria-label={'Удалить из корзины: ' + product.name} onClick={() => onRemove(product.id)}><Icon name="trash" /></button>
          </article>)}
      </div>
      {!!cart.length && <div className="drawer-bottom"><div className="cart-summary-caption"><span>Товары</span><span>{count} шт.</span></div>
        <div className="total"><span>Итого</span><strong aria-live="polite">{formatMoney(total)}</strong></div>
        <button className="checkout" disabled={!online} onClick={onCheckout}>Перейти к оформлению <Icon name="arrow" /></button>
        <small>{online ? 'Способ получения и оплата — на следующем шаге.' : 'Нет связи с магазином. Попробуйте ещё раз позже.'}</small></div>}
    </aside>
  </div>
}
