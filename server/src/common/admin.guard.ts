import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import type { AuthPayload } from './auth.guard'

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ user?: AuthPayload }>()
    if (!request.user || !['MANAGER', 'DIRECTOR', 'ADMIN'].includes(request.user.role)) {
      throw new ForbiddenException('Недостаточно прав')
    }
    return true
  }
}
