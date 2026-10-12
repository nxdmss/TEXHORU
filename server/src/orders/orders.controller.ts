import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'
import { AdminGuard } from '../common/admin.guard'
import { AuthGuard, type AuthPayload } from '../common/auth.guard'
import { CreateOrderDto, UpdateOrderStatusDto } from './orders.dto'
import { OrdersService } from './orders.service'

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}
  @Post('orders') create(@Body() dto: CreateOrderDto) { return this.orders.create(dto) }
  @Get('orders/track/:token') track(@Param('token') token: string) { return this.orders.track(token) }
  @Get('admin/orders') @UseGuards(AuthGuard, AdminGuard) list() { return this.orders.adminList() }
  @Patch('admin/orders/:id/status') @UseGuards(AuthGuard, AdminGuard) status(@Param('id') id: string, @Body() dto: UpdateOrderStatusDto, @Req() req: { user?: AuthPayload }) { return this.orders.updateStatus(id, dto.status, req.user?.sub) }
}
