import { Body, Controller, Delete, Get, Header, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common'
import { AdminGuard } from '../common/admin.guard'
import { AuthGuard, type AuthPayload } from '../common/auth.guard'
import { CreateCategoryDto, UpdateCategoryDto, UpdateProductDto, UpsertProductDto } from './products.dto'
import { ProductsService } from './products.service'

@Controller()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get('products') @Header('Cache-Control', 'no-store, max-age=0') list() { return this.products.list() }
  @Get('products/:id') @Header('Cache-Control', 'no-store, max-age=0') get(@Param('id', ParseIntPipe) id: number) { return this.products.get(id) }
  @Get('categories') @Header('Cache-Control', 'no-store, max-age=0') categories() { return this.products.categories() }

  @Get('admin/categories') @UseGuards(AuthGuard, AdminGuard) adminCategories() { return this.products.adminCategories() }
  @Post('admin/categories') @UseGuards(AuthGuard, AdminGuard) createCategory(@Body() dto: CreateCategoryDto, @Req() req: { user?: AuthPayload }) { return this.products.createCategory(dto, req.user?.sub) }
  @Patch('admin/categories/:id') @UseGuards(AuthGuard, AdminGuard) updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto, @Req() req: { user?: AuthPayload }) { return this.products.updateCategory(id, dto, req.user?.sub) }

  @Get('admin/products') @UseGuards(AuthGuard, AdminGuard) adminList() { return this.products.adminList() }
  @Post('admin/products') @UseGuards(AuthGuard, AdminGuard) create(@Body() dto: UpsertProductDto, @Req() req: { user?: AuthPayload }) { return this.products.create(dto, req.user?.sub) }
  @Patch('admin/products/:id') @UseGuards(AuthGuard, AdminGuard) update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateProductDto, @Req() req: { user?: AuthPayload }) { return this.products.update(id, dto, req.user?.sub) }
  @Patch('admin/products/:id/restore') @UseGuards(AuthGuard, AdminGuard) restore(@Param('id', ParseIntPipe) id: number, @Req() req: { user?: AuthPayload }) { return this.products.restore(id, req.user?.sub) }
  @Delete('admin/products/:id/permanent') @UseGuards(AuthGuard, AdminGuard) removePermanently(@Param('id', ParseIntPipe) id: number, @Req() req: { user?: AuthPayload }) { return this.products.removePermanently(id, req.user?.sub) }
  @Delete('admin/products/:id') @UseGuards(AuthGuard, AdminGuard) archive(@Param('id', ParseIntPipe) id: number, @Req() req: { user?: AuthPayload }) { return this.products.archive(id, req.user?.sub) }
}
