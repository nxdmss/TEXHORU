import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common'
import { AdminGuard } from '../common/admin.guard'
import { AuthGuard } from '../common/auth.guard'
import { CheckCompetitorPriceDto, ImportFiveRuCatalogDto } from './price-monitor.dto'
import { PriceMonitorService } from './price-monitor.service'

@Controller('admin/price-monitor')
@UseGuards(AuthGuard, AdminGuard)
export class PriceMonitorController {
  constructor(private readonly monitor: PriceMonitorService) {}

  @Get()
  list() { return this.monitor.list() }

  @Post('check')
  check(@Body() dto: CheckCompetitorPriceDto) { return this.monitor.check(dto) }

  @Post('import-05ru')
  importFiveRu(@Body() dto: ImportFiveRuCatalogDto) { return this.monitor.importFiveRuCatalog(dto) }

  @Post(':id/apply-recommended')
  applyRecommended(@Param('id') id: string) { return this.monitor.applyRecommended(id) }

  @Delete('test-import-05ru')
  clearFiveRuTestImport() { return this.monitor.clearFiveRuTestImport() }
}
