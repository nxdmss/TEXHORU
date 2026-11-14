import { Type } from 'class-transformer'
import { IsIn, IsInt, IsArray, ArrayMaxSize, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'
export class CatalogQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) take = 24
  @IsOptional() @IsString() @MaxLength(100) q?: string
  @IsOptional() @IsString() @MaxLength(1000) path?: string
  @IsOptional() @IsString() @MaxLength(100) brand?: string
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(5_000_000) minPrice?: number
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(5_000_000) maxPrice?: number
  @IsOptional() @IsIn(['true', 'false']) available?: string
  @IsOptional() @IsIn(['true', 'false']) smartphones?: string
  @IsOptional() @IsIn(['recommended', 'price-asc', 'price-desc', 'name']) sort?: string
}

export class CartProductsDto {
  @IsArray() @ArrayMaxSize(100) @IsInt({ each: true }) @Min(1, { each: true }) ids!: number[]
}
