import {
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
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
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { withProviderErrors } from './exchange-provider-errors';

const DATE_ERRORS_DESCRIPTION =
  'Fecha que no existe (`EXCHANGE_RATE_DATE_INVALID` o el mensaje de validación de `date`) o día sin tasa guardada fuera de la ventana de la clínica (`EXCHANGE_RATE_DATE_OUT_OF_RANGE`, con `first` y `today`); nunca se llama al proveedor.';
const TOO_MANY_DESCRIPTION =
  'Demasiadas solicitudes (límite `exchange-rates` por clínica + usuario) o `EXCHANGE_RATE_BUDGET_EXCEEDED`: la clínica (o la plataforma) agotó su presupuesto de días sin tasa guardada que se piden al proveedor. La cabecera Retry-After indica los segundos de espera.';
const UNAVAILABLE_DESCRIPTION =
  '`EXCHANGE_RATE_UNAVAILABLE`: el proveedor no dio las tasas del día (o falló hace poco y no se vuelve a pedir durante un rato).';

// DX-374: la tasa de un día depende de la clínica (proveedor o tasa manual),
// así que estas rutas son de clínica: TenantContextInterceptor fija el tenant
// del host y los cuatro roles las leen (todos cobran y ven saldos). Las tasas
// del proveedor siguen siendo datos globales (exchange-rate-repository.port.ts).
// SEC-054: la cuota del proveedor es una para toda la plataforma: estas rutas
// solo le piden días de la ventana de la clínica, a través del presupuesto de
// `ProviderRatesGate` (429 `EXCHANGE_RATE_BUDGET_EXCEEDED`), y con su propio
// límite de peticiones por clínica + usuario (`exchange-rates`).
@ApiTags('exchange')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...EXCHANGE_RATE_READ_ROLES)
@RateLimit('exchange-rates')
@ApiBadRequestResponse({ description: DATE_ERRORS_DESCRIPTION })
@ApiServiceUnavailableResponse({ description: UNAVAILABLE_DESCRIPTION })
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
      'aparece en `rates` y nunca se pide al proveedor. SEC-054: un día sin ' +
      'guardar solo se pide al proveedor dentro de la ventana de la clínica y ' +
      'con su presupuesto de fallos de caché (429 al superarlo).',
  })
  @ApiOkResponse({ type: RatesResponseDto })
  @ApiTooManyRequestsResponse({ description: TOO_MANY_DESCRIPTION })
  rates(
    @Query() query: GetRatesQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RatesForDate> {
    return withProviderErrors(res, () =>
      this.getRatesForDate.forRequest(query.date),
    );
  }

  @Get('convert')
  @ApiOkResponse({ type: ConvertResponseDto })
  @ApiTooManyRequestsResponse({ description: TOO_MANY_DESCRIPTION })
  @ApiBadRequestResponse({
    description: `${DATE_ERRORS_DESCRIPTION} También: moneda sin tasa ese día, «unsupported currency» con el proveedor; con tasa manual, código EXCHANGE_RATE_MISSING y el mensaje en español.`,
  })
  convert(
    @Query() query: ConvertQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConvertAmountResult> {
    return withProviderErrors(res, () =>
      this.convertAmount.forRequest({
        amount: query.amount,
        from: query.from,
        to: query.to,
        date: query.date,
      }),
    );
  }
}
