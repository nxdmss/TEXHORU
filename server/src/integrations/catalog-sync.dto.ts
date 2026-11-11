import { IsIn, IsInt, IsString, IsUUID, MaxLength, Min } from 'class-validator'
import { OneCCatalogDto } from './integrations.dto'
export class StartCatalogSyncDto {
  @IsUUID() sessionId!: string
  @IsString() @MaxLength(100) clientId!: string
  @IsIn(['FULL', 'DELTA']) mode!: string
}
export class CatalogSyncBatchDto extends OneCCatalogDto {
  @IsInt() @Min(0) batch!: number
}
