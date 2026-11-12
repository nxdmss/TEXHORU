import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../common/auth.guard'
import { AdminGuard } from '../common/admin.guard'
import { OneCGuard } from './onec.guard'
import { RemoteCatalogService } from './remote-catalog.service'
import { RemoteActionDto, RemoteBatchDto, RemoteJobDto, RemoteKnownDto, RemoteLeaseDto, RemotePollDto } from './remote-catalog.dto'
@Controller()
export class RemoteCatalogController {
  constructor(private readonly remote: RemoteCatalogService) {}
  @Get('admin/integrations/1c/remote') @UseGuards(AuthGuard, AdminGuard)
  dashboard(@Query('parent') parent = '', @Query('search') search = '', @Query('page') page = '0') { return this.remote.dashboard(parent, search, Number(page)) }
  @Post('admin/integrations/1c/remote/jobs') @UseGuards(AuthGuard, AdminGuard)
  create(@Body() dto: RemoteJobDto) { return this.remote.create(dto) }
  @Post('admin/integrations/1c/remote/jobs/:id/action') @UseGuards(AuthGuard, AdminGuard)
  action(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RemoteActionDto) { return this.remote.action(id, dto.action) }
  @Post('integrations/1c/remote/poll') @UseGuards(OneCGuard)
  poll(@Body() dto: RemotePollDto) { return this.remote.poll(dto) }
  @Post('integrations/1c/remote/known') @UseGuards(OneCGuard)
  known(@Body() dto: RemoteKnownDto) { return this.remote.known(dto) }
  @Post('integrations/1c/remote/jobs/:id/batch') @UseGuards(OneCGuard)
  batch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RemoteBatchDto) { return this.remote.batch(id, dto) }
  @Post('integrations/1c/remote/jobs/:id/finish') @UseGuards(OneCGuard)
  finish(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RemoteLeaseDto) { return this.remote.finish(id, dto.leaseToken) }
}
