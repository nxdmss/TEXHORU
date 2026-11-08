import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common'
import { AdminGuard } from '../common/admin.guard'
import { AuthGuard } from '../common/auth.guard'
import { ApplyRecommendedPriceDto, BulkApplyPricesDto, BulkPriceScopeDto, AutoFindOneCSectionDto, CheckCompetitorPriceDto, ImportFiveRuCatalogDto, MatchProductDto, MonitorSettingsDto, MonitorReceiptsDto, ImportManualCompetitorPricesDto, ScanFiveRuDto, CheckAllDto, PriceUpdateDto } from './price-monitor.dto'
import { PriceMonitorService } from './price-monitor.service'
import { MonitorExchangeService } from './monitor-exchange.service'
import type { StoreKey } from './storefront-adapter'

@Controller('admin/price-monitor')
@UseGuards(AuthGuard, AdminGuard)
export class PriceMonitorController {
  constructor(private readonly monitor: PriceMonitorService, private readonly exchange: MonitorExchangeService) {}

  @Get()
  list() { return this.monitor.list() }

  @Get('sources') sources() { return this.monitor.sources() }
  @Get('match-outcomes') matchOutcomes() { return this.monitor.matchOutcomes('05ru') }
  @Post('match/:productId/retry') retryMatch(@Param('productId', ParseIntPipe) productId: number) {
    return this.monitor.retryMatch(productId)
  }

  @Post('import-manual-prices') importManualPrices(@Body() dto: ImportManualCompetitorPricesDto) { return this.monitor.importManualPrices(dto) }

  @Post('bulk-price-preview') previewBulkPrices(@Body() dto: BulkPriceScopeDto) { return this.monitor.previewBulkPrices(dto) }
  @Post('bulk-price-apply') applyBulkPrices(@Body() dto: BulkApplyPricesDto) { return this.monitor.applyBulkPrices(dto) }
  @Post('bulk-price-reject') rejectBulkPrices(@Body() dto: BulkApplyPricesDto) { return this.monitor.rejectBulkPrices(dto) }

  @Post('price-update') startPriceUpdate(@Body() dto: PriceUpdateDto) { return this.monitor.startPriceUpdate(dto) }
  @Get('price-update/current') currentPriceUpdate() { return this.monitor.currentPriceUpdate() }
  @Post('price-update/:id/cancel') cancelPriceUpdate(@Param('id') id: string) { return this.monitor.cancelPriceUpdate(id) }

  @Get('jobs') jobs() { return this.monitor.jobs() }
  @Post('scan') scan(@Body() dto: ScanFiveRuDto) { return this.monitor.scan(dto) }
  @Post('check-all') checkAll(@Body() dto?: CheckAllDto) { return this.monitor.checkAll(dto) }
  @Post('auto-find-1c') autoFindOneC(@Body() dto: AutoFindOneCSectionDto) { return this.monitor.autoFindOneCSection(dto) }
  @Post('jobs/:id/cancel') cancel(@Param('id') id: string) { return this.monitor.cancelJob(id) }
  @Post('jobs/:id/retry') retry(@Param('id') id: string) { return this.monitor.retryJob(id) }
  @Get('settings') settings(@Query('sourceKey') sourceKey?: StoreKey) { return this.monitor.settings(sourceKey) }
  @Post('settings') updateSettings(@Body() dto: MonitorSettingsDto) { return this.monitor.updateSettings(dto) }
  @Get('deliveries') deliveries() { return this.exchange.deliveries() }
  @Post('queue-1c') queue() { return this.exchange.queueConfirmed() }
  @Get('export-1c') export() { return this.exchange.pending() }
  @Post('receipts') async receipts(@Body() dto: MonitorReceiptsDto) {
    const results = []
    for (const item of dto.items) results.push(await this.exchange.ack(item.id, item.error))
    return { ok: true, results }
  }
  @Get(':id/candidates') candidates(@Param('id') id: string) { return this.monitor.candidates(id) }
  @Post(':id/confirm') confirm(@Param('id') id: string, @Body() dto: MatchProductDto) { return this.monitor.confirm(id, dto.productId) }
  @Post(':id/unmatch') unmatch(@Param('id') id: string) { return this.monitor.unmatch(id) }
  @Get(':id/history') history(@Param('id') id: string) { return this.monitor.history(id) }

  @Post('check')
  check(@Body() dto: CheckCompetitorPriceDto) { return this.monitor.check(dto) }

  @Post('import-05ru')
  importFiveRu(@Body() dto: ImportFiveRuCatalogDto) { return this.monitor.importFiveRuCatalog(dto) }

  @Post(':id/apply-recommended')
  applyRecommended(@Param('id') id: string, @Body() dto: ApplyRecommendedPriceDto) { return this.monitor.applyRecommended(id, dto) }

  @Delete('test-import-05ru')
  clearFiveRuTestImport() { return this.monitor.clearFiveRuTestImport() }
}
