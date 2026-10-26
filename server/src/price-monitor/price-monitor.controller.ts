import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common'
import { AdminGuard } from '../common/admin.guard'
import { AuthGuard } from '../common/auth.guard'
import { ApplyRecommendedPriceDto, CheckCompetitorPriceDto, ImportFiveRuCatalogDto, MatchProductDto, MonitorSettingsDto, MonitorReceiptsDto, ScanFiveRuDto } from './price-monitor.dto'
import { PriceMonitorService } from './price-monitor.service'
import { MonitorExchangeService } from './monitor-exchange.service'

@Controller('admin/price-monitor')
@UseGuards(AuthGuard, AdminGuard)
export class PriceMonitorController {
  constructor(private readonly monitor: PriceMonitorService, private readonly exchange: MonitorExchangeService) {}

  @Get()
  list() { return this.monitor.list() }

  @Get('jobs') jobs() { return this.monitor.jobs() }
  @Post('scan') scan(@Body() dto: ScanFiveRuDto) { return this.monitor.scan(dto) }
  @Post('check-all') checkAll() { return this.monitor.checkAll() }
  @Post('jobs/:id/cancel') cancel(@Param('id') id: string) { return this.monitor.cancelJob(id) }
  @Post('jobs/:id/retry') retry(@Param('id') id: string) { return this.monitor.retryJob(id) }
  @Get('settings') settings() { return this.monitor.settings() }
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
