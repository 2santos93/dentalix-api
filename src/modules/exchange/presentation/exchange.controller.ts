import {
  Controller,
  Get,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
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
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { EXCHANGE_RATE_READ_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

// DX-374: la tasa de un día depende de la clínica (proveedor o tasa manual),
// así que estas rutas son de clínica: TenantContextInterceptor fija el tenant
// del host y los cuatro roles las leen (todos cobran y ven saldos). Las tasas
// del proveedor siguen siendo datos globales (exchange-rate-repository.port.ts).
@ApiTags('exchange')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...EXCHANGE_RATE_READ_ROLES)
@Controller('exchange')
export class ExchangeController {
  constructor(
    private readonly getRatesForDate: GetRatesForDateUseCase,
    private readonly convertAmount: ConvertAmountUseCase,
  ) {}

  @Get('rates')
  @ApiOperation({
    summary: 'Tasas de un día para la clínica, según su fuente (DX-374)',
    description:
      'Con fuente AUTOMATIC, las del proveedor (caché diaria). Con MANUAL, solo ' +
      'las que la clínica registró para ese día: una moneda sin tasa NO ' +
      'aparece en `rates` y nunca se pide al proveedor.',
  })
  @ApiOkResponse({ type: RatesResponseDto })
  rates(@Query() query: GetRatesQueryDto): Promise<RatesForDate> {
    return this.getRatesForDate.execute(query.date);
  }

  @Get('convert')
  @ApiOkResponse({ type: ConvertResponseDto })
  @ApiBadRequestResponse({
    description:
      'Moneda sin tasa ese día: «unsupported currency» con el proveedor; con tasa manual, código EXCHANGE_RATE_MISSING y el mensaje en español',
  })
  convert(@Query() query: ConvertQueryDto): Promise<ConvertAmountResult> {
    return this.convertAmount.execute({
      amount: query.amount,
      from: query.from,
      to: query.to,
      date: query.date,
    });
  }
}
