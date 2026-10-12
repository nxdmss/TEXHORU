import { Body, Controller, Get, Param, Post } from '@nestjs/common'
import { CompleteMockPaymentDto, CreatePaymentSessionDto } from './payments.dto'
import { PaymentsService } from './payments.service'

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('status') status() { return this.payments.getStatus() }
  @Post('session') session(@Body() dto: CreatePaymentSessionDto) { return this.payments.createSession(dto.trackingToken) }
  @Post('mock/:paymentId/complete') completeMock(@Param('paymentId') paymentId: string, @Body() dto: CompleteMockPaymentDto) {
    return this.payments.completeMock(paymentId, dto.trackingToken)
  }
}
