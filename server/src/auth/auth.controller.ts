import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common'
import { AuthGuard, type AuthPayload } from '../common/auth.guard'
import { AuthService } from './auth.service'
import { LoginDto } from './auth.dto'

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) response: { cookie: (name: string, value: string, options: Record<string, unknown>) => void; clearCookie: (name: string, options: Record<string, unknown>) => void }) {
    const result = await this.auth.login(dto)
    response.cookie('texhoru_admin', result.accessToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/api',
      maxAge: 8 * 60 * 60 * 1000,
    })
    return { user: result.user }
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) response: { cookie: (name: string, value: string, options: Record<string, unknown>) => void; clearCookie: (name: string, options: Record<string, unknown>) => void }) {
    response.clearCookie('texhoru_admin', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/api' })
    return { ok: true }
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() request: { user?: AuthPayload }) { return request.user }
}
