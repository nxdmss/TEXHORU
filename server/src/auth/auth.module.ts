import { AccountMailService } from './account-mail.service'
import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import { AuthController, AccountController } from './auth.controller'
import { AuthService } from './auth.service'
import { AuthGuard, CustomerGuard, OptionalCustomerGuard } from '../common/auth.guard'
import { AdminGuard } from '../common/admin.guard'

@Module({
  imports: [JwtModule.registerAsync({
    inject: [ConfigService],
    useFactory: (config: ConfigService) => ({ secret: config.get<string>('JWT_SECRET') ?? 'dev-only-change-me', signOptions: { expiresIn: '8h' } }),
  })],
  controllers: [AuthController, AccountController],
  providers: [AuthService, AccountMailService, AuthGuard, CustomerGuard, OptionalCustomerGuard, AdminGuard],
  exports: [JwtModule, AuthGuard, CustomerGuard, OptionalCustomerGuard, AdminGuard],
})
export class AuthModule {}
