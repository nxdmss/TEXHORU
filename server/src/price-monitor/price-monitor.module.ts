import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { FiveRuParser } from './five-ru.parser'
import { PriceMonitorController } from './price-monitor.controller'
import { PriceMonitorService } from './price-monitor.service'
import { MonitorExchangeService } from './monitor-exchange.service'
import { MonitorExchangeController } from './monitor-exchange.controller'
import { OneCGuard } from '../integrations/onec.guard'

@Module({
  imports: [AuthModule],
  controllers: [PriceMonitorController, MonitorExchangeController],
  providers: [PriceMonitorService, FiveRuParser, MonitorExchangeService, OneCGuard],
})
export class PriceMonitorModule {}
