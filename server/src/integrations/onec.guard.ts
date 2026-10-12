import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
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
    return true
  }
}
