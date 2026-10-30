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
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { EXCHANGE_RATE_SETTINGS_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { PaymentBaseRetries } from '../application/payment-base-retries';
import type { PaymentBaseBacklog } from '../domain/ports/payment-base-retry-repository.port';
import {
  PaymentRateBacklogDayDto,
  PaymentRateBacklogDayQueryDto,
  PaymentRateBacklogDto,
} from './dto/payment-rate-backlog.dto';

export const PAYMENT_RATE_BACKLOG_FORBIDDEN_MESSAGE =
  'Solo un administrador puede ver los abonos sin tasa de la clínica.';

/**
 * DX-380: el aviso de abonos sin tasa de más de 24 h. Solo ADMIN, como la
 * tasa de cambio a la que lleva (Ajustes › Tasa de cambio): es quien puede
 * registrar la tasa o cambiar la fuente. Igual en todas las sedes.
 */
@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...EXCHANGE_RATE_SETTINGS_ROLES)
@RolesDeniedMessage(PAYMENT_RATE_BACKLOG_FORBIDDEN_MESSAGE)
@ApiForbiddenResponse({ description: PAYMENT_RATE_BACKLOG_FORBIDDEN_MESSAGE })
@Controller('payments/rate-backlog')
export class PaymentRateBacklogController {
  constructor(private readonly retries: PaymentBaseRetries) {}

  @Get()
  @ApiOperation({
    summary: 'Abonos sin tasa desde hace más de 24 h (DX-380, solo ADMIN)',
    description:
      'Abonos vivos de la clínica que siguen sin base de imputación o sin su ' +
      'tasa congelada pasadas 24 h: el barrido los reintenta con backoff (1 ' +
      'min, 5, 30, 2 h, 24 h). Registrar la tasa del día en Ajustes › Tasa de ' +
      'cambio, corregirla o cambiar la fuente adelanta el reintento al ' +
      'barrido siguiente. Sin datos del abono ni del paciente.',
  })
  @ApiOkResponse({ type: PaymentRateBacklogDto })
  backlog(): Promise<PaymentBaseBacklog> {
    return this.retries.backlog();
  }

  @Get('day')
  @ApiOperation({
    summary:
      'Abonos sin tasa de un día que necesitan la tasa de una moneda (DX-402, solo ADMIN)',
    description:
      'Para el aviso del formulario de tasa manual. Con la fuente MANUAL, la ' +
      'tasa manual de un día anterior a `manualSince` es la tasa de respaldo ' +
      'de los abonos pendientes de ese día (sin tasa congelada) si el ' +
      'proveedor no tiene tasa guardada de él: el barrido siguiente la ' +
      'congela, crea la base y lo deja en la auditoría (EXCHANGE_RATE_BACKUP). ' +
      'Nunca cambia una tasa ya congelada. Solo el recuento.',
  })
  @ApiOkResponse({ type: PaymentRateBacklogDayDto })
  @ApiBadRequestResponse({
    description:
      'Día que no existe o moneda que no es un código de tres letras',
  })
  async day(
    @Query() query: PaymentRateBacklogDayQueryDto,
  ): Promise<PaymentRateBacklogDayDto> {
    const pending = await this.retries.pendingOnDay(query.date, query.currency);
    return { date: query.date, currency: query.currency, ...pending };
  }
}
