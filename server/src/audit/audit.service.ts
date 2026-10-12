import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  log(
    userId: string | undefined,
    action: string,
    entity: string,
    entityId?: string,
    details?: Prisma.InputJsonValue,
  ) {
    return this.prisma.auditLog.create({
      data: {
        userId,
        action,
        entity,
        entityId,
        details: details ?? undefined,
      },
    })
  }

  list() {
    return this.prisma.auditLog.findMany({
      include: { user: { select: { name: true, email: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    })
  }
}
