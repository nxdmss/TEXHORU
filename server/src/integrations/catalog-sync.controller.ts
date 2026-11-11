import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import { OneCGuard } from './onec.guard'
import { AuthGuard } from '../common/auth.guard'
import { AdminGuard } from '../common/admin.guard'
import { CatalogSyncService } from './catalog-sync.service'
import { CatalogSyncBatchDto, StartCatalogSyncDto } from './catalog-sync.dto'
@Controller()
export class CatalogSyncController {
  constructor(private readonly sync: CatalogSyncService) {}
  @Post('integrations/1c/catalog-sync/start') @UseGuards(OneCGuard)
  start(@Body() dto: StartCatalogSyncDto) { return this.sync.start(dto) }
  @Post('integrations/1c/catalog-sync/:id/batch') @UseGuards(OneCGuard)
  batch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CatalogSyncBatchDto) { return this.sync.batch(id, dto) }
  @Post('integrations/1c/catalog-sync/:id/finish') @UseGuards(OneCGuard)
  finish(@Param('id', ParseUUIDPipe) id: string) { return this.sync.finish(id) }
  @Get('admin/integrations/1c/catalog-sync') @UseGuards(AuthGuard, AdminGuard)
  status() { return this.sync.status() }
  @Post('admin/integrations/1c/catalog-sync/:id/cancel') @UseGuards(AuthGuard, AdminGuard)
  cancel(@Param('id', ParseUUIDPipe) id: string) { return this.sync.cancel(id) }
}
