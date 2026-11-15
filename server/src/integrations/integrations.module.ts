import { RemoteCatalogController } from './remote-catalog.controller'
import { RemoteCatalogService } from './remote-catalog.service'
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
import { IntegrationFoundationController } from './integration-foundation.controller'
import { IntegrationFoundationService } from './integration-foundation.service'
import { AuditModule } from '../audit/audit.module'

@Module({ imports: [AuthModule, AuditModule, OrdersModule, NotificationsModule], controllers: [RemoteCatalogController, IntegrationsController, CatalogSyncController, IntegrationFoundationController], providers: [RemoteCatalogService, CatalogSyncService, IntegrationsService, IntegrationFoundationService, OneCGuard, OneCPriceSyncService] })
export class IntegrationsModule {}
