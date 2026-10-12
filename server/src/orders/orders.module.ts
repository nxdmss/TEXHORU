import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module'
import { AuthModule } from '../auth/auth.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { OrdersController } from './orders.controller'
import { OrdersService } from './orders.service'

@Module({ imports: [AuthModule, NotificationsModule, AuditModule], controllers: [OrdersController], providers: [OrdersService], exports: [OrdersService] })
export class OrdersModule {}
