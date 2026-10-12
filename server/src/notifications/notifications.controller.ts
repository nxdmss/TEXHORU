import { Controller, Get, Param, Patch, UseGuards } from '@nestjs/common'
import { AdminGuard } from '../common/admin.guard'
import { AuthGuard } from '../common/auth.guard'
import { NotificationsService } from './notifications.service'

@Controller('admin/notifications')
@UseGuards(AuthGuard, AdminGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}
  @Get() list() { return this.notifications.list() }
  @Patch(':id/read') markRead(@Param('id') id: string) { return this.notifications.markRead(id) }
}
