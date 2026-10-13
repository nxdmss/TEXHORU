import { Controller, Get } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() async check() {
    await this.prisma.$queryRaw`SELECT 1`
    return { ok: true, service: 'texhoru-api', projectId: process.env.TEXHORU_PROJECT_ID || null, time: new Date().toISOString() }
  }
}
