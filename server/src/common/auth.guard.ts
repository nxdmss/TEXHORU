import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'

export type AuthPayload = { sub: string; email: string; role: 'CUSTOMER' | 'MANAGER' | 'DIRECTOR' | 'ADMIN' }

function cookieValue(header: string | undefined, name: string) {
  if (!header) return undefined
  for (const pair of header.split(';')) {
    const [key, ...parts] = pair.trim().split('=')
    if (key === name) return decodeURIComponent(parts.join('='))
  }
  return undefined
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; user?: AuthPayload }>()
    const auth = request.headers.authorization
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined
    const token = bearer ?? cookieValue(request.headers.cookie, 'texhoru_admin')
    if (!token) throw new UnauthorizedException('Требуется авторизация')
    try {
      request.user = await this.jwt.verifyAsync<AuthPayload>(token)
      return true
    } catch {
      throw new UnauthorizedException('Недействительная сессия')
    }
  }
}
