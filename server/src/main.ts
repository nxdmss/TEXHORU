import 'reflect-metadata'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import helmet from 'helmet'
import { AppModule } from './app.module'

function assertProductionEnv() {
  if (process.env.NODE_ENV !== 'production') return
  const required = ['DATABASE_URL', 'JWT_SECRET', 'ONE_C_API_KEY', 'FRONTEND_ORIGIN', 'FRONTEND_PUBLIC_URL']
  const missing = required.filter((key) => !process.env[key])
  if (missing.length) throw new Error(`Missing production env: ${missing.join(', ')}`)
  if ((process.env.JWT_SECRET ?? '').length < 32) throw new Error('JWT_SECRET must be at least 32 characters')
  if ((process.env.ONE_C_API_KEY ?? '').length < 24) throw new Error('ONE_C_API_KEY must be at least 24 characters')
  if (process.env.ALLOW_DEV_PAYMENT === 'true') throw new Error('ALLOW_DEV_PAYMENT must be false in production')
  if ((process.env.JWT_SECRET ?? '').includes('change-me')) throw new Error('Default JWT_SECRET is forbidden in production')
  if ((process.env.ONE_C_API_KEY ?? '').includes('change-me')) throw new Error('Default ONE_C_API_KEY is forbidden in production')
}

async function bootstrap() {
  assertProductionEnv()
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: false })
  app.useBodyParser('json', { limit: '10mb' })
  const origins = (process.env.FRONTEND_ORIGIN ?? 'http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
  app.enableCors({ origin: origins, credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE'] })
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
  app.setGlobalPrefix('api')

  if (process.env.SERVE_STOREFRONT === 'true') {
    const storefrontDist = resolve(__dirname, '..', '..', 'dist')
    const indexPath = resolve(storefrontDist, 'index.html')
    if (!existsSync(indexPath)) {
      throw new Error(`Storefront build not found: ${indexPath}. Run npm run build first.`)
    }

    app.useStaticAssets(storefrontDist, { index: false, fallthrough: true })
    const express = app.getHttpAdapter().getInstance()
    express.use((req: any, res: any, next: any) => {
      if (req.method !== 'GET' || req.path?.startsWith('/api')) return next()
      return res.sendFile(indexPath)
    })
  }

  const port = Number(process.env.PORT ?? 3000)
  await app.listen(port, process.env.HOST || '0.0.0.0')
  process.on('message', message => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'TEXHORU_SHUTDOWN') {
      void app.close().then(() => process.exit(0))
    }
  })
  console.log(`TEXHORU server: http://127.0.0.1:${port}/`)
  console.log(`TEXHORU API:    http://127.0.0.1:${port}/api`)
}

bootstrap()
