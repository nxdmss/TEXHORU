import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module'
import { AuthModule } from '../auth/auth.module'
import { PrismaModule } from '../prisma/prisma.module'
import { ContentController } from './content.controller'
import { ContentService } from './content.service'

@Module({
  imports: [PrismaModule, AuditModule, AuthModule],
  controllers: [ContentController],
  providers: [ContentService],
})
export class ContentModule {}
