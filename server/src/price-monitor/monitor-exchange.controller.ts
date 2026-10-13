import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common'
import { IsOptional, IsString, MaxLength } from 'class-validator'
import { OneCGuard } from '../integrations/onec.guard'
import { MonitorExchangeService } from './monitor-exchange.service'
import { MonitorReceiptsDto } from './price-monitor.dto'

class AckMonitorDto {
  @IsOptional() @IsString() @MaxLength(2000) error?: string
}

@Controller('integrations/1c/price-monitor')
@UseGuards(OneCGuard)
export class MonitorExchangeController {
  constructor(private readonly exchange: MonitorExchangeService) {}
  @Get('pending') pending() { return this.exchange.pending() }
  @Post('receipts') async receipts(@Body() dto: MonitorReceiptsDto) {
    const results = []
    for (const item of dto.items) results.push(await this.exchange.ack(item.id, item.error))
    return { ok: true, results }
  }
  @Post(':id/ack') ack(@Param('id') id: string, @Body() dto: AckMonitorDto) { return this.exchange.ack(id, dto.error) }
}
