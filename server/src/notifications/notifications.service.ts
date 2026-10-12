import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async create(
    type: string,
    title: string,
    body: string,
    metadata?: Prisma.InputJsonValue,
  ) {
    const notification = await this.prisma.notification.create({
      data: {
        type,
        title,
        body,
        metadata: metadata ?? undefined,
      },
    })

    await this.sendTelegram(`${title}\n${body}`).catch(() => undefined)
    return notification
  }

  list() {
    return this.prisma.notification.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
  }

  markRead(id: string) {
    return this.prisma.notification.update({
      where: { id },
      data: { isRead: true },
    })
  }

  private async sendTelegram(text: string) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN')
    const chatId = this.config.get<string>('TELEGRAM_CHAT_ID')
    if (!token || !chatId) return

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
  }
}
