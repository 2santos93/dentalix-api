import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  PAYMENT_ALLOCATION_WRITE_ROLES,
  PAYMENT_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  GetPaymentAllocationsUseCase,
  type PaymentAllocationsView,
} from '../application/use-cases/get-payment-allocations.use-case';
import {
  ReplacePaymentAllocationsUseCase,
  type ReplacedPaymentAllocations,
} from '../application/use-cases/replace-payment-allocations.use-case';
import { DrainAllocationRebalancesInterceptor } from './drain-allocation-rebalances.interceptor';
import {
  PaymentAllocationsDto,
  ReplacePaymentAllocationsDto,
  ReplacedPaymentAllocationsDto,
} from './dto/payment-allocations.dto';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

const PAYMENT_AUDIT = {
  resourceId: { param: 'id' },
  patient: { lookup: 'payment', param: 'id' },
} as const;

/**
 * Imputación de un abono a los ítems de su plan (DX-051, spec §5.1). Leerla:
 * ADMIN y recepción (PAYMENT_ROLES). Reasignarla: solo ADMIN (R10, §11
 * R-Q6). El `:id` es el del abono; uno anulado, inexistente o de otra clínica
 * responde 404. El PUT reparte el plan antes de responder y el interceptor
 * drena después lo que quede en la cola del tenant.
 */
@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
// DX-051: detrás del tenant, en el MISMO decorador (corre en su contexto).
@UseInterceptors(TenantContextInterceptor, DrainAllocationRebalancesInterceptor)
@Roles(...PAYMENT_ROLES)
@Controller('payments/:id/allocations')
export class PaymentAllocationsController {
  constructor(
    private readonly getAllocations: GetPaymentAllocationsUseCase,
    private readonly replaceAllocations: ReplacePaymentAllocationsUseCase,
  ) {}

  @Audit({ action: 'VIEW', resource: 'PAYMENT', ...PAYMENT_AUDIT })
  @Get()
  @ApiOperation({
    summary: 'A qué ítems del plan va un abono (DX-051)',
    description:
      'Las líneas vivas del abono, los ítems imputables del plan con lo que admite cada uno sin contar este abono, y la `version` que el PUT reenvía.',
  })
  @ApiOkResponse({ type: PaymentAllocationsDto })
  @ApiForbiddenResponse({ description: 'Rol sin acceso a pagos' })
  @ApiNotFoundResponse({
    description: 'El abono no existe, está anulado o es de otra clínica',
  })
  @ApiConflictResponse({ description: 'Abono a un saldo migrado' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentAllocationsView> {
    return this.getAllocations.execute(id);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PAYMENT_ALLOCATION',
    ...PAYMENT_AUDIT,
    reason: 'PAYMENT_REALLOCATED',
    allocation: true,
  })
  @Roles(...PAYMENT_ALLOCATION_WRITE_ROLES)
  @Put()
  @ApiOperation({
    summary: 'Reasignar la imputación de un abono (solo ADMIN, DX-051)',
    description:
      'MANUAL sustituye todas las imputaciones del abono por `allocations` (vacío = todo sin imputar) y lo fija: el reparto automático ya no lo usa. AUTO borra sus imputaciones, lo desfija y lo reparte como un abono más (solo llena lo libre). `expectedVersion` es la `version` leída con GET. La respuesta se lee tras el reparto y trae `previous`.',
  })
  @ApiOkResponse({ type: ReplacedPaymentAllocationsDto })
  @ApiBadRequestResponse({
    description:
      'Líneas inválidas: importe, ítem repetido, más de 200, modo, ítem de otro plan o propuesto, por encima de lo libre o de la base',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN reasigna' })
  @ApiNotFoundResponse({
    description: 'El abono no existe, está anulado o es de otra clínica',
  })
  @ApiConflictResponse({
    description:
      'Saldo migrado, plan rechazado o cancelado, sin tasa para la fecha del abono, o la imputación cambió (expectedVersion)',
  })
  replace(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplacePaymentAllocationsDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ReplacedPaymentAllocations> {
    return this.replaceAllocations.execute(
      id,
      {
        expectedVersion: dto.expectedVersion,
        mode: dto.mode,
        allocations: dto.allocations?.map((l) => ({
          treatmentPlanItemId: l.treatmentPlanItemId,
          amount: l.amount,
        })),
      },
      req.user.sub,
    );
  }
}
