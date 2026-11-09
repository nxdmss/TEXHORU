import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect()
    if (process.env.SQLITE_WAL_ENABLED === 'true' && process.env.DATABASE_URL?.startsWith('file:')) {
      await this.$queryRawUnsafe('PRAGMA journal_mode = WAL')
      await this.$queryRawUnsafe('PRAGMA busy_timeout = 10000')
      await this.$queryRawUnsafe('PRAGMA journal_size_limit = 16777216')
    }
  }
  async onModuleDestroy() { await this.$disconnect() }
}
