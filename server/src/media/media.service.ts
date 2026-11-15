import { Injectable, NotFoundException, UnsupportedMediaTypeException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createReadStream, promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const MIME_BY_EXT: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif' }
const EXT_BY_MIME: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif' }
const RETAIL_MEDIA_ROOTS = ['05.ru', 'mvideo.ru', 'dns-shop.ru']
type UploadedImage = { originalname: string; mimetype: string; size: number; buffer: Buffer }
type MediaFolder = 'products' | 'promos'

@Injectable()
export class MediaService {
  private readonly localRoot = resolve(process.env.TEXHORU_UPLOADS_DIR || resolve(process.cwd(), 'uploads'))
  private readonly driver: 'local' | 'yandex'
  private readonly bucket: string
  private readonly publicBaseUrl: string
  private readonly s3?: S3Client

  constructor(private readonly config: ConfigService) {
    this.driver = config.get<string>('MEDIA_STORAGE_DRIVER') === 'yandex' ? 'yandex' : 'local'
    this.bucket = config.get<string>('YC_STORAGE_BUCKET') ?? ''
    this.publicBaseUrl = (config.get<string>('MEDIA_PUBLIC_BASE_URL') ?? '').replace(/\/$/, '')
    const persistentLocal = config.get<string>('ALLOW_PERSISTENT_LOCAL_MEDIA') === 'true'
      && !!process.env.TEXHORU_UPLOADS_DIR && isAbsolute(process.env.TEXHORU_UPLOADS_DIR)
    if (config.get<string>('NODE_ENV') === 'production' && this.driver !== 'yandex' && !persistentLocal) {
      throw new Error('MEDIA_STORAGE_DRIVER=yandex is required in production')
    }
    if (this.driver === 'yandex') {
      this.s3 = new S3Client({
        region: config.get<string>('YC_STORAGE_REGION') ?? 'ru-central1',
        endpoint: config.get<string>('YC_STORAGE_ENDPOINT') ?? 'https://storage.yandexcloud.net',
        credentials: {
          accessKeyId: config.get<string>('YC_STORAGE_ACCESS_KEY_ID') ?? '',
          secretAccessKey: config.get<string>('YC_STORAGE_SECRET_ACCESS_KEY') ?? '',
        },
      })
    }
  }

  private validate(file: UploadedImage) {
    const ext = EXT_BY_MIME[file.mimetype]
    if (!ext) throw new UnsupportedMediaTypeException('Разрешены JPG, PNG, WEBP и AVIF')
    if (!file.buffer?.length) throw new UnsupportedMediaTypeException('Файл изображения пустой')
    return ext
  }

  private async uploadImage(file: UploadedImage, folder: MediaFolder) {
    const ext = this.validate(file)
    const key = `${folder}/${Date.now()}-${randomUUID()}${ext}`
    if (this.driver === 'yandex') {
      if (!this.s3 || !this.bucket || !this.publicBaseUrl) throw new Error('Yandex Object Storage не настроен')
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: file.buffer, ContentType: file.mimetype, CacheControl: 'public, max-age=31536000, immutable' }))
      return { url: `${this.publicBaseUrl}/${key}`, key, storage: 'yandex' as const }
    }
    const root = join(this.localRoot, folder)
    await fs.mkdir(root, { recursive: true })
    const filename = basename(key)
    await fs.writeFile(join(root, filename), file.buffer)
    return { url: `/api/uploads/${folder}/${filename}`, key, storage: 'local' as const }
  }

  uploadProductImage(file: UploadedImage) { return this.uploadImage(file, 'products') }
  uploadPromoImage(file: UploadedImage) { return this.uploadImage(file, 'promos') }

  async importRetailProductImage(rawUrl: string) {
    let url: URL
    try { url = new URL(rawUrl) } catch { throw new UnsupportedMediaTypeException('Некорректная ссылка изображения') }
    const allowed = (candidate: URL) => candidate.protocol === 'https:' && !candidate.username && !candidate.password
      && !candidate.port && RETAIL_MEDIA_ROOTS.some(root => candidate.hostname === root || candidate.hostname.endsWith('.' + root))
    if (!allowed(url)) throw new UnsupportedMediaTypeException('Изображение находится вне разрешённого домена магазина')
    let response: Response | undefined
    for (let redirect = 0; redirect < 4; redirect++) {
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { accept: 'image/avif,image/webp,image/png,image/jpeg' } })
      if (response.status < 300 || response.status >= 400) break
      const location = response.headers.get('location')
      if (!location) throw new UnsupportedMediaTypeException('Магазин вернул пустое перенаправление изображения')
      url = new URL(location, url)
      if (!allowed(url)) throw new UnsupportedMediaTypeException('Изображение перенаправлено вне разрешённого домена магазина')
    }
    if (!response?.ok) throw new UnsupportedMediaTypeException(`Не удалось получить изображение: HTTP ${response?.status || 0}`)
    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > 8 * 1024 * 1024) throw new UnsupportedMediaTypeException('Изображение больше 8 МБ')
    const mimetype = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!EXT_BY_MIME[mimetype]) throw new UnsupportedMediaTypeException('Магазин вернул файл неподдерживаемого формата')
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > 8 * 1024 * 1024) throw new UnsupportedMediaTypeException('Изображение больше 8 МБ')
    return this.uploadProductImage({ originalname: basename(url.pathname) || 'product', mimetype, size: buffer.length, buffer })
  }

  private async openLocalImage(filename: string, folder: MediaFolder) {
    const safeName = basename(filename)
    if (safeName !== filename || !/^[a-zA-Z0-9._-]+$/.test(safeName)) throw new NotFoundException('Файл не найден')
    const path = join(this.localRoot, folder, safeName)
    try { await fs.access(path) } catch { throw new NotFoundException('Файл не найден') }
    return { stream: createReadStream(path), type: MIME_BY_EXT[extname(safeName).toLowerCase()] ?? 'application/octet-stream' }
  }

  openLocalProductImage(filename: string) { return this.openLocalImage(filename, 'products') }
  openLocalPromoImage(filename: string) { return this.openLocalImage(filename, 'promos') }
}
