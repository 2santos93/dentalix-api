import {
  Body,
  Controller,
  Headers,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { EXPENSE_CAPTURE_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import type { ExpenseDetailView } from '../application/expense-view';
import { CreateCashOutflowUseCase } from '../application/use-cases/create-cash-outflow.use-case';
import { CreateCashOutflowDto } from './dto/expense-requests.dto';
import { ExpenseDetailDto } from './dto/expense.dto';
import type { IdempotencySignals } from '../application/idempotency-guard';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
  /** La repetición de una petición idempotente no escribe: no se audita. */
  skipAudit?: boolean;
}

// Salida de caja menor (DX-274, R8): la registra quien tiene la caja abierta
// (ADMIN o recepción), siempre desde SU caja. Vive en el módulo de gastos
// (crea un gasto con su pago) bajo la ruta de la caja; la caja no importa
// este módulo.
@ApiTags('cash-sessions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...EXPENSE_CAPTURE_ROLES)
@Controller('cash-sessions/current/outflows')
export class CashOutflowsController {
  constructor(private readonly createOutflow: CreateCashOutflowUseCase) {}

  @Audit({
    action: 'CREATE',
    resource: 'EXPENSE',
    resourceId: { response: 'id' },
    reason: 'CASH_OUTFLOW',
  })
  @Post()
  @ApiOperation({
    summary: 'Registrar una salida de caja menor desde mi caja abierta',
    description:
      'Crea un gasto de la sede de la caja abierta de quien llama (con `X-Location-Id`, la de esa sede), con fecha de hoy, pagado en efectivo desde esa caja en la misma transacción: resta del efectivo esperado. La respuesta es el gasto, sin datos del esperado de la caja.',
  })
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description:
      'Sede de la caja. Sin ella, la única sede donde quien llama tiene caja abierta.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'UUID. Repetir la MISMA petición con la misma clave devuelve la salida original; con otro cuerpo, 422.',
  })
  @ApiCreatedResponse({ type: ExpenseDetailDto })
  @ApiBadRequestResponse({
    description: 'Importe, categoría, moneda o soporte no válidos',
  })
  @ApiConflictResponse({
    description:
      'Sin caja abierta (en esa sede); con cajas abiertas en varias sedes sin elegir una; o la Idempotency-Key ya se usó para un gasto de otra sede',
  })
  @ApiUnprocessableEntityResponse({
    description: 'La Idempotency-Key ya se usó con otros datos',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN y recepción' })
  async create(
    @Body() dto: CreateCashOutflowDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<ExpenseDetailView> {
    const signals: IdempotencySignals = {};
    const created = await this.createOutflow.execute(
      dto,
      req.user.sub,
      idempotencyKey,
      signals,
    );
    if (signals.replayed) req.skipAudit = true;
    return created;
  }
}
