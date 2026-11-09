export type AdminIconName = 'overview' | 'products' | 'content' | 'prices' | 'orders' | 'notifications' | 'sync' | 'audit' | 'arrow' | 'refresh' | 'plus'

export function AdminIcon({ name }: { name: AdminIconName }) {
  const paths = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    products: <><path d="m3 7 9-4 9 4v10l-9 4-9-4Z"/><path d="m3 7 9 4 9-4M12 11v10M7 5l10 4"/></>,
    content: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M9 9v11"/></>,
    prices: <><path d="M20 13 12 21 3 12V3h9l8 8a1.5 1.5 0 0 1 0 2Z"/><circle cx="7.5" cy="7.5" r="1"/><path d="m11 14 4-4"/></>,
    orders: <><path d="M7 6V5a5 5 0 0 1 10 0v1M5 6h14l2 15H3Z"/><path d="m9 13 2 2 4-4"/></>,
    notifications: <><path d="M4 5h16v12H9l-5 4Z"/><path d="M8 9h8M8 13h5"/></>,
    sync: <><path d="M20 7a8 8 0 0 0-14-2L3 8m0-5v5h5M4 17a8 8 0 0 0 14 2l3-3m0 5v-5h-5"/></>,
    audit: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    arrow: <><path d="M4 12h16m-6-6 6 6-6 6"/></>,
    refresh: <><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/></>,
    plus: <><path d="M12 4v16M4 12h16"/></>,
  }
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}
