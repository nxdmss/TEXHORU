import type { Product } from './types'
import type { StorefrontLayout } from './page-layout'

const API_URL = import.meta.env.VITE_API_URL || '/api'

export type ApiCategory = { id: string; name: string; slug: string; sortOrder?: number; isActive?: boolean }
export type ApiProduct = {
  id: number
  oneCId?: string | null
  duplicateOf?: number | null
  priceSyncEnabled?: boolean
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
  reservedQty?: number
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
  blockId: string
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

export type StorefrontLayoutState = {
  draft: StorefrontLayout
  published?: StorefrontLayout
  draftUpdatedAt: string | null
  publishedAt: string | null
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
  source: { id: string; key: string; name: string; baseUrl: string; isActive?: boolean }
  product?: { id: number; oneCId?: string | null; sku: string; name: string; price: number; priceSyncEnabled?: boolean; category?: ApiCategory } | null
}

export type MatchOutcome = {
  productId: number
  sourceKey: string
  status: 'PENDING' | 'CONFIRMED' | 'REVIEW' | 'NO_MATCH' | 'RETRYABLE'
  reason?: string | null
  checkedAt: string
}

export type MonitorJob = {
  id: string; kind: string; sourceKey?: string | null; status: string; page: number; maxPages: number; perPage?: number; processed: number; errors: number
  lastError?: string | null; url?: string | null; createdAt: string; pendingUrls: string[]
}
export type MatchCandidate = {
  product: { id: number; oneCId?: string | null; name: string; sku: string }
  score: number; reviewScore?: number; reasons: string[]; conflicts: string[]; missing: string[]
  manualBlockers: string[]
  ours: Record<string, string>; theirs: Record<string, string>
}
export type MonitorSource = {
  id: string; key: '05ru' | 'mvideo' | 'dns'; name: string; baseUrl: string; isActive: boolean
  settings: { id: string; catalogUrl: string; region?: string | null; intervalMinutes: number; nextRunAt: string | null }
  counts: { confirmed: number; review: number; total: number }
}
export type AutoFindResult =
  | (MonitorJob & { sourceKey: string; eligible: number; queued: number })
  | { sourceKey: 'all'; eligible: number; queued: number; jobs: MonitorJob[]; sources: Array<{ sourceKey: string; eligible: number; queued: number; job: MonitorJob | null }> }
export type CheckAllResult =
  | (MonitorJob & { sourceKey: string; queued: number })
  | { queued: number; jobs: MonitorJob[]; sources: Array<{ sourceKey: string; queued: number }> }

export type MonitorDelivery = { id: string; status: string; attempts: number; lastError?: string | null; createdAt: string; payload: Record<string, unknown> }

export type PriceApprovalPreview = {
  token: string; count: number; totalScope: number; skipped: number; unknownCost: number; largeChanges: number; oneCQueued: number;
  items: Array<{ id: string; productId: number | null; productName: string; categoryPath: string; costPrice: number | null;
    oldPrice: number | null; previousCompetitorPrice: number | null; competitorPrice: number; newPrice: number;
    lastSuccessAt: string | null; externalUrl: string; externalName: string; matchVerified: boolean; awaitingOneC: boolean; canSend: boolean; blockedReasons: string[] }>;
  diagnostics: {
    unlinkedCount: number;
    unlinked: Array<{ productId: number; productName: string; categoryPath: string }>;
    uncheckedCount: number;
    unchecked: Array<{ productId: number | null; productName: string; reason: string }>;
  };
}
export type PriceReadiness = {
  authorized: number; checking: boolean;
  priceCheck?: { id: string; status: string; perPage: number; processed: number; errors: number;
    lastError: string | null; createdAt: string; finishedAt: string | null } | null;
  items: Array<{ productId: number; name: string; categoryPath: string; authorized: boolean;
    oldPrice: number; newPrice: number | null; status: 'READY' | 'PENDING' | 'BLOCKED'; reason: string | null }>;
}
export type RemoteCatalogStatus = {
  configured: boolean; baseId?: string; total: number; page: number
  agent: { online: boolean; state: string; lastSeenAt: string; groupsUpdatedAt: string | null; nomenclatureUpdatedAt: string | null; error: string | null } | null
  groups: { oneCId: string; parentId: string; name: string; itemCount: number; lastReceivedAt: string | null }[]
  jobs: { id: string; kind: string; groupId: string; groupName: string; mode: string; status: string; scanned: number; processed: number; skipped: number; error: string | null; updatedAt: string }[]
}
export type OneCRemoteGroup = { oneCId: string; parentId: string; name: string; itemCount: number; lastReceivedAt: string | null; fullyImportedAt: string | null }
export type OneCExcludedGroup = OneCRemoteGroup
export type OneCNomenclatureItem = {
  oneCId: string; parentId: string; code: string; article: string; name: string; fullName: string; itemKind: string; unitName: string
  retailPrice: number | null; purchasePrice: number | null; stockQty: number; deletionMark: boolean; imported: boolean; receivedAt: string; updatedAt: string
}
export type OneCNomenclaturePage = {
  items: OneCNomenclatureItem[]; total: number; children: OneCRemoteGroup[]; group: Pick<OneCRemoteGroup, 'oneCId' | 'parentId' | 'name'> | null
  page: number; pageSize: number; search: string
}
export type OneCPriceSyncStatus = {
  agent?: { lastSeenAt: string; online: boolean; state?: string; applied: number; failed: number } | null;
  summary?: { pending: number; delivered: number; needsAttention: number };
  testPriceSyncEnabled?: boolean;
  testAutoScopeOnCatalogImport?: boolean;
  scope: Array<{ id: number; oneCId: string | null; name: string; price: number; stockQty: number }>
  changes: Array<{ id: string; name: string; oneCId: string; oldPrice: number; newPrice: number;
    status: string; error: string | null; createdAt: string; deliveredAt: string | null }>
}

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
  if (value === 'PREORDER') return 'Под заказ'
  if (value === 'OUT_OF_STOCK') return 'Нет в наличии'
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

export type CustomerProfile = { id: string; name: string; email: string; phone: string | null; deliveryAddress: string; emailVerifiedAt: string | null; role: string }
export type CustomerOrder = { number: number; trackingToken: string; status: string; paymentStatus: string; total: number; deliveryMethod: string; deliveryAddress: string; createdAt: string; items: Array<{ name: string; quantity: number; price: number }> }
export type CatalogSyncStatus = { session: null | { id: string; clientId: string; mode: string; status: string; processed: number; skipped: number; nextBatch: number; updatedAt: string; finishedAt: string | null }; batchSize: number; maxBatchSize: number; maxPayloadBytes: number; parallelism: number }

export const api = {
  accountCapabilities() { return request<{ emailConfigured: boolean }>('/auth/capabilities') },
  customerLogin(email: string, password: string) { return request<{ user: CustomerProfile }>('/auth/customer-login', { method: 'POST', body: JSON.stringify({ email, password }) }) },
  customerLogout() { return request('/auth/customer-logout', { method: 'POST' }) },
  customerProfile() { return request<CustomerProfile>('/account/profile') },
  customerOrders() { return request<CustomerOrder[]>('/account/orders') },
  updateCustomerProfile(input: { name: string; phone: string; deliveryAddress: string }) { return request<CustomerProfile>('/account/profile', { method: 'PATCH', body: JSON.stringify(input) }) },
  register(input: { name: string; email: string; password: string }) { return request<{ message: string }>('/auth/register', { method: 'POST', body: JSON.stringify(input) }) },
  verifyEmail(token: string) { return request<{ message: string }>('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }) },
  resendVerification(email: string) { return request<{ message: string }>('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) }) },
  forgotPassword(email: string) { return request<{ message: string }>('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }) },
  resetPassword(token: string, password: string) { return request<{ message: string }>('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) }) },
  remoteCatalog(parent = '', search = '', page = 0) { return request<RemoteCatalogStatus>('/admin/integrations/1c/remote?' + new URLSearchParams({ parent, search, page: String(page) })) },
  remoteCatalogTree() { return request<{ groups: OneCRemoteGroup[]; itemCount: number }>('/admin/integrations/1c/remote/tree') },
  remoteNomenclature(group = '', search = '', page = 0) { return request<OneCNomenclaturePage>('/admin/integrations/1c/remote/nomenclature?' + new URLSearchParams({ group, search, page: String(page) })) },
  remoteExcludedGroups() { return request<OneCExcludedGroup[]>('/admin/integrations/1c/remote/excluded-groups') },
  remoteExcludeGroup(id: string) { return request<{ ok: boolean; name: string; groups: number; removed: number; productsDeleted: number; productsArchived: number; categoriesDeleted: number }>('/admin/integrations/1c/remote/groups/' + encodeURIComponent(id) + '/exclude', { method: 'POST' }) },
  remoteRestoreGroup(id: string) { return request<{ ok: boolean; name: string; groups: number; jobId: string | null }>('/admin/integrations/1c/remote/groups/' + encodeURIComponent(id) + '/restore', { method: 'POST' }) },
  remoteCatalogCreate(dto: { kind: 'GROUPS' | 'INDEX' | 'IMPORT'; mode: 'FULL' | 'DELTA'; groupId?: string; itemIds?: string[]; stockOnly?: boolean }) { return request('/admin/integrations/1c/remote/jobs', { method: 'POST', body: JSON.stringify(dto) }) },
  remoteCatalogAction(id: string, action: string) { return request('/admin/integrations/1c/remote/jobs/' + encodeURIComponent(id) + '/action', { method: 'POST', body: JSON.stringify({ action }) }) },
  catalogSyncStatus() { return request<CatalogSyncStatus>('/admin/integrations/1c/catalog-sync') },
  cancelCatalogSync(id: string) { return request('/admin/integrations/1c/catalog-sync/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }) },
  async products() { return (await request<ApiProduct[]>('/catalog/home')).map(mapProduct) },
  async product(id: number) { return mapProduct(await request<ApiProduct>('/products/' + id)) },
  async cartProducts(ids: number[]) { return (await request<ApiProduct[]>('/catalog/cart', { method: 'POST', body: JSON.stringify({ ids }) })).map(mapProduct) },
  catalogSummary() { return request<{ groups: Array<{ path: string; brand: string; count: number }> }>('/catalog/summary') },
  async catalogPage(input: Record<string, string | number | undefined>) { const params = new URLSearchParams(); for (const [key,value] of Object.entries(input)) if (value !== undefined && value !== '') params.set(key, String(value)); const result = await request<{ items: ApiProduct[]; total: number; hasMore: boolean }>('/catalog/products?' + params); return { ...result, items: result.items.map(mapProduct) } },
  categories() { return request<ApiCategory[]>('/categories') },
  promos() { return request<PromoBanner[]>('/content/promos') },
  storefrontLayout() { return request<{ layout: StorefrontLayout; publishedAt: string | null }>('/content/layout') },
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
  addTestPriceScope(oneCIds: string[]) {
    return request<{ ok: boolean; added: number; count: number }>('/admin/integrations/1c/price-sync/scope/add', {
      method: 'POST', body: JSON.stringify({ oneCIds }),
    })
  },
  priceSyncStatus() { return request<OneCPriceSyncStatus>('/admin/integrations/1c/price-sync') },
  auditLogs() { return request<any[]>('/admin/audit') },
  importManualCompetitorPrices(rows: Array<{ oneCId?: string; url: string; name: string; price: number; observedAt: string; inStock?: boolean }>) {
    return request<{ ok: boolean; imported: number; created: number; updated: number; associated: number; verifiedOn05Ru: false }>(
      '/admin/price-monitor/import-manual-prices', { method: 'POST', body: JSON.stringify({ rows }) })
  },
  monitorCandidates(id: string) { return request<MatchCandidate[]>(`/admin/price-monitor/${id}/candidates`) },
  monitorConfirm(id: string, productId: number) { return request<PriceMonitorItem>(`/admin/price-monitor/${id}/confirm`, { method: 'POST', body: JSON.stringify({ productId }) }) },
  monitorUnmatch(id: string) { return request(`/admin/price-monitor/${id}/unmatch`, { method: 'POST' }) },
  monitorHistory(id: string) { return request<Array<{ id: string; price: number; inStock: boolean | null; checkedAt: string }>>(`/admin/price-monitor/${id}/history`) },
  monitorJobs() { return request<MonitorJob[]>('/admin/price-monitor/jobs') },
  monitorMatchOutcomes() { return request<MatchOutcome[]>('/admin/price-monitor/match-outcomes') },
  monitorRetryMatch(productId: number) {
    return request<MonitorJob>('/admin/price-monitor/match/' + productId + '/retry', { method: 'POST' })
  },
  monitorSources() { return request<MonitorSource[]>('/admin/price-monitor/sources') },
  monitorAutoFindOneC(categoryPath: string, maxItems: number, indexCatalog = false, onlyInStockSmartphones = false, onlyUnlinked = false, sourceKey: string = '05ru', onlyAllowed = false, productIds?: number[]) {
    return request<AutoFindResult>('/admin/price-monitor/auto-find-1c',
      { method: 'POST', body: JSON.stringify({ categoryPath, maxItems, indexCatalog, onlyInStockSmartphones, onlyUnlinked, sourceKey, onlyAllowed, productIds }) })
  },
  monitorScan(url: string, maxPages: number) { return request<MonitorJob>('/admin/price-monitor/scan', { method: 'POST', body: JSON.stringify({ url, maxPages }) }) },
  monitorCheckAll(sourceKey: string = '05ru') { return request<CheckAllResult>('/admin/price-monitor/check-all', { method: 'POST', body: JSON.stringify({ sourceKey }) }) },
  monitorJobAction(id: string, action: 'retry' | 'cancel') { return request(`/admin/price-monitor/jobs/${id}/${action}`, { method: 'POST' }) },
  monitorQueue() { return request<{ queued: number }>('/admin/price-monitor/queue-1c', { method: 'POST' }) },
  monitorDeliveries() { return request<MonitorDelivery[]>('/admin/price-monitor/deliveries') },
  monitorSettings(sourceKey: string = '05ru') { return request<{ id: string; catalogUrl: string; region?: string | null; intervalMinutes: number; nextRunAt: string | null }>('/admin/price-monitor/settings?sourceKey=' + encodeURIComponent(sourceKey)) },
  monitorSaveSettings(sourceKey: string, catalogUrl: string, intervalMinutes: number, region?: string) {
    return request<{ id: string; catalogUrl: string; region?: string | null; intervalMinutes: number; nextRunAt: string | null }>('/admin/price-monitor/settings',
      { method: 'POST', body: JSON.stringify({ sourceKey, catalogUrl, intervalMinutes, region }) })
  },
  monitorExport() { return request<{ schemaVersion: number; items: Array<Record<string, unknown>> }>('/admin/price-monitor/export-1c') },
  monitorReceipts(data: unknown) { return request('/admin/price-monitor/receipts', { method: 'POST', body: JSON.stringify(data) }) },
  adminImportOneC(data: unknown) { return request('/admin/integrations/1c/catalog', { method: 'POST', body: JSON.stringify(data) }) },
  priceReadiness() { return request<PriceReadiness>('/admin/price-monitor/price-readiness') },
  checkAllowedPrices() { return request<{ queued: number }>('/admin/price-monitor/check-allowed-prices', { method: 'POST' }) },
  priceUpdateCurrent() { return request<PriceUpdateOperation | null>('/admin/price-monitor/price-update/current') },
  startPriceUpdate(productIds?: number[]) {
    return request<PriceUpdateOperation>('/admin/price-monitor/price-update', {
      method: 'POST', body: JSON.stringify(productIds ? { productIds } : {}),
    })
  },
  cancelPriceUpdate(id: string) {
    return request<PriceUpdateOperation>('/admin/price-monitor/price-update/' + encodeURIComponent(id) + '/cancel', { method: 'POST' })
  },
  monitorBulkPreview(categoryPath: string) {
    return request<PriceApprovalPreview>(
      '/admin/price-monitor/bulk-price-preview', { method: 'POST', body: JSON.stringify({ categoryPath }) })
  },
  monitorBulkApply(input: { categoryPath: string; token: string; ids: string[]; acceptUnknownCost: boolean; acceptLargeChange: boolean }) {
    return request<{ ok: boolean; applied: number; skipped: number; oneCQueued: number; siteOnly: number }>(
      '/admin/price-monitor/bulk-price-apply', { method: 'POST', body: JSON.stringify(input) })
  },
  monitorBulkReject(input: { categoryPath: string; token: string; ids: string[] }) {
    return request<{ ok: boolean; rejected: number }>(
      '/admin/price-monitor/bulk-price-reject',
      { method: 'POST', body: JSON.stringify({ ...input, acceptUnknownCost: false, acceptLargeChange: false }) })
  },
  adminPriceMonitor() { return request<PriceMonitorItem[]>('/admin/price-monitor') },
  adminCheckCompetitorPrice(input: { url: string; productId?: number }) { return request<PriceMonitorItem>('/admin/price-monitor/check', { method: 'POST', body: JSON.stringify(input) }) },
  adminImportFiveRuCatalog(input: { url: string; limit?: number }) { return request<FiveRuImportResult>('/admin/price-monitor/import-05ru', { method: 'POST', body: JSON.stringify(input) }) },
  adminApplyRecommendedPrice(id: string, input: { expectedCurrentPrice: number; expectedCompetitorPrice: number; targetPrice: number; acceptUnknownCost: boolean; acceptLargeChange: boolean }) {
    return request<{ ok: boolean; productId: number; previousPrice: number; newPrice: number; siteOnly: boolean; oneCQueued: boolean }>(`/admin/price-monitor/${id}/apply-recommended`, { method: 'POST', body: JSON.stringify(input) })
  },
  adminClearFiveRuTestImport() { return request<{ ok: boolean; deleted: number; archived: number; categoriesDeleted: number }>('/admin/price-monitor/test-import-05ru', { method: 'DELETE' }) },
  adminPromos() { return request<PromoBanner[]>('/admin/content/promos') },
  adminStorefrontLayout() { return request<StorefrontLayoutState>('/admin/content/layout') },
  saveStorefrontDraft(layout: StorefrontLayout) { return request<StorefrontLayoutState>('/admin/content/layout/draft', { method: 'PUT', body: JSON.stringify({ layout }) }) },
  publishStorefrontLayout(layout: StorefrontLayout) { return request<StorefrontLayoutState>('/admin/content/layout/publish', { method: 'POST', body: JSON.stringify({ layout }) }) },
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

export type PriceUpdateOperation = {
  id: string;
  state: 'CHECKING' | 'QUEUING' | 'WAITING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
  total: number; checked: number; ready: number; queued: number; pending: number;
  applied: number; failed: number; skipped: number; createdAt: string; finishedAt: string | null;
  waitingExternal?: number; error?: string | null;
  items: Array<{ productId: number; name: string; categoryPath: string;
    status: 'CHECKING' | 'READY' | 'PENDING' | 'APPLIED' | 'SKIPPED' | 'FAILED';
    reason: string | null; oldPrice: number | null; newPrice: number | null; messageId: string | null }>;
}
