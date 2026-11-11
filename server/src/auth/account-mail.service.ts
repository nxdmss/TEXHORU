import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import nodemailer, { type Transporter } from 'nodemailer'
import { accountEmail } from './auth-email'

@Injectable()
export class AccountMailService implements OnModuleDestroy {
  private readonly logger = new Logger(AccountMailService.name)
  private transport?: Transporter
  constructor(private readonly config: ConfigService) {}
  configured() { return Boolean(this.config.get('SMTP_HOST') && this.config.get('SMTP_USER') && this.config.get('SMTP_PASSWORD') && this.config.get('MAIL_FROM')) }
  assertConfigured() {
    if (!this.configured()) throw new ServiceUnavailableException('Письма пока не подключены. Попробуйте позже; оформить заказ можно без регистрации.')
  }
  async send(email: string, name: string, token: string, purpose: 'VERIFY' | 'RESET') {
    this.assertConfigured()
    const base = this.config.get<string>('FRONTEND_PUBLIC_URL') || ''
    const origin = new URL(base)
    if (origin.protocol !== 'https:' && this.config.get('NODE_ENV') === 'production') throw new ServiceUnavailableException('Для писем нужен HTTPS-адрес магазина')
    const url = new URL('/login', origin)
    // Fragment avoids leaking the one-use token into HTTP logs/referrers.
    url.hash = new URLSearchParams({ action: purpose === 'VERIFY' ? 'verify' : 'reset', token }).toString()
    const content = accountEmail(name, url.toString(), purpose)
    const port = Number(this.config.get('SMTP_PORT') || 465)
    this.transport ??= nodemailer.createTransport({
      host: this.config.get<string>('SMTP_HOST'), port, secure: port === 465,
      requireTLS: port !== 465,
      auth: { user: this.config.get<string>('SMTP_USER'), pass: this.config.get<string>('SMTP_PASSWORD') },
      pool: true, maxConnections: 1, maxMessages: 50,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
      disableFileAccess: true, disableUrlAccess: true,
    })
    try {
      await this.transport.sendMail({ from: this.config.get<string>('MAIL_FROM'), to: email, ...content })
    } catch (error) {
      // Never log the message, response, address or transport: these may contain
      // credentials, recipient data or the one-use account link.
      const failure = error as { code?: unknown; responseCode?: unknown; command?: unknown } | null
      const safeLabel = (value: unknown) => typeof value === 'string' && /^[A-Z0-9 _-]{1,40}$/.test(value) ? value : 'unknown'
      const responseCode = typeof failure?.responseCode === 'number' && Number.isInteger(failure.responseCode) ? failure.responseCode : 'unknown'
      this.logger.error(`Account email delivery failed: code=${safeLabel(failure?.code)} responseCode=${responseCode} command=${safeLabel(failure?.command)}`)
      throw new ServiceUnavailableException('Не удалось отправить письмо. Попробуйте ещё раз чуть позже.')
    }
  }
  onModuleDestroy() { this.transport?.close() }
}
