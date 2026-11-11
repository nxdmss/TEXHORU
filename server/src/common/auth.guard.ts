import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { PrismaService } from '../prisma/prisma.service'

export type AuthPayload = { sub: string; email: string; role: 'CUSTOMER' | 'MANAGER' | 'DIRECTOR' | 'ADMIN'; version?: number }
type Request = { headers: Record<string, string | undefined>; user?: AuthPayload }
function cookieValue(header: string | undefined, name: string) {
  try { return header?.split(';').map(p => p.trim().split('=')).find(([key]) => key === name)?.slice(1).map(decodeURIComponent).join('=') } catch { return undefined }
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(protected readonly jwt: JwtService, protected readonly prisma: PrismaService) {}
  protected token(request: Request, customer = false) {
    const auth = request.headers.authorization
    return auth?.startsWith('Bearer ') ? auth.slice(7) : cookieValue(request.headers.cookie, customer ? 'texhoru_customer' : 'texhoru_admin')
  }
  protected async authenticate(request: Request, customer = false) {
    const token = this.token(request, customer)
    if (!token) throw new UnauthorizedException('Требуется авторизация')
    try {
      const payload = await this.jwt.verifyAsync<AuthPayload>(token)
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { isActive: true, role: true, emailVerifiedAt: true, sessionVersion: true } })
      if (!user?.isActive || user.role !== payload.role || user.sessionVersion !== (payload.version ?? 0) || (customer && (user.role !== 'CUSTOMER' || !user.emailVerifiedAt))) throw new Error('revoked')
      request.user = payload
      return true
    } catch { throw new UnauthorizedException('Сессия завершена. Войдите ещё раз.') }
  }
  canActivate(context: ExecutionContext) { return this.authenticate(context.switchToHttp().getRequest<Request>()) }
}
@Injectable()
export class CustomerGuard extends AuthGuard {
  canActivate(context: ExecutionContext) { return this.authenticate(context.switchToHttp().getRequest<Request>(), true) }
}
@Injectable()
export class OptionalCustomerGuard extends AuthGuard {
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>()
    return this.token(request, true) ? this.authenticate(request, true) : true
  }
}
