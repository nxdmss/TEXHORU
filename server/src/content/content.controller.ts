import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common'
import type { AuthPayload } from '../common/auth.guard'
import { AuthGuard } from '../common/auth.guard'
import { AdminGuard } from '../common/admin.guard'
import { ContentService } from './content.service'
import { PromoDto, StorefrontLayoutDto, UpdatePromoDto } from './content.dto'

@Controller()
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get('content/promos') @Header('Cache-Control', 'no-store, max-age=0') promos() { return this.content.publicPromos() }
  @Get('admin/content/promos') @UseGuards(AuthGuard, AdminGuard) adminPromos() { return this.content.adminPromos() }
  @Post('admin/content/promos') @UseGuards(AuthGuard, AdminGuard) create(@Body() dto: PromoDto, @Req() req: { user?: AuthPayload }) { return this.content.create(dto, req.user?.sub) }
  @Patch('admin/content/promos/:id') @UseGuards(AuthGuard, AdminGuard) update(@Param('id') id: string, @Body() dto: UpdatePromoDto, @Req() req: { user?: AuthPayload }) { return this.content.update(id, dto, req.user?.sub) }
  @Delete('admin/content/promos/:id') @UseGuards(AuthGuard, AdminGuard) remove(@Param('id') id: string, @Req() req: { user?: AuthPayload }) { return this.content.remove(id, req.user?.sub) }

  @Get('content/layout') @Header('Cache-Control', 'no-store, max-age=0') layout() { return this.content.publicLayout() }
  @Get('admin/content/layout') @UseGuards(AuthGuard, AdminGuard) adminLayout() { return this.content.adminLayout() }
  @Put('admin/content/layout/draft') @UseGuards(AuthGuard, AdminGuard) saveLayout(@Body() dto: StorefrontLayoutDto, @Req() req: { user?: AuthPayload }) { return this.content.saveLayout(dto.layout, req.user?.sub) }
  @Post('admin/content/layout/publish') @UseGuards(AuthGuard, AdminGuard) publishLayout(@Body() dto: StorefrontLayoutDto, @Req() req: { user?: AuthPayload }) { return this.content.publishLayout(dto.layout, req.user?.sub) }
}
