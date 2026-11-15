import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHash, timingSafeEqual } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { signOneCRequest, safeHexEqual } from './onec-signature'

type AgentRequest = {
  method: string
  originalUrl: string
  rawBody?: Buffer
  ip?: string
  headers: Record<string, string | string[] | undefined>
}

const header = (request: AgentRequest, name: string) => {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

@Injectable()
export class OneCGuard implements CanActivate {
  constructor(private readonly config: ConfigService, private readonly db?: PrismaService) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AgentRequest>()
    const secret = this.config.get<string>('ONE_C_API_KEY') ?? ''
    const actualKey = Buffer.from(header(request, 'x-1c-key') ?? '')
    const expectedKey = Buffer.from(secret)
    if (!expectedKey.length || actualKey.length !== expectedKey.length || !timingSafeEqual(actualKey, expectedKey)) {
      throw new UnauthorizedException('Неверный ключ 1С')
    }

    const announcedKind = header(request, 'x-1c-base-kind')
    if (announcedKind && announcedKind !== this.config.get('ONE_C_BASE_KIND')) throw new ForbiddenException('Неверный профиль агента для этого сервера 1С')
    const baseId = header(request, 'x-1c-base-id') ?? ''
    if (this.config.get('ONE_C_BASE_KIND') === 'PRODUCTION') {
      const productionBaseId = this.config.get<string>('ONE_C_PRODUCTION_BASE_ID')?.trim()
      if (!productionBaseId || announcedKind !== 'PRODUCTION' || baseId !== productionBaseId) {
        throw new ForbiddenException('Неверный профиль основной базы 1С. TEST-обмен не допускается.')
      }
    }

    const agentId = header(request, 'x-1c-agent-id') ?? ''
    const timestamp = header(request, 'x-1c-timestamp') ?? ''
    const nonce = header(request, 'x-1c-nonce') ?? ''
    const signature = header(request, 'x-1c-signature') ?? ''
    const anySignatureHeader = Boolean(agentId || timestamp || nonce || signature)
    if (!this.db) {
      if (this.config.get('ONE_C_REQUIRE_SIGNED_REQUESTS') === 'true' || anySignatureHeader) {
        throw new UnauthorizedException('Хранилище подписей агента недоступно')
      }
      return true
    }
    return this.verifySignedRequest(request, secret, baseId, { agentId, timestamp, nonce, signature, anySignatureHeader })
  }

  private async verifySignedRequest(request: AgentRequest, secret: string, baseId: string, signatureHeaders: {
    agentId: string; timestamp: string; nonce: string; signature: string; anySignatureHeader: boolean
  }) {
    const { agentId, timestamp, nonce, signature, anySignatureHeader } = signatureHeaders
    const settings = await this.db!.oneCIntegrationSettings.upsert({ where: { id: 'primary' }, create: { id: 'primary' }, update: {} })
    const signatureRequired = settings.requireSignedRequests || this.config.get('ONE_C_REQUIRE_SIGNED_REQUESTS') === 'true'
    if (signatureRequired && !anySignatureHeader) throw new UnauthorizedException('Требуется подпись запроса агента')

    if (anySignatureHeader) {
      if (!agentId || agentId.length > 100 || !/^\d{10}$/.test(timestamp) || !/^[a-f0-9-]{16,80}$/i.test(nonce) || !signature) {
        throw new UnauthorizedException('Неполные данные подписи агента')
      }
      const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp))
      if (age > 300) throw new UnauthorizedException('Подпись агента устарела')
      const path = request.originalUrl.split('?')[0]
      const expected = signOneCRequest(secret, request.method, path, timestamp, nonce, request.rawBody ?? Buffer.alloc(0))
      if (!safeHexEqual(signature, expected)) throw new UnauthorizedException('Неверная подпись агента')

      const existing = await this.db!.oneCAgentDevice.findUnique({ where: { agentId } })
      if (existing && !existing.enabled) throw new ForbiddenException('Устройство агента отключено')
      try {
        await this.db!.$transaction([
          this.db!.oneCAgentNonce.create({ data: { nonce, agentId, expiresAt: new Date(Date.now() + 10 * 60_000) } }),
          this.db!.oneCAgentDevice.upsert({
            where: { agentId },
            create: { agentId, baseId, lastSignedAt: new Date(), lastIpHash: this.ipHash(request.ip) },
            update: { baseId, lastSeenAt: new Date(), lastSignedAt: new Date(), lastIpHash: this.ipHash(request.ip) },
          }),
          this.db!.oneCAgentNonce.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
        ])
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') throw new UnauthorizedException('Повторно использованная подпись агента')
        throw error
      }
    }
    return true
  }

  private ipHash(ip?: string) {
    if (!ip) return null
    return createHash('sha256').update(`${this.config.get('JWT_SECRET') ?? 'local'}:${ip}`).digest('hex')
  }
}
