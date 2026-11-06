import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common'
import { AdminGuard } from '../common/admin.guard'
import { AuthGuard } from '../common/auth.guard'
import { OneCCatalogDto, OneCOrderStatusDto } from './integrations.dto'
import { IntegrationsService } from './integrations.service'
import { OneCGuard } from './onec.guard'
import { OneCPriceSyncService } from './price-sync.service'
import { PriceSyncReceiptsDto, PriceSyncScopeDto } from './price-sync.dto'

@Controller()
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService, private readonly priceSync: OneCPriceSyncService) {}

  // Both flags must be set explicitly by the operator of a TEST-only 1C site.
  // An admin-side JSON import never grants price-write eligibility.
  private testAutoPriceScopeEnabled() {
    return process.env.ONE_C_BASE_KIND === 'TEST' && process.env.ONE_C_TEST_AUTO_PRICE_SCOPE === 'true'
  }

  /** Reverse retail-price writes are deliberately disabled unless the server is explicitly marked TEST. */
  private assertTestPriceSyncEnabled() {
    if (process.env.ONE_C_BASE_KIND !== 'TEST' || process.env.ONE_C_TEST_PRICE_SYNC_ENABLED !== 'true') {
      throw new ForbiddenException('Обратная передача цен отключена. Она разрешена только после явного включения для тестовой базы 1С.')
    }
  }

  @Post('integrations/1c/catalog') @UseGuards(OneCGuard)
  catalog(@Body() dto: OneCCatalogDto) {
    return this.integrations.importCatalog(dto, { autoApproveTestPriceScope: this.testAutoPriceScopeEnabled() })
  }
  @Post('admin/integrations/1c/catalog') @UseGuards(AuthGuard, AdminGuard)
  manualCatalog(@Body() dto: OneCCatalogDto) { return this.integrations.importCatalog(dto) }
  @Post('integrations/1c/price-sync/scope') @UseGuards(OneCGuard) priceScope(@Body() dto: PriceSyncScopeDto) { this.assertTestPriceSyncEnabled(); return this.priceSync.configureScope(dto) }
  @Get('integrations/1c/price-sync/scope') @UseGuards(OneCGuard) getPriceScope() { this.assertTestPriceSyncEnabled(); return this.priceSync.scope() }
  @Get('integrations/1c/price-sync/product/:oneCId') @UseGuards(OneCGuard) priceSyncProduct(@Param('oneCId') oneCId: string) { this.assertTestPriceSyncEnabled(); return this.priceSync.productByOneCId(oneCId) }
  @Get('integrations/1c/price-sync/pending') @UseGuards(OneCGuard) pendingPrices() { this.assertTestPriceSyncEnabled(); return this.priceSync.pending() }
  @Post('integrations/1c/price-sync/receipts') @UseGuards(OneCGuard) priceReceipts(@Body() dto: PriceSyncReceiptsDto) { this.assertTestPriceSyncEnabled(); return this.priceSync.receipts(dto) }
  @Get('admin/integrations/1c/price-sync') @UseGuards(AuthGuard, AdminGuard)
  async priceSyncDashboard() {
    return {
      ...await this.priceSync.dashboard(),
      testPriceSyncEnabled: process.env.ONE_C_BASE_KIND === 'TEST' && process.env.ONE_C_TEST_PRICE_SYNC_ENABLED === 'true',
      testAutoScopeOnCatalogImport: this.testAutoPriceScopeEnabled(),
    }
  }

  @Get('integrations/1c/orders/pending') @UseGuards(OneCGuard) pendingOrders() { return this.integrations.pendingOrders() }
  @Post('integrations/1c/orders/:id/ack') @UseGuards(OneCGuard) ack(@Param('id') id: string, @Body('oneCId') oneCId: string) { return this.integrations.ackOrder(id, oneCId) }
  @Post('integrations/1c/orders/status') @UseGuards(OneCGuard) orderStatus(@Body() dto: OneCOrderStatusDto) { return this.integrations.orderStatus(dto) }
  @Get('admin/integrations/1c/logs') @UseGuards(AuthGuard, AdminGuard) logs() { return this.integrations.logs() }
}
