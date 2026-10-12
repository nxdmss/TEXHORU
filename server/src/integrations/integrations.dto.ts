import { IsArray, IsEnum, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import { OrderStatus } from '@prisma/client'

export class OneCCategoryDto {
  @IsString() oneCId!: string
  @IsString() name!: string
  @IsString() slug!: string
}

export class OneCProductDto {
  @IsString() oneCId!: string
  @IsString() sku!: string
  @IsString() name!: string
  @IsString() slug!: string
  @IsString() brand!: string
  @IsString() categoryOneCId!: string
  @IsInt() @Min(0) price!: number
  @IsInt() @Min(0) stockQty!: number
  @IsOptional() @IsInt() @Min(0) oldPrice?: number
}

export class OneCCatalogDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => OneCCategoryDto) categories!: OneCCategoryDto[]
  @IsArray() @ValidateNested({ each: true }) @Type(() => OneCProductDto) products!: OneCProductDto[]
}

export class OneCOrderStatusDto {
  @IsString() siteOrderId!: string
  @IsEnum(OrderStatus) status!: OrderStatus
}
