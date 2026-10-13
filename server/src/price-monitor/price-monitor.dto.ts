import { Type } from 'class-transformer'
import { IsInt, IsOptional, IsUrl, Max, Min } from 'class-validator'

export class CheckCompetitorPriceDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url!: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  productId?: number
}

export class ImportFiveRuCatalogDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url!: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  limit?: number
}
