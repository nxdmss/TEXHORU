import { Injectable, NotFoundException, UnsupportedMediaTypeException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createReadStream, promises as fs } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const MIME_BY_EXT: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif' }
const EXT_BY_MIME: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif' }
type UploadedImage = { originalname: string; mimetype: string; size: number; buffer: Buffer }
type MediaFolder = 'products' | 'promos'

@Injectable()
export class MediaService {
  private readonly localRoot = resolve(process.cwd(), 'uploads')
  private readonly driver: 'local' | 'yandex'
  private readonly bucket: string
  private readonly publicBaseUrl: string
  private readonly s3?: S3Client

  constructor(private readonly config: ConfigService) {
    this.driver = config.get<string>('MEDIA_STORAGE_DRIVER') === 'yandex' ? 'yandex' : 'local'
    this.bucket = config.get<string>('YC_STORAGE_BUCKET') ?? ''
    this.publicBaseUrl = (config.get<string>('MEDIA_PUBLIC_BASE_URL') ?? '').replace(/\/$/, '')
    if (config.get<string>('NODE_ENV') === 'production' && this.driver !== 'yandex') {
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
