import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator'

export class UpdateIntegrationPolicyDto {
  @IsOptional() @IsIn(['READ_ONLY', 'APPROVAL_REQUIRED', 'ENABLED']) mode?: string
  @IsOptional() @IsBoolean() requireSignedRequests?: boolean
  @IsOptional() @IsBoolean() allowCatalogRead?: boolean
  @IsOptional() @IsBoolean() allowOrderWrites?: boolean
  @IsOptional() @IsBoolean() allowPriceWrites?: boolean
  @IsOptional() @IsBoolean() allowOrderStatusRead?: boolean
  @IsOptional() @IsString() @MaxLength(64) confirmation?: string
}

export class IntegrationCommandActionDto {
  @IsIn(['approve', 'cancel', 'retry']) action!: 'approve' | 'cancel' | 'retry'
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}
