import { type FormEvent, useEffect, useState } from 'react'
import { api, type CustomerOrder, type CustomerProfile } from './api'
import { Icon } from './Icon'
import './account.css'

type Mode = 'login' | 'register' | 'forgot' | 'resend' | 'verify' | 'reset'
const labels: Record<string, string> = { NEW: 'Заказ принят', AWAITING_PAYMENT: 'Ожидает оплаты', PAID: 'Оплачен', ASSEMBLING: 'Собираем заказ', READY: 'Готов к выдаче', DELIVERING: 'В пути', COMPLETED: 'Получен', CANCELLED: 'Отменён' }
const money = new Intl.NumberFormat('ru-RU')
function emailAction() {
  const params = new URLSearchParams(window.location.hash.slice(1))
  const action = params.get('action'), token = params.get('token') || ''
  return { mode: (action === 'verify' || action === 'reset' ? action : 'login') as Mode, token }
}
export function AccountPage({ onHome, onOrder }: { onHome: () => void; onOrder: (token: string) => void }) {
  const [entry, setEntry] = useState(emailAction)
  const [mode, setMode] = useState<Mode>(entry.mode)
  const [profile, setProfile] = useState<CustomerProfile | null>(null)
  const [orders, setOrders] = useState<CustomerOrder[]>([])
  const [tab, setTab] = useState<'orders' | 'history' | 'profile'>('orders')
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [emailReady, setEmailReady] = useState<boolean | null>(null)
  const [fields, setFields] = useState({ name: '', email: '', password: '', repeat: '' })
  const [draft, setDraft] = useState({ name: '', phone: '', deliveryAddress: '' })
  const [showPassword, setShowPassword] = useState(false)
  const loadOrders = () => api.customerOrders().then(setOrders)
  useEffect(() => {
    const openEmailAction = () => {
      const next = emailAction()
      if (!next.token) return
      setEntry(next); setMode(next.mode); setError(''); setNotice('')
      setFields(value => ({ ...value, password: '', repeat: '' }))
      window.history.replaceState({}, '', window.location.pathname + window.location.search)
    }
    window.addEventListener('hashchange', openEmailAction)
    return () => window.removeEventListener('hashchange', openEmailAction)
  }, [])
  useEffect(() => {
    if (entry.token) window.history.replaceState({}, '', window.location.pathname + window.location.search)
    let active = true
    void api.accountCapabilities().then(result => { if (active) setEmailReady(result.emailConfigured) }).catch(() => undefined)
    void api.customerProfile().then(async user => {
      if (!active) return
      setProfile(user); setDraft({ name: user.name, phone: user.phone || '', deliveryAddress: user.deliveryAddress })
      try { const list = await api.customerOrders(); if (active) setOrders(list) }
      catch { if (active) setError('Не удалось загрузить заказы. Обновите список.') }
    }).catch(() => undefined).finally(() => { if (active) setChecking(false) })
    return () => { active = false }
  }, [entry.token])
  function changeMode(next: Mode) { setMode(next); setError(''); setNotice(''); setFields(value => ({ ...value, password: '', repeat: '' })); setShowPassword(false) }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice('')
    if (['register', 'reset'].includes(mode) && fields.password !== fields.repeat) { setError('Пароли не совпадают'); return }
    setBusy(true)
    try {
      if (mode === 'login') {
        const result = await api.customerLogin(fields.email, fields.password)
        setProfile(result.user); setDraft({ name: result.user.name, phone: result.user.phone || '', deliveryAddress: result.user.deliveryAddress })
        setFields(value => ({ ...value, password: '', repeat: '' }))
        await loadOrders()
        return
      }
      const result = mode === 'register' ? await api.register({ email: fields.email, password: fields.password, name: fields.name })
        : mode === 'verify' ? await api.verifyEmail(entry.token)
        : mode === 'reset' ? await api.resetPassword(entry.token, fields.password)
        : mode === 'resend' ? await api.resendVerification(fields.email) : await api.forgotPassword(fields.email)
      setNotice(result.message)
      if (mode === 'verify' || mode === 'reset') { setProfile(null); setMode('login'); setFields(value => ({ ...value, password: '', repeat: '' })) }
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось выполнить запрос') }
    finally { setBusy(false) }
  }
  async function saveProfile(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try { setProfile(await api.updateCustomerProfile(draft)); setNotice('Данные сохранены. Подставим их при следующем заказе.') }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить данные') }
    finally { setBusy(false) }
  }
  async function logout() {
    setBusy(true); setError('')
    try { await api.customerLogout(); setProfile(null); setOrders([]); setDraft({ name: '', phone: '', deliveryAddress: '' }); setNotice(''); setMode('login') }
    catch { setError('Не удалось выйти. Попробуйте ещё раз.') }
    finally { setBusy(false) }
  }
  const emailMode = ['register', 'forgot', 'resend'].includes(mode)
  const titles: Record<Mode, string> = { login: 'Вход в кабинет', register: 'Создать аккаунт', forgot: 'Вернём вам доступ.', resend: 'Проверим вашу почту.', verify: 'Почти у цели.', reset: 'Новый пароль.' }
  const descriptions: Record<Mode, string> = { login: 'Войдите, чтобы видеть заказы и быстрее оформлять покупки.', register: 'Один аккаунт для ваших покупок. Начнём с имени и почты.', forgot: 'Пришлём на подтверждённую почту ссылку для смены пароля.', resend: 'Запросите новое письмо для подтверждения аккаунта.', verify: 'Подтвердите адрес одним нажатием. Затем войдите в личный кабинет.', reset: 'Придумайте надёжный пароль, который ещё нигде не использовали.' }
  const visibleOrders = orders.filter(order => tab === 'history' ? ['COMPLETED', 'CANCELLED'].includes(order.status) : !['COMPLETED', 'CANCELLED'].includes(order.status))
  return <section className="customer-page">
    <button className="back-link" onClick={onHome}><Icon name="back" /> В магазин</button>
    {checking ? <div className="customer-loading" role="status">Открываем ваш кабинет…</div> : !profile || ['verify', 'reset'].includes(mode) ? <div className="customer-entry">
      <aside className="customer-story"><span className="customer-kicker">TEXHORU / ЛИЧНОЕ</span><div><h1>Ваша техника. <br />Ваша история.</h1><p>Все покупки — в одном месте. <br />С заботой о вашем времени.</p></div><div className="customer-story__benefits"><span><Icon name="box" /> Статусы и история заказов</span><span><Icon name="user" /> Данные для быстрого оформления</span><span><Icon name="cart" /> Покупки в вашем ритме</span></div><span className="customer-story__foot">Хорошая техника. Личный подход.</span></aside>
      <div className="customer-form-wrap" aria-label="Вход и регистрация">
        {['login', 'register'].includes(mode) && <nav className="customer-form-tabs" aria-label="Доступ к кабинету"><button onClick={() => changeMode('login')} aria-pressed={mode === 'login'}>Войти</button><button onClick={() => changeMode('register')} aria-pressed={mode === 'register'}>Регистрация</button></nav>}
        <span className="customer-kicker">{mode === 'verify' ? 'ПОДТВЕРЖДЕНИЕ ПОЧТЫ' : 'РАДЫ ВАС ВИДЕТЬ'}</span><h2>{titles[mode]}</h2><p className="customer-description">{descriptions[mode]}</p>
        <form onSubmit={submit} className="customer-form">
          {mode === 'register' && <label>Ваше имя<input required minLength={2} maxLength={80} autoComplete="name" value={fields.name} onChange={e => setFields({ ...fields, name: e.target.value })} placeholder="Как к вам обращаться" /></label>}
          {!['verify', 'reset'].includes(mode) && <label>Электронная почта<input required type="email" maxLength={254} autoComplete="email" value={fields.email} onChange={e => setFields({ ...fields, email: e.target.value })} placeholder="you@example.ru" /></label>}
          {['login', 'register', 'reset'].includes(mode) && <label>Пароль<div className="customer-password"><input required aria-label="Пароль" type={showPassword ? 'text' : 'password'} minLength={mode === 'login' ? 8 : 10} maxLength={72} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={fields.password} onChange={e => setFields({ ...fields, password: e.target.value })} placeholder={mode === 'login' ? 'Ваш пароль' : 'Не менее 10 символов'} /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}>{showPassword ? 'Скрыть' : 'Показать'}</button></div></label>}
          {['register', 'reset'].includes(mode) && <label>Повторите пароль<input required type={showPassword ? 'text' : 'password'} minLength={10} maxLength={72} autoComplete="new-password" value={fields.repeat} onChange={e => setFields({ ...fields, repeat: e.target.value })} placeholder="Ещё раз, чтобы не ошибиться" /></label>}
          {mode === 'login' && <button className="customer-text-button customer-forgot" type="button" onClick={() => changeMode('forgot')}>Не помню пароль</button>}
          {emailMode && emailReady === false && <p className="customer-message" role="status">Отправка писем ещё не подключена. Вернитесь чуть позже — пока можно оформить заказ без аккаунта.</p>}
          {error && <p className="customer-error" role="alert">{error}</p>}{notice && <p className="customer-success" role="status">{notice}</p>}
          <button className="customer-submit" disabled={busy || (emailMode && emailReady === false) || (['verify', 'reset'].includes(mode) && !entry.token)}>{busy ? 'Подождите…' : mode === 'login' ? 'Войти в кабинет' : mode === 'register' ? 'Создать аккаунт' : mode === 'verify' ? 'Подтвердить почту' : mode === 'reset' ? 'Сохранить пароль' : 'Отправить письмо'}<Icon name="arrow" /></button>
          {mode === 'register' && <small className="customer-fineprint">Письмо нужно только для подтверждения адреса и доступа к аккаунту. Рекламную рассылку не подключаем.</small>}
        </form>
        <div className="customer-form-footer">{mode === 'login' ? <><span>Не пришло подтверждение?</span><button onClick={() => changeMode('resend')}>Отправить снова</button></> : <button onClick={() => changeMode('login')}>Вернуться ко входу</button>}</div>
        <button className="customer-text-button" onClick={onHome}>Продолжить покупки без входа <Icon name="arrow" /></button>
      </div>
    </div> : <>
      <header className="customer-dashboard-head"><div><span className="customer-kicker">ВАШ ЛИЧНЫЙ TEXHORU</span><h1>Здравствуйте, {profile.name.split(' ')[0]}.</h1><p>Всё важное о ваших покупках — здесь.</p></div><button className="customer-text-button" onClick={logout} disabled={busy}>Выйти из аккаунта <Icon name="arrow" /></button></header>
      <div className="customer-dashboard"><aside className="customer-sidebar"><div className="customer-id"><span className="customer-avatar">{profile.name.slice(0, 1).toUpperCase()}</span><strong>{profile.name}</strong><span>{profile.email}</span><small>✓ Почта подтверждена</small></div><nav aria-label="Разделы кабинета">{(['orders', 'history', 'profile'] as const).map(value => <button key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => { setTab(value); setNotice(''); setError('') }}>{value === 'orders' ? 'Текущие заказы' : value === 'history' ? 'История покупок' : 'Мои данные'}<Icon name={value === 'profile' ? 'user' : 'box'} /></button>)}</nav><p>Заказы, оформленные после входа, появляются в кабинете автоматически. Гостевые доступны по личной ссылке.</p></aside>
      <div className="customer-dashboard-content">
        {error && <p className="customer-error" role="alert">{error}</p>}{notice && <p className="customer-success" role="status">{notice}</p>}
        {tab === 'profile' ? <form className="customer-form customer-profile-form" onSubmit={saveProfile}><span className="customer-kicker">КОНТАКТЫ И ПОЛУЧЕНИЕ</span><h2>Удобно, когда всё заполнено.</h2><label>Ваше имя<input required autoComplete="name" minLength={2} maxLength={80} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label><label>Телефон<input type="tel" autoComplete="tel" maxLength={25} value={draft.phone} placeholder="+7 999 000-00-00" onChange={e => setDraft({ ...draft, phone: e.target.value })} /></label><label className="customer-profile-address">Адрес доставки<textarea autoComplete="street-address" maxLength={500} value={draft.deliveryAddress} onChange={e => setDraft({ ...draft, deliveryAddress: e.target.value })} placeholder="Город, улица, дом, квартира" /></label><div className="customer-email-locked"><span>Электронная почта</span><strong>{profile.email}</strong><small>Подтверждена</small></div><button className="customer-submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить данные'}<Icon name="arrow" /></button><button type="button" className="customer-text-button" disabled={busy || emailReady === false} onClick={async () => { setBusy(true); setError(''); setNotice(''); try { const result = await api.forgotPassword(profile.email); setNotice(result.message) } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось отправить письмо') } finally { setBusy(false) } }}>Сменить пароль через почту</button></form> : <><div className="customer-orders-head"><h2>{tab === 'history' ? 'История покупок' : 'Текущие заказы'} <span>{visibleOrders.length}</span></h2><button className="customer-text-button" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await loadOrders() } catch { setError('Не удалось обновить заказы') } finally { setBusy(false) } }}>Обновить</button></div>{!visibleOrders.length ? <div className="customer-empty"><span><Icon name="box" /></span><h3>{tab === 'history' ? 'Здесь будет ваша история.' : 'Новая техника ждёт вас.'}</h3><p>{tab === 'history' ? 'Завершённые и отменённые заказы появятся здесь.' : 'Выберите что-нибудь для себя. Мы сохраним заказ и покажем, как он к вам движется.'}</p><button className="customer-submit" onClick={onHome}>За покупками <Icon name="arrow" /></button></div> : <div className="customer-orders">{visibleOrders.map(order => <article className="customer-order" key={order.number}><header><div><span>ЗАКАЗ № {order.number}</span><small>{new Date(order.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</small></div><span className={'customer-order-status status-' + order.status.toLowerCase()}>{labels[order.status] || order.status}</span></header><ul>{order.items.map((item, index) => <li key={index}><span>{item.name}<small>{item.quantity} шт.</small></span><strong>{money.format(item.price * item.quantity)} ₽</strong></li>)}</ul><footer><span>{order.deliveryMethod === 'PICKUP' ? 'Самовывоз' : 'Доставка'}</span><strong>{money.format(order.total)} ₽</strong><button onClick={() => onOrder(order.trackingToken)}>Подробнее <Icon name="arrow" /></button></footer></article>)}</div>}</>}
      </div></div>
    </>}
  </section>
}
