import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator'

export class PromoDto {
  @IsString() kicker!: string
  @IsString() title!: string
  @IsString() body!: string
  @IsString() ctaLabel!: string
  @IsString() category!: string
  @IsString() image!: string
  @IsOptional() @IsString() tone?: string
  @IsOptional() @IsInt() @Min(0) sortOrder?: number
  @IsOptional() @IsBoolean() isActive?: boolean
}

export class UpdatePromoDto {
  @IsOptional() @IsString() kicker?: string
  @IsOptional() @IsString() title?: string
  @IsOptional() @IsString() body?: string
  @IsOptional() @IsString() ctaLabel?: string
  @IsOptional() @IsString() category?: string
  @IsOptional() @IsString() image?: string
  @IsOptional() @IsString() tone?: string
  @IsOptional() @IsInt() @Min(0) sortOrder?: number
  @IsOptional() @IsBoolean() isActive?: boolean
}
