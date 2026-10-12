import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ConfigModule } from '@nestjs/config'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { AuditModule } from './audit/audit.module'
import { AuthModule } from './auth/auth.module'
import { ContentModule } from './content/content.module'
import { HealthModule } from './health/health.module'
import { IntegrationsModule } from './integrations/integrations.module'
import { MediaModule } from './media/media.module'
import { NotificationsModule } from './notifications/notifications.module'
import { OrdersModule } from './orders/orders.module'
import { PaymentsModule } from './payments/payments.module'
import { PrismaModule } from './prisma/prisma.module'
import { ProductsModule } from './products/products.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: process.env.TEXHORU_ENV_FILE ?? ['.env.local', '.env'] }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    ProductsModule,
    OrdersModule,
    PaymentsModule,
    NotificationsModule,
    ContentModule,
    IntegrationsModule,
    MediaModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
