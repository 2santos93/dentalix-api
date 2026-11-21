import { Controller, Get, UseGuards, UseInterceptors } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { EXCHANGE_RATE_READ_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import {
  GetExchangeHeaderUseCase,
  type ExchangeHeader,
} from '../application/use-cases/get-exchange-header.use-case';
import { ExchangeHeaderDto } from './dto/exchange-header.dto';

/**
 * DX-584: la tasa que enseña el menú. Cualquier miembro (todos cobran), con
 * su propio límite suave por clínica + usuario (`exchange-header`, 60/min):
 * la web la pide al montar, al volver a la pestaña, cada 5 min y al cambiar
 * una tasa o los ajustes.
 */
@ApiTags('exchange')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...EXCHANGE_RATE_READ_ROLES)
@RateLimit('exchange-header')
@Controller('exchange')
export class ExchangeHeaderController {
  constructor(private readonly getHeader: GetExchangeHeaderUseCase) {}

  @Get('header')
  @ApiOperation({
    summary: 'Tasa del día que enseña el menú de la sede activa (DX-584)',
    description:
      'Una fila por moneda aceptada distinta de la de referencia (la de la ' +
      'clínica o, sin ella, la de la sede activa), con «1 {moneda} = N ' +
      '{referencia}» cruzado vía USD con las tasas de hoy en la sede. Las ' +
      'tasas salen como en GET /exchange/rates: la fuente de la clínica ' +
      '(AUTOMATIC, o MANUAL con el plazo de DX-384) y, con AUTOMATIC, la ' +
      'caché y los presupuestos del proveedor (SEC-054). Sin tasa (proveedor ' +
      'caído, presupuesto agotado, MANUAL sin registrar) la fila lleva ' +
      '`perReference: null`; nunca 429/503 por el proveedor. `visible` false ' +
      '(y `rates` vacía, sin leer tasas) con «Nunca», sin sede utilizable, ' +
      'sin moneda de referencia o sin ninguna moneda que enseñar.',
  })
  @ApiOkResponse({ type: ExchangeHeaderDto })
  header(): Promise<ExchangeHeader> {
    return this.getHeader.execute();
  }
}
