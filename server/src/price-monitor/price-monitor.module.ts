import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { FiveRuParser } from './five-ru.parser'
import { PriceMonitorController } from './price-monitor.controller'
import { PriceMonitorService } from './price-monitor.service'

@Module({
  imports: [AuthModule],
  controllers: [PriceMonitorController],
  providers: [PriceMonitorService, FiveRuParser],
})
export class PriceMonitorModule {}
