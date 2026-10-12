import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { AuthGuard } from '../common/auth.guard'
import { AdminGuard } from '../common/admin.guard'

@Module({
  imports: [JwtModule.registerAsync({
    inject: [ConfigService],
    useFactory: (config: ConfigService) => ({ secret: config.get<string>('JWT_SECRET') ?? 'dev-only-change-me', signOptions: { expiresIn: '8h' } }),
  })],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, AdminGuard],
  exports: [JwtModule, AuthGuard, AdminGuard],
})
export class AuthModule {}
