import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common'
import { AdminGuard } from '../common/admin.guard'
import { AuthGuard } from '../common/auth.guard'
import { OneCCatalogDto, OneCOrderStatusDto } from './integrations.dto'
import { IntegrationsService } from './integrations.service'
import { OneCGuard } from './onec.guard'
import { OneCPriceSyncService } from './price-sync.service'
import { OneCAgentHeartbeatDto, PriceSyncReceiptsDto, PriceSyncScopeDto } from './price-sync.dto'
import { automaticTestCatalogScope, priceSyncEnabled } from './test-catalog-policy'

@Controller()
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService, private readonly priceSync: OneCPriceSyncService) {}

  private testAutoPriceScopeEnabled() {
    return automaticTestCatalogScope()
  }

  /** Reverse writes require an explicitly enabled TEST or named PRODUCTION profile. */
  private assertTestPriceSyncEnabled() {
    if (!priceSyncEnabled()) {
      throw new ForbiddenException('Обратная передача цен отключена. Настройте и явно включите профиль базы 1С.')
    }
  }

  @Post('integrations/1c/catalog') @UseGuards(OneCGuard)
  catalog(@Body() dto: OneCCatalogDto) {
    return this.integrations.importCatalog(dto)
  }
  @Post('admin/integrations/1c/catalog') @UseGuards(AuthGuard, AdminGuard)
  manualCatalog(@Body() dto: OneCCatalogDto) { return this.integrations.importCatalog(dto) }
  @Post('integrations/1c/price-sync/scope') @UseGuards(OneCGuard) priceScope(@Body() dto: PriceSyncScopeDto) { this.assertTestPriceSyncEnabled(); return this.priceSync.configureScope(dto) }
  @Get('integrations/1c/price-sync/scope') @UseGuards(OneCGuard) getPriceScope() { this.assertTestPriceSyncEnabled(); return this.priceSync.scopeForAgent() }
  @Get('integrations/1c/price-sync/product/:oneCId') @UseGuards(OneCGuard) priceSyncProduct(@Param('oneCId') oneCId: string) { this.assertTestPriceSyncEnabled(); return this.priceSync.productByOneCId(oneCId) }
  @Get('integrations/1c/price-sync/pending') @UseGuards(OneCGuard) pendingPrices() { this.assertTestPriceSyncEnabled(); return this.priceSync.pending() }
  @Post('integrations/1c/price-sync/receipts') @UseGuards(OneCGuard) priceReceipts(@Body() dto: PriceSyncReceiptsDto) { this.assertTestPriceSyncEnabled(); return this.priceSync.receipts(dto) }
  @Post('integrations/1c/agent/heartbeat') @UseGuards(OneCGuard)
  heartbeat(@Body() dto: OneCAgentHeartbeatDto) { this.assertTestPriceSyncEnabled(); return this.priceSync.heartbeat(dto) }
  @Post('admin/integrations/1c/price-sync/scope/add') @UseGuards(AuthGuard, AdminGuard)
  addPriceScope(@Body() dto: PriceSyncScopeDto) { this.assertTestPriceSyncEnabled(); return this.priceSync.addScope(dto) }
  @Get('admin/integrations/1c/price-sync') @UseGuards(AuthGuard, AdminGuard)
  async priceSyncDashboard() {
    return {
      ...await this.priceSync.dashboard(),
      testPriceSyncEnabled: priceSyncEnabled(),
      baseKind: process.env.ONE_C_BASE_KIND || 'DISABLED',
      testAutoScopeOnCatalogImport: this.testAutoPriceScopeEnabled(),
    }
  }

  @Get('integrations/1c/orders/pending') @UseGuards(OneCGuard) pendingOrders() { return this.integrations.pendingOrders() }
  @Post('integrations/1c/orders/:id/ack') @UseGuards(OneCGuard) ack(@Param('id') id: string, @Body('oneCId') oneCId: string) { return this.integrations.ackOrder(id, oneCId) }
  @Post('integrations/1c/orders/status') @UseGuards(OneCGuard) orderStatus(@Body() dto: OneCOrderStatusDto) { return this.integrations.orderStatus(dto) }
  @Get('admin/integrations/1c/logs') @UseGuards(AuthGuard, AdminGuard) logs() { return this.integrations.logs() }
}
