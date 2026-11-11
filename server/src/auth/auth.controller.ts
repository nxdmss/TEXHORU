import { Body, Controller, Get, Header, Patch, Post, Req, Res, UseGuards } from '@nestjs/common'
import { AuthGuard, CustomerGuard, type AuthPayload } from '../common/auth.guard'
import { AuthService } from './auth.service'
import { EmailDto, LoginDto, RegisterDto, ResetPasswordDto, TokenDto, UpdateProfileDto } from './auth.dto'
import { Throttle } from '@nestjs/throttler'
import { AccountMailService } from './account-mail.service'
type CookieResponse = { cookie: (name: string, value: string, options: Record<string, unknown>) => void; clearCookie: (name: string, options: Record<string, unknown>) => void }
const cookieOptions = () => ({ httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/api', maxAge: 8 * 60 * 60 * 1000 })

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly mail: AccountMailService) {}

  @Post('login') @Header('Cache-Control', 'no-store') @Throttle({ default: { limit: 10, ttl: 60000 } })
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

  @Post('logout') @Header('Cache-Control', 'no-store')
  logout(@Res({ passthrough: true }) response: { cookie: (name: string, value: string, options: Record<string, unknown>) => void; clearCookie: (name: string, options: Record<string, unknown>) => void }) {
    response.clearCookie('texhoru_admin', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/api' })
    return { ok: true }
  }

  @Get('capabilities') @Header('Cache-Control', 'no-store') capabilities() { return { emailConfigured: this.mail.configured() } }
  @Post('register') @Header('Cache-Control', 'no-store') @Throttle({ default: { limit: 5, ttl: 60000 } })
  register(@Body() dto: RegisterDto) { return this.auth.register(dto) }
  @Post('customer-login') @Header('Cache-Control', 'no-store') @Throttle({ default: { limit: 10, ttl: 60000 } })
  async customerLogin(@Body() dto: LoginDto, @Res({ passthrough: true }) res: CookieResponse) {
    const result = await this.auth.login(dto, true)
    res.cookie('texhoru_customer', result.accessToken, cookieOptions())
    return { user: result.user }
  }
  @Post('customer-logout') @Header('Cache-Control', 'no-store')
  customerLogout(@Res({ passthrough: true }) res: CookieResponse) { res.clearCookie('texhoru_customer', cookieOptions()); return { ok: true } }
  @Post('resend-verification') @Header('Cache-Control', 'no-store') @Throttle({ default: { limit: 5, ttl: 60000 } })
  resend(@Body() dto: EmailDto) { return this.auth.requestEmail(dto, 'VERIFY') }
  @Post('forgot-password') @Header('Cache-Control', 'no-store') @Throttle({ default: { limit: 5, ttl: 60000 } })
  forgot(@Body() dto: EmailDto) { return this.auth.requestEmail(dto, 'RESET') }
  @Post('verify-email') @Header('Cache-Control', 'no-store') @Throttle({ default: { limit: 10, ttl: 60000 } })
  verify(@Body() dto: TokenDto) { return this.auth.verify(dto.token) }
  @Post('reset-password') @Header('Cache-Control', 'no-store') @Throttle({ default: { limit: 10, ttl: 60000 } })
  reset(@Body() dto: ResetPasswordDto) { return this.auth.reset(dto) }

  @Get('me') @Header('Cache-Control', 'no-store')
  @UseGuards(AuthGuard)
  me(@Req() request: { user?: AuthPayload }) { return request.user }
}

@Controller('account')
@UseGuards(CustomerGuard)
export class AccountController {
  constructor(private readonly auth: AuthService) {}
  @Get('profile') @Header('Cache-Control', 'no-store') profile(@Req() req: { user: AuthPayload }) { return this.auth.profile(req.user.sub) }
  @Patch('profile') @Header('Cache-Control', 'no-store') update(@Req() req: { user: AuthPayload }, @Body() dto: UpdateProfileDto) { return this.auth.updateProfile(req.user.sub, dto) }
}
