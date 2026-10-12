import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator'

export class UpsertProductDto {
  @IsOptional() @IsString() oneCId?: string
  @IsString() sku!: string
  @IsString() slug!: string
  @IsString() name!: string
  @IsString() brand!: string
  @IsString() categoryId!: string
  @IsInt() @Min(0) price!: number
  @IsOptional() @IsInt() @Min(0) oldPrice?: number
  @IsOptional() @IsInt() @Min(0) stockQty?: number
  @IsOptional() @IsString() stockState?: 'IN_STOCK' | 'LOW' | 'PREORDER' | 'OUT_OF_STOCK'
  @IsOptional() @IsString() badge?: string
  @IsOptional() @IsString() image?: string
  @IsOptional() @IsString() shortSpec?: string
  @IsOptional() @IsString() description?: string
  @IsOptional() @IsString() warranty?: string
  @IsOptional() @IsString() deliveryNote?: string
  @IsOptional() @IsArray() specs?: Array<{ label: string; value: string }>
}

export class UpdateProductDto {
  @IsOptional() @IsString() oneCId?: string
  @IsOptional() @IsString() sku?: string
  @IsOptional() @IsString() slug?: string
  @IsOptional() @IsString() name?: string
  @IsOptional() @IsString() brand?: string
  @IsOptional() @IsString() categoryId?: string
  @IsOptional() @IsInt() @Min(0) price?: number
  @IsOptional() @IsInt() @Min(0) oldPrice?: number
  @IsOptional() @IsInt() @Min(0) stockQty?: number
  @IsOptional() @IsString() stockState?: 'IN_STOCK' | 'LOW' | 'PREORDER' | 'OUT_OF_STOCK'
  @IsOptional() @IsString() badge?: string
  @IsOptional() @IsString() image?: string
  @IsOptional() @IsString() shortSpec?: string
  @IsOptional() @IsString() description?: string
  @IsOptional() @IsString() warranty?: string
  @IsOptional() @IsString() deliveryNote?: string
  @IsOptional() @IsArray() specs?: Array<{ label: string; value: string }>
}


export class CreateCategoryDto {
  @IsString() name!: string
  @IsString() slug!: string
  @IsOptional() @IsInt() @Min(0) sortOrder?: number
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() name?: string
  @IsOptional() @IsString() slug?: string
  @IsOptional() @IsInt() @Min(0) sortOrder?: number
  @IsOptional() @IsBoolean() isActive?: boolean
}
