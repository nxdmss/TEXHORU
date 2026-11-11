import { CatalogSyncController } from './catalog-sync.controller'
import { CatalogSyncService } from './catalog-sync.service'
import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { OrdersModule } from '../orders/orders.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { IntegrationsController } from './integrations.controller'
import { IntegrationsService } from './integrations.service'
import { OneCGuard } from './onec.guard'
import { OneCPriceSyncService } from './price-sync.service'

@Module({ imports: [AuthModule, OrdersModule, NotificationsModule], controllers: [IntegrationsController, CatalogSyncController], providers: [CatalogSyncService, IntegrationsService, OneCGuard, OneCPriceSyncService] })
export class IntegrationsModule {}
