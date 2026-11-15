export type IconName = 'search' | 'cart' | 'heart' | 'arrow' | 'close' | 'minus' | 'plus' | 'user' | 'box' | 'back' | 'menu' | 'chevronLeft' | 'chevronRight' | 'chevronUp' | 'chevronDown' | 'trash' | 'external' | 'undo' | 'redo' | 'expand' | 'grip' | 'desktop' | 'tablet' | 'phone'

export function Icon({ name }: { name: IconName }) {
  const paths = {
    trash: <><path d="M5 7h14"/><path d="M9 7V4.5h6V7M7.25 7l.7 13h8.1l.7-13M10 10.5v6M14 10.5v6"/></>,
    search: <><circle cx="10.75" cy="10.75" r="6.25"/><path d="m15.5 15.5 4 4"/></>,
    cart: <><path d="M3.5 4.5h2l1.8 9.25h9.4l2-6H6.15"/><path d="M8 16.75h9.5"/><circle cx="9" cy="19" r="1"/><circle cx="17" cy="19" r="1"/></>,
    heart: <path d="M20.35 5.85a5 5 0 0 0-7.1 0L12 7.1l-1.25-1.25a5 5 0 1 0-7.1 7.05L12 21l8.35-8.1a5 5 0 0 0 0-7.05Z"/>,
    arrow: <><path d="M4.5 12h15"/><path d="m14.5 7 5 5-5 5"/></>,
    back: <><path d="M19.5 12h-15"/><path d="m9.5 7-5 5 5 5"/></>,
    close: <><path d="m6 6 12 12"/><path d="M18 6 6 18"/></>,
    minus: <path d="M5.5 12h13"/>,
    plus: <><path d="M5.5 12h13"/><path d="M12 5.5v13"/></>,
    user: <><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.9-3.5 3.25-5.25 7-5.25S18.1 16.5 19 20"/></>,
    box: <><path d="m4 8 8-4 8 4v8l-8 4-8-4Z"/><path d="m4 8 8 4 8-4M12 12v8"/></>,
    menu: <><path d="M4.5 7h15"/><path d="M4.5 12h15"/><path d="M4.5 17h15"/></>,
    chevronLeft: <path d="m15 5.5-6.5 6.5 6.5 6.5"/>,
    chevronRight: <path d="m9 5.5 6.5 6.5L9 18.5"/>,
    chevronUp: <path d="m5.5 15 6.5-6.5 6.5 6.5"/>,
    chevronDown: <path d="m5.5 9 6.5 6.5L18.5 9"/>,
    external: <><path d="M14 5h5v5"/><path d="m19 5-8 8"/><path d="M18 13v5.5H5.5v-13H11"/></>,
    undo: <><path d="M9 7 5 11l4 4"/><path d="M5 11h8a6 6 0 0 1 6 6"/></>,
    redo: <><path d="m15 7 4 4-4 4"/><path d="M19 11h-8a6 6 0 0 0-6 6"/></>,
    expand: <><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></>,
    grip: <><circle cx="8" cy="7" r=".8"/><circle cx="16" cy="7" r=".8"/><circle cx="8" cy="12" r=".8"/><circle cx="16" cy="12" r=".8"/><circle cx="8" cy="17" r=".8"/><circle cx="16" cy="17" r=".8"/></>,
    desktop: <><rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/></>,
    tablet: <><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18h2"/></>,
    phone: <><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M10.5 5h3M11 18.5h2"/></>,
  }
  return <svg className="tx-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">{paths[name]}</svg>
}

