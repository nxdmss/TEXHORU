/** Imported TEST catalog is eligible by default; price writes still require the TEST switch. */
export function automaticTestCatalogScope() {
  return process.env.ONE_C_BASE_KIND === 'TEST' && process.env.ONE_C_TEST_PRICE_SYNC_ENABLED === 'true'
}
