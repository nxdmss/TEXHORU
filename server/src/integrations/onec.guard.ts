import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { timingSafeEqual } from 'node:crypto'

@Injectable()
export class OneCGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>()
    const actual = Buffer.from(req.headers['x-1c-key'] ?? '')
    const expected = Buffer.from(this.config.get<string>('ONE_C_API_KEY') ?? '')
    if (!expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new UnauthorizedException('Неверный ключ 1С')
    const announcedKind = req.headers['x-1c-base-kind']
    if (announcedKind && announcedKind !== this.config.get('ONE_C_BASE_KIND')) throw new ForbiddenException('Неверный профиль агента для этого сервера 1С')
    if (this.config.get('ONE_C_BASE_KIND') === 'PRODUCTION') {
      const baseId = this.config.get<string>('ONE_C_PRODUCTION_BASE_ID')?.trim()
      if (!baseId || req.headers['x-1c-base-kind'] !== 'PRODUCTION' || req.headers['x-1c-base-id'] !== baseId) {
        throw new ForbiddenException('Неверный профиль основной базы 1С. TEST-обмен не допускается.')
      }
    }
    return true
  }
}
