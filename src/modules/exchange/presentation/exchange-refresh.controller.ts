import {
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ExtraPermission } from '@prisma/client';
import { AllowPermissions } from '../../auth/presentation/guards/permissions.decorator';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { EXCHANGE_RATE_REFRESH_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { ExchangeHeader } from '../application/use-cases/get-exchange-header.use-case';
import {
  EXCHANGE_REFRESH_MANUAL_MESSAGE,
  ExchangeRefreshTooSoonError,
  RefreshExchangeRateUseCase,
} from '../application/use-cases/refresh-exchange-rate.use-case';
import { ExchangeHeaderDto } from './dto/exchange-header.dto';
import { withProviderErrors } from './exchange-provider-errors';

/**
 * DX-586: «Actualizar tasa» del indicador del menú. Quien cobra (ADMIN y
 * RECEPTION, como registrar abonos), una vez cada 5 min por clínica (en la
 * BD, para todas las réplicas) además del límite global de peticiones.
 */
@ApiTags('exchange')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...EXCHANGE_RATE_REFRESH_ROLES)
@Controller('exchange')
export class ExchangeRefreshController {
  constructor(
    private readonly refresh: RefreshExchangeRateUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  // Como registrar abonos: también quien tiene el permiso extra de cobrar.
  @AllowPermissions(ExtraPermission.PAYMENT_REGISTER)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Vuelve a consultar la tasa de hoy ya (DX-586)',
    description:
      'Con fuente BCV, consulta el BCV en el acto (página oficial → ' +
      'respaldo), con la misma cordura que el trabajo programado y su ' +
      'arranque en frío. Con AUTOMATIC, vuelve a pedir al proveedor las ' +
      'tasas de hoy en la sede aunque estén en caché (gasta del presupuesto ' +
      'de la clínica, SEC-054). Con MANUAL, 409 ' +
      '`EXCHANGE_RATE_REFRESH_MANUAL`. Una vez cada 5 minutos por clínica: ' +
      'antes, 429 `EXCHANGE_RATE_REFRESH_TOO_SOON` con «Vuelve a intentarlo ' +
      'en N min», `retryAfterSeconds` y `Retry-After`. El turno se gasta ' +
      'aunque la consulta falle. Tras consultar, los abonos sin tasa se ' +
      'reintentan ya y queda el evento CLINIC_SETTINGS con reason ' +
      'EXCHANGE_RATE_REFRESH. Devuelve el mismo cuerpo que GET ' +
      '/exchange/header, ya recalculado.',
  })
  @ApiOkResponse({ type: ExchangeHeaderDto })
  @ApiConflictResponse({ description: EXCHANGE_REFRESH_MANUAL_MESSAGE })
  @ApiTooManyRequestsResponse({
    description:
      '`EXCHANGE_RATE_REFRESH_TOO_SOON` (una vez cada 5 min por clínica), `EXCHANGE_RATE_BUDGET_EXCEEDED` (AUTOMATIC: presupuesto del proveedor agotado) o el límite global de peticiones. Retry-After en segundos.',
  })
  @ApiServiceUnavailableResponse({
    description:
      '`EXCHANGE_RATE_UNAVAILABLE`: ni el BCV ni su respaldo (o el proveedor) dieron la tasa; `EXCHANGE_RATE_BCV_REJECTED`: la tasa leída no pasó la cordura.',
  })
  @ApiForbiddenResponse({ description: 'Rol que no cobra' })
  async refreshRates(
    @Req() req: AuditableRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ExchangeHeader> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    try {
      return await withProviderErrors(res, () => this.refresh.execute(ctx));
    } catch (error) {
      if (error instanceof ExchangeRefreshTooSoonError) {
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
        throw new HttpException(error.response(), HttpStatus.TOO_MANY_REQUESTS);
      }
      throw error;
    }
  }
}
