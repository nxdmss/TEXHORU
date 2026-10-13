import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common'
import { AdminGuard } from '../common/admin.guard'
import { AuthGuard } from '../common/auth.guard'
import { OneCCatalogDto, OneCOrderStatusDto } from './integrations.dto'
import { IntegrationsService } from './integrations.service'
import { OneCGuard } from './onec.guard'

@Controller()
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Post('integrations/1c/catalog') @UseGuards(OneCGuard) catalog(@Body() dto: OneCCatalogDto) { return this.integrations.importCatalog(dto) }
  @Post('admin/integrations/1c/catalog') @UseGuards(AuthGuard, AdminGuard) manualCatalog(@Body() dto: OneCCatalogDto) { return this.integrations.importCatalog(dto) }
  @Get('integrations/1c/orders/pending') @UseGuards(OneCGuard) pendingOrders() { return this.integrations.pendingOrders() }
  @Post('integrations/1c/orders/:id/ack') @UseGuards(OneCGuard) ack(@Param('id') id: string, @Body('oneCId') oneCId: string) { return this.integrations.ackOrder(id, oneCId) }
  @Post('integrations/1c/orders/status') @UseGuards(OneCGuard) orderStatus(@Body() dto: OneCOrderStatusDto) { return this.integrations.orderStatus(dto) }
  @Get('admin/integrations/1c/logs') @UseGuards(AuthGuard, AdminGuard) logs() { return this.integrations.logs() }
}
