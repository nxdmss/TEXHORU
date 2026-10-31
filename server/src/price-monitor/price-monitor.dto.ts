import { Type } from 'class-transformer'
import { IsArray, ArrayMaxSize, IsBoolean, IsInt, IsOptional, IsUrl, Max, Min, IsString, MaxLength, ValidateNested, IsISO8601, ArrayMinSize } from 'class-validator'

export class IdentityDto {
  @IsOptional() @IsString() @MaxLength(100) brand?: string
  @IsOptional() @IsString() @MaxLength(100) model?: string
  @IsOptional() @IsString() @MaxLength(30) storage?: string
  @IsOptional() @IsString() @MaxLength(30) ram?: string
  @IsOptional() @IsString() @MaxLength(100) color?: string
  @IsOptional() @IsString() @MaxLength(100) sim?: string
  @IsOptional() @IsString() @MaxLength(30) gtin?: string
  @IsOptional() @IsString() @MaxLength(100) mpn?: string
  @IsOptional() @IsString() @MaxLength(100) condition?: string
}
export class CheckCompetitorPriceDto {
  @IsUrl({ protocols: ['https'], require_protocol: true }) url!: string
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) productId?: number
}
export class ImportFiveRuCatalogDto {
  @IsUrl({ protocols: ['https'], require_protocol: true }) url!: string
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(24) limit?: number
}
export class ScanFiveRuDto {
  @IsUrl({ protocols: ['https'], require_protocol: true }) url!: string
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) maxPages?: number
}
export class AutoFindOneCSectionDto {
  // Empty string means all imported 1C products; otherwise an exact category
  // hierarchy path, including every nested subcategory.
  @IsOptional() @IsString() @MaxLength(600) categoryPath?: string
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5000) maxItems?: number
  @IsOptional() @IsBoolean() indexCatalog?: boolean
  @IsOptional() @IsBoolean() onlyInStockSmartphones?: boolean
  @IsOptional() @IsBoolean() onlyUnlinked?: boolean
}

// Site-only manual price update, guarded by current values and explicit risk acknowledgements.
export class ApplyRecommendedPriceDto {
  @Type(() => Number) @IsInt() @Min(0) expectedCurrentPrice!: number
  @Type(() => Number) @IsInt() @Min(1) expectedCompetitorPrice!: number
  @Type(() => Number) @IsInt() @Min(1) targetPrice!: number
  @IsBoolean() acceptUnknownCost!: boolean
  @IsBoolean() acceptLargeChange!: boolean
}
export class MatchProductDto {
  @Type(() => Number) @IsInt() @Min(1) productId!: number
}
export class MonitorSettingsDto {
  @IsUrl({ protocols: ['https'], require_protocol: true }) catalogUrl!: string
  @Type(() => Number) @IsInt() @Min(0) @Max(10080) intervalMinutes!: number
}
export class MonitorReceiptDto {
  @IsString() @MaxLength(100) id!: string
  @IsOptional() @IsString() @MaxLength(2000) error?: string
}
export class MonitorReceiptsDto {
  @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => MonitorReceiptDto) items!: MonitorReceiptDto[]
}

/** Manually supplied observations; never presented as verified website prices. */
export class ManualCompetitorPriceRowDto {
  @IsUrl({ protocols: ['https'], require_protocol: true }) url!: string
  @IsString() @MaxLength(300) name!: string
  @Type(() => Number) @IsInt() @Min(1) @Max(5000000) price!: number
  @IsISO8601({ strict: true }) observedAt!: string
  @IsOptional() @IsString() @MaxLength(100) oneCId?: string
  @IsOptional() @IsBoolean() inStock?: boolean
}
export class ImportManualCompetitorPricesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500)
  @ValidateNested({ each: true }) @Type(() => ManualCompetitorPriceRowDto)
  rows!: ManualCompetitorPriceRowDto[]
}

/** Category scope and preview token make a bulk change an explicit, reviewable action. */
export class BulkPriceScopeDto {
  @IsOptional() @IsString() @MaxLength(300) categoryPath?: string
}
export class BulkApplyPricesDto extends BulkPriceScopeDto {
  @IsString() @MaxLength(64) token!: string
  @IsBoolean() acceptUnknownCost!: boolean
  @IsBoolean() acceptLargeChange!: boolean
}
