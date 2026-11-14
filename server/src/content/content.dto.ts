import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator'

export class PromoDto {
  @IsOptional() @IsString() blockId?: string
  @IsOptional() @IsIn(['desktop', 'tablet', 'mobile']) device?: string
  @IsString() kicker!: string
  @IsString() title!: string
  @IsString() body!: string
  @IsString() ctaLabel!: string
  @IsString() category!: string
  @IsString() image!: string
  @IsOptional() @IsString() imageTablet?: string
  @IsOptional() @IsString() imageMobile?: string
  @IsOptional() @IsString() tone?: string
  @IsOptional() @IsInt() @Min(0) sortOrder?: number
  @IsOptional() @IsBoolean() isActive?: boolean
}

export class UpdatePromoDto {
  @IsOptional() @IsString() blockId?: string
  @IsOptional() @IsIn(['desktop', 'tablet', 'mobile']) device?: string
  @IsOptional() @IsString() kicker?: string
  @IsOptional() @IsString() title?: string
  @IsOptional() @IsString() body?: string
  @IsOptional() @IsString() ctaLabel?: string
  @IsOptional() @IsString() category?: string
  @IsOptional() @IsString() image?: string
  @IsOptional() @IsString() imageTablet?: string
  @IsOptional() @IsString() imageMobile?: string
  @IsOptional() @IsString() tone?: string
  @IsOptional() @IsInt() @Min(0) sortOrder?: number
  @IsOptional() @IsBoolean() isActive?: boolean
}

export class StorefrontLayoutDto {
  @IsObject() layout!: Record<string, unknown>
}
