import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

/** One deliberately selected batch of up to ten demo SKUs, identified by 1C GUID. */
export class PriceSyncScopeDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ArrayUnique()
  @IsString({ each: true }) @MaxLength(100, { each: true })
  oneCIds!: string[]
}

export class PriceSyncReceiptDto {
  @IsString() @MaxLength(100) id!: string
  @IsOptional() @IsString() @MaxLength(1000) error?: string
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) appliedPrice?: number
}

export class PriceSyncReceiptsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10)
  @ValidateNested({ each: true }) @Type(() => PriceSyncReceiptDto)
  items!: PriceSyncReceiptDto[]
}
