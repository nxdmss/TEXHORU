import { Module } from '@nestjs/common'
import { NotificationsModule } from '../notifications/notifications.module'
import { PrismaModule } from '../prisma/prisma.module'
import { PaymentsController } from './payments.controller'
import { PaymentsService } from './payments.service'

@Module({ imports: [PrismaModule, NotificationsModule], controllers: [PaymentsController], providers: [PaymentsService] })
export class PaymentsModule {}
