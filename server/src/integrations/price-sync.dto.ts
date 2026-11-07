import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsIn, Max, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

/** One explicitly approved group of up to thirty demo SKUs, identified by immutable 1C GUID. */
export class PriceSyncScopeDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ArrayUnique()
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

/** Agent activity only; this never acknowledges a price change. */
export class OneCAgentHeartbeatDto {
  @IsIn(['idle', 'processing', 'error']) state!: 'idle' | 'processing' | 'error'
  @IsOptional() @IsInt() @Min(0) @Max(30) applied?: number
  @IsOptional() @IsInt() @Min(0) @Max(30) failed?: number
}
