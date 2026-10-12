import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module'
import { AuthModule } from '../auth/auth.module'
import { ProductsController } from './products.controller'
import { ProductsService } from './products.service'

@Module({ imports: [AuthModule, AuditModule], controllers: [ProductsController], providers: [ProductsService], exports: [ProductsService] })
export class ProductsModule {}
