import { Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import bcrypt from 'bcryptjs'
import { PrismaService } from '../prisma/prisma.service'
import { LoginDto } from './auth.dto'

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } })
    if (!user || !user.isActive || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Неверный email или пароль')
    }
    const accessToken = await this.jwt.signAsync({ sub: user.id, email: user.email, role: user.role })
    return { accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role } }
  }
}
