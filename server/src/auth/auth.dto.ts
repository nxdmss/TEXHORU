import { IsEmail, IsString, MinLength, MaxLength, IsOptional, Matches } from 'class-validator'

export class EmailDto {
  @IsEmail() @MaxLength(254) email!: string
}
export class LoginDto extends EmailDto {
  @IsString() @MinLength(8) @MaxLength(128) password!: string
}
export class RegisterDto extends LoginDto {
  @IsString() @MinLength(2) @MaxLength(80) name!: string
}
export class TokenDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/) token!: string
}
export class ResetPasswordDto extends TokenDto {
  @IsString() @MinLength(10) @MaxLength(128) password!: string
}
export class UpdateProfileDto {
  @IsString() @MinLength(2) @MaxLength(80) name!: string
  @IsOptional() @IsString() @Matches(/^$|^\+?[\d ()-]{7,25}$/) phone?: string
  @IsOptional() @IsString() @MaxLength(500) deliveryAddress?: string
}
