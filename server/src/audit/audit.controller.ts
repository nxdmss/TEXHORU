import { Controller, Get, UseGuards } from '@nestjs/common'
import { AdminGuard } from '../common/admin.guard'
import { AuthGuard } from '../common/auth.guard'
import { AuditService } from './audit.service'

@Controller('admin/audit')
@UseGuards(AuthGuard, AdminGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}
  @Get() list() { return this.audit.list() }
}
