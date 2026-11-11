import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import bcrypt from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { EmailDto, LoginDto, RegisterDto, ResetPasswordDto, UpdateProfileDto } from './auth.dto'
import { AccountMailService } from './account-mail.service'

const publicUser = { id: true, name: true, email: true, phone: true, deliveryAddress: true, emailVerifiedAt: true, role: true } as const
const genericMessage = 'Если адрес подходит для этой операции, письмо отправлено. Проверьте также папку «Спам».'
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService, private readonly mail: AccountMailService) {}

  async login(dto: LoginDto, customer = false) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.trim().toLowerCase() } })
    if (!user || !user.isActive || !(await bcrypt.compare(dto.password, user.passwordHash)) || (customer ? user.role !== 'CUSTOMER' : user.role === 'CUSTOMER')) {
      throw new UnauthorizedException('Неверный email или пароль')
    }
    if (customer && !user.emailVerifiedAt) throw new ForbiddenException('Подтвердите почту перед входом. При необходимости запросите новое письмо.')
    const accessToken = await this.jwt.signAsync({ sub: user.id, email: user.email, role: user.role, version: user.sessionVersion })
    return { accessToken, user: await this.profile(user.id) }
  }

  async register(dto: RegisterDto) {
    this.mail.assertConfigured()
    if (dto.password.length < 10 || Buffer.byteLength(dto.password) > 72) throw new BadRequestException('Пароль: от 10 символов и не более 72 байт')
    if (dto.name.trim().length < 2) throw new BadRequestException('Укажите имя от двух символов')
    const email = dto.email.trim().toLowerCase()
    const existing = await this.prisma.user.findUnique({ where: { email } })
    if (existing) {
      if (existing.role === 'CUSTOMER' && !existing.emailVerifiedAt && existing.isActive) await this.issueToken(existing.id, 'VERIFY')
      return { message: genericMessage }
    }
    try {
      const user = await this.prisma.user.create({ data: { email, name: dto.name.trim(), passwordHash: await bcrypt.hash(dto.password, 12), role: 'CUSTOMER' } })
      await this.issueToken(user.id, 'VERIFY')
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e
    }
    return { message: genericMessage }
  }

  async requestEmail(dto: EmailDto, purpose: 'VERIFY' | 'RESET') {
    this.mail.assertConfigured()
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.trim().toLowerCase() } })
    if (user?.isActive && user.role === 'CUSTOMER' && (purpose === 'RESET' ? Boolean(user.emailVerifiedAt) : !user.emailVerifiedAt)) await this.issueToken(user.id, purpose)
    return { message: genericMessage }
  }

  private async issueToken(userId: string, purpose: 'VERIFY' | 'RESET') {
    const token = randomBytes(32).toString('hex')
    // One send per address per minute, including simultaneous requests.
    const issued = await this.prisma.$transaction(async tx => {
      const recent = await tx.emailToken.findFirst({ where: { userId, purpose, usedAt: null, createdAt: { gt: new Date(Date.now() - 60000) } } })
      if (recent) return null
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } })
      const record = await tx.emailToken.create({ data: { userId, purpose, tokenHash: hash(token), expiresAt: new Date(Date.now() + (purpose === 'VERIFY' ? 86400000 : 1800000)) } })
      return { user, record }
    })
    if (!issued) return
    try { await this.mail.send(issued.user.email, issued.user.name, token, purpose) }
    catch (error) { await this.prisma.emailToken.deleteMany({ where: { id: issued.record.id } }); throw error }
  }

  async verify(token: string) {
    await this.consume(token, 'VERIFY')
    return { message: 'Почта подтверждена. Теперь можно войти в кабинет.' }
  }
  async reset(dto: ResetPasswordDto) {
    if (Buffer.byteLength(dto.password) > 72) throw new BadRequestException('Пароль не должен превышать 72 байта')
    await this.consume(dto.token, 'RESET', await bcrypt.hash(dto.password, 12))
    return { message: 'Пароль обновлён. Войдите с новым паролем.' }
  }
  private async consume(token: string, purpose: string, passwordHash?: string) {
    await this.prisma.$transaction(async tx => {
      const record = await tx.emailToken.findUnique({ where: { tokenHash: hash(token) }, include: { user: true } })
      if (!record || record.purpose !== purpose || record.usedAt || record.expiresAt <= new Date() || !record.user.isActive || record.user.role !== 'CUSTOMER') throw new BadRequestException('Ссылка недействительна или уже использована. Запросите новое письмо.')
      const claimed = await tx.emailToken.updateMany({ where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } })
      if (claimed.count !== 1) throw new BadRequestException('Ссылка уже использована')
      await tx.user.update({ where: { id: record.userId }, data: purpose === 'VERIFY' ? { emailVerifiedAt: new Date() } : { passwordHash, sessionVersion: { increment: 1 } } })
      await tx.emailToken.updateMany({ where: { userId: record.userId, purpose, usedAt: null }, data: { usedAt: new Date() } })
    })
  }
  profile(id: string) { return this.prisma.user.findUniqueOrThrow({ where: { id }, select: publicUser }) }
  async updateProfile(id: string, dto: UpdateProfileDto) {
    if (dto.name.trim().length < 2) throw new BadRequestException('Укажите имя от двух символов')
    try { return await this.prisma.user.update({ where: { id }, data: { name: dto.name.trim(), phone: dto.phone?.trim() || null, deliveryAddress: dto.deliveryAddress?.trim() }, select: publicUser }) }
    catch (error) { if ((error as { code?: string }).code === 'P2002') throw new ConflictException('Этот телефон уже используется'); throw error }
  }
}
