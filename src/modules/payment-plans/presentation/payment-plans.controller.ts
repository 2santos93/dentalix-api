import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
  ApiOkResponse,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  CancelPaymentPlanDto,
  CreatePaymentPlanDto,
} from './dto/create-payment-plan.dto';
import type { LockActor } from '../../financial-lock/domain/financial-lock';
import { PaymentPlanDto } from './dto/payment-plan.dto';
import { CreatePaymentPlanUseCase } from '../application/use-cases/create-payment-plan.use-case';
import {
  GetPaymentPlanUseCase,
  GetPaymentPlanResult,
} from '../application/use-cases/get-payment-plan.use-case';
import { CancelPaymentPlanUseCase } from '../application/use-cases/cancel-payment-plan.use-case';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { PAYMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';

interface AuthenticatedRequest {
  user: JwtPayload;
}

/**
 * DX-091: quién crea o cancela (del token) y su motivo para un período
 * contable cerrado. Un token de plataforma no tiene rol de clínica: nunca
 * salta el cierre.
 */
function lockActorOf(
  req: AuthenticatedRequest,
  overrideReason: string | undefined,
): LockActor | null {
  const user = req.user;
  if (!('role' in user)) return null;
  return {
    userId: user.sub,
    role: user.role,
    overrideReason: overrideReason ?? null,
  };
}

// Financiero -> PAYMENT_ROLES (igual que PaymentsController). Rutas anidadas
// bajo el plan de tratamiento; recurso singular (1 plan de pagos activo).
@ApiTags('payment-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PAYMENT_ROLES)
@Controller()
export class PaymentPlansController {
  constructor(
    private readonly createPaymentPlan: CreatePaymentPlanUseCase,
    private readonly getPaymentPlan: GetPaymentPlanUseCase,
    private readonly cancelPaymentPlan: CancelPaymentPlanUseCase,
  ) {}

  @Audit({
    action: 'CREATE',
    resource: 'PAYMENT_PLAN',
    resourceId: { response: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
  })
  @Post('treatment-plans/:id/payment-plan')
  @ApiCreatedResponse({ type: PaymentPlanDto })
  @ApiConflictResponse({
    description:
      'El plan ya tiene un plan de cuotas activo, o está rechazado o cancelado y no se financia (DX-109). ' +
      'DX-091: `code: PERIOD_LOCKED` si alguna cuota vence en un período contable cerrado.',
  })
  @ApiBadRequestResponse({ description: 'Id que no es UUID' })
  @ApiParam({ name: 'id', format: 'uuid' })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePaymentPlanDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<GetPaymentPlanResult> {
    await this.createPaymentPlan.execute(
      id,
      {
        downPayment: dto.downPayment ?? 0,
        installmentsCount: dto.installmentsCount,
        periodicity: dto.periodicity,
        startDate: dto.startDate,
        totalToFinance: dto.totalToFinance,
        notes: dto.notes,
        lockActor: lockActorOf(req, dto.lockOverrideReason),
      },
      req.user.sub,
    );
    // Return the SAME derived shape as GET (adds paidTotal/balance/isPaidOff
    // etc.) instead of the raw entity, which leaked tenantId/patientId/
    // createdById and lacked the fields @ApiCreatedResponse documents.
    return this.getPaymentPlan.execute(id);
  }

  @Audit({
    action: 'VIEW',
    resource: 'PAYMENT_PLAN',
    patient: { lookup: 'treatmentPlan', param: 'id' },
  })
  @Get('treatment-plans/:id/payment-plan')
  @ApiOkResponse({ type: PaymentPlanDto })
  @ApiBadRequestResponse({ description: 'Id que no es UUID' })
  @ApiParam({ name: 'id', format: 'uuid' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<GetPaymentPlanResult> {
    return this.getPaymentPlan.execute(id);
  }

  @Audit({
    action: 'DELETE',
    resource: 'PAYMENT_PLAN',
    patient: { lookup: 'treatmentPlan', param: 'id' },
  })
  @Delete('treatment-plans/:id/payment-plan')
  @HttpCode(204)
  @ApiOkResponse({ description: 'Payment plan cancelled' })
  @ApiConflictResponse({
    description:
      'DX-091: `code: PERIOD_LOCKED` si el plan tiene cuotas vencidas en un período contable cerrado. ' +
      'El ADMIN lo salta con `lockOverrideReason` si la clínica admite la exención.',
  })
  @ApiBadRequestResponse({ description: 'Id que no es UUID' })
  @ApiParam({ name: 'id', format: 'uuid' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelPaymentPlanDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    return this.cancelPaymentPlan.execute(
      id,
      lockActorOf(req, dto.lockOverrideReason),
    );
  }
}
