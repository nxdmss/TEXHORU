import type { Product } from './types'

const API_URL = import.meta.env.VITE_API_URL || '/api'

export type ApiCategory = { id: string; name: string; slug: string; sortOrder?: number; isActive?: boolean }
export type ApiProduct = {
  id: number
  oneCId?: string | null
  costPrice?: number | null
  gtin?: string | null
  mpn?: string | null
  attributes?: Record<string, string>
  sku: string
  slug: string
  name: string
  brand: string
  description: string
  shortSpec: string
  image: string
  price: number
  oldPrice?: number | null
  stockQty: number
  stockState: 'IN_STOCK' | 'LOW' | 'PREORDER' | 'OUT_OF_STOCK'
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED'
  badge?: string | null
  warranty: string
  deliveryNote: string
  specs: Array<{ label: string; value: string }>
  category: ApiCategory
}

export type PromoBanner = {
  id: string
  kicker: string
  title: string
  body: string
  ctaLabel: string
  category: string
  image: string
  tone: string
  sortOrder: number
  isActive: boolean
}


export type PriceMonitorItem = {
  id: string
  externalUrl: string
  externalName?: string | null
  externalSku?: string | null
  latestPrice?: number | null
  oldPrice?: number | null
  inStock?: boolean | null
  lastCheckedAt?: string | null
  lastError?: string | null
  recommendedPrice?: number | null
  recommendationReasons: string[]
  attributes: Record<string, string>
  seller?: string | null
  region?: string | null
  priceSource?: string | null
  matchStatus: string
  lastSuccessAt?: string | null
  source: { id: string; key: string; name: string; baseUrl: string }
  product?: { id: number; oneCId?: string | null; sku: string; name: string; price: number; category?: ApiCategory } | null
}

export type MonitorJob = {
  id: string; kind: string; status: string; page: number; maxPages: number; processed: number; errors: number
  lastError?: string | null; url?: string | null; createdAt: string; pendingUrls: string[]
}
export type MatchCandidate = {
  product: { id: number; oneCId?: string | null; name: string; sku: string }
  score: number; reasons: string[]; conflicts: string[]; missing: string[]
  ours: Record<string, string>; theirs: Record<string, string>
}
export type MonitorDelivery = { id: string; status: string; attempts: number; lastError?: string | null; createdAt: string; payload: Record<string, unknown> }

export type FiveRuImportResult = {
  ok: boolean
  sourceCategoryName: string
  discoveredLinks: number
  imported: number
  created: number
  updated: number
  categories: string[]
  errors: number
}

export type TrackedOrder = {
  number: number
  status: string
  paymentStatus: string
  paymentMethod: 'ONLINE' | 'ON_RECEIPT'
  deliveryMethod: 'PICKUP' | 'COURIER'
  total: number
  createdAt: string
  updatedAt: string
  items: Array<{ name: string; quantity: number; price: number }>
}

const stockLabel = (value: ApiProduct['stockState']): Product['stock'] => {
  if (value === 'LOW') return 'Мало'
  if (value === 'PREORDER' || value === 'OUT_OF_STOCK') return 'Под заказ'
  return 'В наличии'
}

