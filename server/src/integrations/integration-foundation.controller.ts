import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'
import { AdminGuard, DirectorGuard } from '../common/admin.guard'
import { AuthGuard, type AuthPayload } from '../common/auth.guard'
import { IntegrationCommandActionDto, UpdateIntegrationPolicyDto } from './integration-foundation.dto'
import { IntegrationFoundationService } from './integration-foundation.service'

@Controller('admin/integrations/1c/foundation')
@UseGuards(AuthGuard, AdminGuard)
export class IntegrationFoundationController {
  constructor(private readonly foundation: IntegrationFoundationService) {}

  @Get() dashboard() { return this.foundation.dashboard() }

  @Patch('policy') @UseGuards(DirectorGuard)
  updatePolicy(@Body() dto: UpdateIntegrationPolicyDto, @Req() req: { user: AuthPayload }) {
    return this.foundation.updatePolicy(dto, req.user.sub)
  }

  @Post('commands/:id/action') @UseGuards(DirectorGuard)
  commandAction(@Param('id') id: string, @Body() dto: IntegrationCommandActionDto, @Req() req: { user: AuthPayload }) {
    return this.foundation.commandAction(id, dto, req.user.sub)
  }
}
