import { Type } from 'class-transformer'
import { DeliveryMethod, OrderStatus, PaymentMethod } from '@prisma/client'
import { IsArray, IsEmail, IsEnum, IsInt, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator'

class CreateOrderItemDto {
  @IsInt() productId!: number
  @IsInt() @Min(1) quantity!: number
}

export class CreateOrderDto {
  @IsString() @MinLength(2) customerName!: string
  @IsString() @MinLength(6) customerPhone!: string
  @IsOptional() @IsEmail() customerEmail?: string
  @IsEnum(DeliveryMethod) deliveryMethod!: DeliveryMethod
  @IsString() @MinLength(3) deliveryAddress!: string
  @IsEnum(PaymentMethod) paymentMethod!: PaymentMethod
  @IsOptional() @IsString() comment?: string
  @IsString() @MinLength(8) idempotencyKey!: string
  @IsArray() @ValidateNested({ each: true }) @Type(() => CreateOrderItemDto) items!: CreateOrderItemDto[]
}

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus) status!: OrderStatus
}
