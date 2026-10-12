import { BadRequestException, Controller, Get, Param, Post, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { AdminGuard } from '../common/admin.guard'
import { AuthGuard } from '../common/auth.guard'
import { MediaService } from './media.service'

@Controller()
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('admin/uploads/product-image')
  @UseGuards(AuthGuard, AdminGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  uploadProductImage(@UploadedFile() file: any) {
    if (!file) throw new BadRequestException('Файл не передан')
    return this.media.uploadProductImage(file)
  }

  @Post('admin/uploads/promo-image')
  @UseGuards(AuthGuard, AdminGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  uploadPromoImage(@UploadedFile() file: any) {
    if (!file) throw new BadRequestException('Файл не передан')
    return this.media.uploadPromoImage(file)
  }

  @Get('uploads/products/:filename')
  async localProductImage(@Param('filename') filename: string) {
    const file = await this.media.openLocalProductImage(filename)
    return new StreamableFile(file.stream, { type: file.type, disposition: 'inline' })
  }

  @Get('uploads/promos/:filename')
  async localPromoImage(@Param('filename') filename: string) {
    const file = await this.media.openLocalPromoImage(filename)
    return new StreamableFile(file.stream, { type: file.type, disposition: 'inline' })
  }
}
