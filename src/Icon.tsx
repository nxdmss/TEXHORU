export function Icon({ name }: { name: 'search' | 'cart' | 'arrow' | 'close' | 'minus' | 'plus' | 'user' | 'box' | 'back' | 'menu' | 'chevronLeft' | 'chevronRight' | 'trash' }) {
  const paths = {
    trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/></>,
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

