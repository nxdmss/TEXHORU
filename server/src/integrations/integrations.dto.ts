import { IdentityDto } from '../price-monitor/price-monitor.dto'
import { IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, Min, ValidateNested, MaxLength, ArrayMaxSize, IsBoolean } from 'class-validator'
import { Type } from 'class-transformer'
import { OrderStatus } from '@prisma/client'

export class OneCCategoryDto {
  @IsString() @MaxLength(100) oneCId!: string
  @IsString() @MaxLength(500) name!: string
  @IsString() @MaxLength(200) slug!: string
}

export class OneCProductDto {
  @IsString() @MaxLength(100) oneCId!: string
  @IsString() @MaxLength(200) sku!: string
  @IsString() @MaxLength(500) name!: string
  @IsString() @MaxLength(200) slug!: string
  @IsString() @MaxLength(100) brand!: string
  @IsString() @MaxLength(100) categoryOneCId!: string
  @IsInt() @Min(0) price!: number
  @IsInt() @Min(0) stockQty!: number
  @IsOptional() @IsBoolean() isDeleted?: boolean
  @IsOptional() @IsInt() @Min(0) oldPrice?: number
  @IsOptional() @IsString() @MaxLength(30) gtin?: string
  @IsOptional() @IsString() @MaxLength(100) mpn?: string
  @IsOptional() @IsInt() @Min(0) costPrice?: number
  @IsOptional() @ValidateNested() @Type(() => IdentityDto) attributes?: IdentityDto
  // Original UT 10.3 fields used by the read-only nomenclature mirror.
  // Optional keeps the existing EPF/catalog API backwards-compatible.
  @IsOptional() @IsString() @MaxLength(50) sourceCode?: string
  @IsOptional() @IsString() @MaxLength(200) sourceArticle?: string
  @IsOptional() @IsString() @MaxLength(1000) sourceFullName?: string
  @IsOptional() @IsString() @MaxLength(100) sourceKind?: string
  @IsOptional() @IsString() @MaxLength(100) sourceUnit?: string
  @IsOptional() @IsDateString() sourceChangedAt?: string
}

export class OneCCatalogDto {
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => OneCCategoryDto) categories!: OneCCategoryDto[]
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => OneCProductDto) products!: OneCProductDto[]
}

export class OneCOrderStatusDto {
  @IsString() siteOrderId!: string
  @IsEnum(OrderStatus) status!: OrderStatus
}
