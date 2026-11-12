/** Explicit server profiles. TEST agents must never authorize a production base. */
export function priceSyncEnabled() {
  return process.env.ONE_C_BASE_KIND === 'TEST' && process.env.ONE_C_TEST_PRICE_SYNC_ENABLED === 'true'
    || process.env.ONE_C_BASE_KIND === 'PRODUCTION' && process.env.ONE_C_PRODUCTION_PRICE_SYNC_ENABLED === 'true'
      && Boolean(process.env.ONE_C_PRODUCTION_BASE_ID?.trim())
}
export function automaticTestCatalogScope() { return priceSyncEnabled() }
