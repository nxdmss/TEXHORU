import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import { OneCCatalogDto } from './integrations.dto'
export class RemoteJobDto {
  @IsIn(['GROUPS', 'CATALOG']) kind!: string
  @IsOptional() @IsUUID() groupId?: string
  @IsIn(['FULL', 'DELTA']) mode!: string
}
export class RemotePollDto {
  @IsUUID() agentId!: string
  @IsIn(['idle', 'processing', 'error']) state!: string
  @IsOptional() @IsIn(['COM_CONNECT', 'CATALOG_READ', 'HTTP', 'CONFIG']) error?: string
}
export class RemoteHashDto {
  @IsUUID() oneCId!: string
  @IsString() @Length(64, 64) hash!: string
}
export class RemoteKnownDto {
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => RemoteHashDto) hashes!: RemoteHashDto[]
}
export class RemoteGroupDto {
  @IsUUID() oneCId!: string
  @IsString() @MaxLength(100) parentId!: string
  @IsString() @MaxLength(500) name!: string
  @IsInt() @Min(0) @Max(100000000) itemCount!: number
}
export class RemoteBatchDto extends OneCCatalogDto {
  @IsUUID() leaseToken!: string
  @IsInt() @Min(0) batch!: number
  @IsString() @MaxLength(100) cursor!: string
  @IsInt() @Min(0) @Max(100) scanned!: number
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RemoteGroupDto) groups!: RemoteGroupDto[]
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => RemoteHashDto) hashes!: RemoteHashDto[]
}
export class RemoteLeaseDto { @IsUUID() leaseToken!: string }
export class RemoteActionDto { @IsIn(['pause', 'resume', 'cancel', 'retry']) action!: string }