const mapProduct = (item: ApiProduct): Product => ({
  id: item.id,
  oneCId: item.oneCId ?? undefined,
  sku: item.sku,
  slug: item.slug,
  name: item.name,
  category: item.category.name as Product['category'],
  brand: item.brand,
  price: item.price,
  oldPrice: item.oldPrice ?? undefined,
  badge: item.badge ?? undefined,
  stock: stockLabel(item.stockState),
  stockQty: item.stockQty,
  image: item.image || '/products/phone.svg',
  shortSpec: item.shortSpec,
  description: item.description,
  specs: Array.isArray(item.specs) ? item.specs : [],
  warranty: item.warranty,
  deliveryNote: item.deliveryNote,
})

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: 'include',
      cache: 'no-store',
      headers: { ...(isFormData ? {} : { 'content-type': 'application/json' }), ...(init?.headers ?? {}) },
    })
  } catch {
    throw new Error('Backend недоступен. Запусти TEXHORU API и повтори.')
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const message = Array.isArray(payload?.message) ? payload.message.join(', ') : payload?.message
    throw new Error(message || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

export const api = {
  async products() { return (await request<ApiProduct[]>('/products')).map(mapProduct) },
  categories() { return request<ApiCategory[]>('/categories') },
  promos() { return request<PromoBanner[]>('/content/promos') },
  createOrder(input: {
    customerName: string
    customerPhone: string
    customerEmail?: string
    deliveryMethod: 'PICKUP' | 'COURIER'
    deliveryAddress: string
    paymentMethod: 'ONLINE' | 'ON_RECEIPT'
    comment?: string
    idempotencyKey: string
    items: Array<{ productId: number; quantity: number }>
  }) { return request<{ id: string; number: number; total: number; status: string; trackingToken: string; paymentMethod: 'ONLINE' | 'ON_RECEIPT' }>('/orders', { method: 'POST', body: JSON.stringify(input) }) },
  trackOrder(token: string) { return request<TrackedOrder>(`/orders/track/${encodeURIComponent(token)}`) },
  paymentStatus() { return request<{ provider: string; configured: boolean; mode: string; message: string }>('/payments/status') },
  createPaymentSession(trackingToken: string) { return request<{ paid: boolean; provider?: string; paymentId?: string; checkoutUrl?: string; orderNumber?: number }>('/payments/session', { method: 'POST', body: JSON.stringify({ trackingToken }) }) },
  completeMockPayment(paymentId: string, trackingToken: string) { return request<{ ok: boolean; orderNumber: number; trackingToken: string }>(`/payments/mock/${paymentId}/complete`, { method: 'POST', body: JSON.stringify({ trackingToken }) }) },
  login(email: string, password: string) {
    return request<{ user: { name: string; email: string; role: string } }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  },
  logout() { return request<{ ok: boolean }>('/auth/logout', { method: 'POST' }) },
  me() { return request<{ sub: string; email: string; role: string }>('/auth/me') },
  adminProducts() { return request<Array<ApiProduct & { category: ApiCategory }>>('/admin/products') },
  adminCategories() { return request<ApiCategory[]>('/admin/categories') },
  adminCreateCategory(input: { name: string; slug: string; sortOrder?: number }) { return request<ApiCategory>('/admin/categories', { method: 'POST', body: JSON.stringify(input) }) },
  adminUpdateCategory(id: string, input: Partial<Pick<ApiCategory, 'name' | 'slug' | 'sortOrder' | 'isActive'>>) { return request<ApiCategory>(`/admin/categories/${id}`, { method: 'PATCH', body: JSON.stringify(input) }) },
  adminOrders() { return request<any[]>('/admin/orders') },
  adminUpdateOrderStatus(id: string, status: string) { return request(`/admin/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }) },
  adminNotifications() { return request<any[]>('/admin/notifications') },
  adminMarkNotificationRead(id: string) { return request(`/admin/notifications/${id}/read`, { method: 'PATCH' }) },
  syncLogs() { return request<any[]>('/admin/integrations/1c/logs') },
  auditLogs() { return request<any[]>('/admin/audit') },
  monitorCandidates(id: string) { return request<MatchCandidate[]>(`/admin/price-monitor/${id}/candidates`) },
  monitorConfirm(id: string, productId: number) { return request<PriceMonitorItem>(`/admin/price-monitor/${id}/confirm`, { method: 'POST', body: JSON.stringify({ productId }) }) },
  monitorUnmatch(id: string) { return request(`/admin/price-monitor/${id}/unmatch`, { method: 'POST' }) },
  monitorHistory(id: string) { return request<Array<{ id: string; price: number; inStock: boolean | null; checkedAt: string }>>(`/admin/price-monitor/${id}/history`) },
  monitorJobs() { return request<MonitorJob[]>('/admin/price-monitor/jobs') },
  monitorScan(url: string, maxPages: number) { return request<MonitorJob>('/admin/price-monitor/scan', { method: 'POST', body: JSON.stringify({ url, maxPages }) }) },
  monitorCheckAll() { return request<MonitorJob>('/admin/price-monitor/check-all', { method: 'POST' }) },
  monitorJobAction(id: string, action: 'retry' | 'cancel') { return request(`/admin/price-monitor/jobs/${id}/${action}`, { method: 'POST' }) },
  monitorQueue() { return request<{ queued: number }>('/admin/price-monitor/queue-1c', { method: 'POST' }) },
  monitorDeliveries() { return request<MonitorDelivery[]>('/admin/price-monitor/deliveries') },
  monitorSettings() { return request<{ catalogUrl: string; intervalMinutes: number }>('/admin/price-monitor/settings') },
  monitorSaveSettings(catalogUrl: string, intervalMinutes: number) { return request('/admin/price-monitor/settings', { method: 'POST', body: JSON.stringify({ catalogUrl, intervalMinutes }) }) },
  monitorExport() { return request<{ schemaVersion: number; items: Array<Record<string, unknown>> }>('/admin/price-monitor/export-1c') },
  monitorReceipts(data: unknown) { return request('/admin/price-monitor/receipts', { method: 'POST', body: JSON.stringify(data) }) },
  adminImportOneC(data: unknown) { return request('/admin/integrations/1c/catalog', { method: 'POST', body: JSON.stringify(data) }) },
  adminPriceMonitor() { return request<PriceMonitorItem[]>('/admin/price-monitor') },
  adminCheckCompetitorPrice(input: { url: string; productId?: number }) { return request<PriceMonitorItem>('/admin/price-monitor/check', { method: 'POST', body: JSON.stringify(input) }) },
  adminImportFiveRuCatalog(input: { url: string; limit?: number }) { return request<FiveRuImportResult>('/admin/price-monitor/import-05ru', { method: 'POST', body: JSON.stringify(input) }) },
  adminApplyRecommendedPrice(id: string) { return request<PriceMonitorItem>(`/admin/price-monitor/${id}/apply-recommended`, { method: 'POST' }) },
  adminClearFiveRuTestImport() { return request<{ ok: boolean; deleted: number; archived: number; categoriesDeleted: number }>('/admin/price-monitor/test-import-05ru', { method: 'DELETE' }) },
  adminPromos() { return request<PromoBanner[]>('/admin/content/promos') },
  adminCreatePromo(input: Record<string, unknown>) { return request('/admin/content/promos', { method: 'POST', body: JSON.stringify(input) }) },
  adminUpdatePromo(id: string, input: Record<string, unknown>) { return request(`/admin/content/promos/${id}`, { method: 'PATCH', body: JSON.stringify(input) }) },
  adminDeletePromo(id: string) { return request(`/admin/content/promos/${id}`, { method: 'DELETE' }) },
  adminCreateProduct(input: Record<string, unknown>) { return request('/admin/products', { method: 'POST', body: JSON.stringify(input) }) },
  adminUploadProductImage(file: File) { const body = new FormData(); body.append('file', file); return request<{ url: string; key: string; storage: 'local' | 'yandex' }>('/admin/uploads/product-image', { method: 'POST', body }) },
  adminUploadPromoImage(file: File) { const body = new FormData(); body.append('file', file); return request<{ url: string; key: string; storage: 'local' | 'yandex' }>('/admin/uploads/promo-image', { method: 'POST', body }) },
  adminUpdateProduct(id: number, input: Record<string, unknown>) { return request(`/admin/products/${id}`, { method: 'PATCH', body: JSON.stringify(input) }) },
  adminArchiveProduct(id: number) { return request(`/admin/products/${id}`, { method: 'DELETE' }) },
  adminRestoreProduct(id: number) { return request(`/admin/products/${id}/restore`, { method: 'PATCH' }) },
  adminDeleteProduct(id: number) { return request(`/admin/products/${id}/permanent`, { method: 'DELETE' }) },
}

export { API_URL }
