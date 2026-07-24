import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  GetRatesForDateUseCase,
  RatesForDate,
} from '../application/use-cases/get-rates-for-date.use-case';
import {
  ConvertAmountUseCase,
  ConvertAmountResult,
} from '../application/use-cases/convert-amount.use-case';
import { GetRatesQueryDto } from './dto/get-rates-query.dto';
import { ConvertQueryDto } from './dto/convert-query.dto';
import { RatesResponseDto } from './dto/rates-response.dto';
import { ConvertResponseDto } from './dto/convert-response.dto';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';

// Exchange rates are global reference/market data, NOT tenant domain data
// (see exchange-rate-repository.port.ts) — this controller deliberately
// requires ONLY JwtAuthGuard (any authenticated user, any tenant). Unlike
// PatientsController/StaffController it does NOT apply RolesGuard/@Roles nor
// TenantContextInterceptor: there is no tenant to scope by and no clinic
// role to gate on.
@ApiTags('exchange')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('exchange')
export class ExchangeController {
  constructor(
    private readonly getRatesForDate: GetRatesForDateUseCase,
    private readonly convertAmount: ConvertAmountUseCase,
  ) {}

  @Get('rates')
  @ApiOkResponse({ type: RatesResponseDto })
  rates(@Query() query: GetRatesQueryDto): Promise<RatesForDate> {
    return this.getRatesForDate.execute(query.date);
  }

  @Get('convert')
  @ApiOkResponse({ type: ConvertResponseDto })
  convert(@Query() query: ConvertQueryDto): Promise<ConvertAmountResult> {
    return this.convertAmount.execute({
      amount: query.amount,
      from: query.from,
      to: query.to,
      date: query.date,
    });
  }
}
