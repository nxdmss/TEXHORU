import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import { OneCCatalogDto } from './integrations.dto'
export class RemoteJobDto {
  @IsIn(['GROUPS', 'INDEX', 'IMPORT']) kind!: string
  @IsOptional() @IsUUID() groupId?: string
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) itemIds?: string[]
  @IsOptional() @IsBoolean() stockOnly?: boolean
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
export class RemoteIndexItemDto {
  @IsUUID() oneCId!: string
  @IsString() @MaxLength(100) parentId!: string
  @IsString() @MaxLength(50) code!: string
  @IsString() @MaxLength(200) article!: string
  @IsString() @MaxLength(500) name!: string
  @IsBoolean() deletionMark!: boolean
}
export class RemoteBatchDto extends OneCCatalogDto {
  @IsUUID() leaseToken!: string
  @IsInt() @Min(0) batch!: number
  @IsString() @MaxLength(100) cursor!: string
  @IsInt() @Min(0) @Max(200) scanned!: number
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RemoteGroupDto) groups!: RemoteGroupDto[]
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => RemoteHashDto) hashes!: RemoteHashDto[]
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => RemoteIndexItemDto) indexItems?: RemoteIndexItemDto[]
}
export class RemoteLeaseDto { @IsUUID() leaseToken!: string }
export class RemoteActionDto { @IsIn(['pause', 'resume', 'cancel', 'retry']) action!: string }
