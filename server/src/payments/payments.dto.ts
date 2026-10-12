import { IsString, MinLength } from 'class-validator'

export class CreatePaymentSessionDto {
  @IsString() @MinLength(8) trackingToken!: string
}

export class CompleteMockPaymentDto {
  @IsString() @MinLength(8) trackingToken!: string
}
