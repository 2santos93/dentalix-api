import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { VoidPaymentDto } from './dto/void-payment.dto';
import { PaymentDto } from './dto/payment.dto';
import { PlanBalanceDto } from './dto/plan-balance.dto';
import { ListCashPaymentsQueryDto } from './dto/list-cash-payments-query.dto';
import { CashPaymentsResponseDto } from './dto/cash-payments-response.dto';
import { RecordPaymentUseCase } from '../application/use-cases/record-payment.use-case';
import { RecordOpeningBalancePaymentUseCase } from '../application/use-cases/record-opening-balance-payment.use-case';
import { OPENING_BALANCE_NOT_FOUND_MESSAGE } from '../domain/opening-balance-payment';
import { ListPaymentsUseCase } from '../application/use-cases/list-payments.use-case';
import { VoidPaymentUseCase } from '../application/use-cases/void-payment.use-case';
import {
  GetPlanBalanceUseCase,
  GetPlanBalanceResult,
} from '../application/use-cases/get-plan-balance.use-case';
import {
  ListCashPaymentsUseCase,
  ListCashPaymentsOutput,
} from '../application/use-cases/list-cash-payments.use-case';
import { Payment } from '../domain/entities/payment.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { PAYMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { DrainAllocationRebalancesInterceptor } from './drain-allocation-rebalances.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { SettlePaymentPromises } from '../../collections/application/settle-payment-promises';

// RolesGuard (a nivel de clase) ya rechazó cualquier token sin rol de clínica
// (los de plataforma), así que aquí `user` es siempre un token de clínica.
interface AuthenticatedRequest extends AuditableRequest {
  user: TenantJwtPayload;
}

// Pagos/abonos es dato FINANCIERO -> @Roles(...PAYMENT_ROLES) (ADMIN +
// RECEPTION -- mostrador + gestión; DENTIST/ASSISTANT NO, ver
// docs/plans/2026-07-24-payments-pivot.md "Global Constraints"). No
// `@Controller(prefix)` base: routes mix a plan-nested path
// (`treatment-plans/:id/payments`, `.../balance`) with a top-level path keyed
// by payment id (`payments/:id` for void), so each method declares its own
// full path (same rationale as TreatmentPlansController mixing
// `patients/:patientId/treatment-plans` with `treatment-plans/:id[/items]`).
@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
// DX-051: detrás del tenant, en el MISMO decorador (corre en su contexto).
@UseInterceptors(TenantContextInterceptor, DrainAllocationRebalancesInterceptor)
@Roles(...PAYMENT_ROLES)
@Controller()
export class PaymentsController {
  constructor(
    private readonly recordPayment: RecordPaymentUseCase,
    private readonly recordOpeningBalancePayment: RecordOpeningBalancePaymentUseCase,
    private readonly listPayments: ListPaymentsUseCase,
    private readonly voidPayment: VoidPaymentUseCase,
    private readonly getPlanBalance: GetPlanBalanceUseCase,
    private readonly listCashPayments: ListCashPaymentsUseCase,
    // DX-150: el abono que cubre un compromiso de pago lo cierra en el acto.
    private readonly settlePromises: SettlePaymentPromises,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * La CAJA: todos los abonos de la clínica en un período, sin entrar plan por
   * plan. Mismos roles que el resto de pagos (PAYMENT_ROLES, a nivel de clase):
   * es el mismo dato financiero visto de través. La sede la pone
   * `X-Location-Id` (validada por TenantContextInterceptor); sin ella, la vista
   * consolidada de la clínica.
   */
  @Audit({ action: 'VIEW', resource: 'PAYMENT' })
  @Get('payments')
  @ApiOperation({
    summary: 'Caja: abonos del período con resumen por moneda y método',
  })
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description: 'Sede activa. Sin cabecera: todas las sedes de la clínica.',
  })
  @ApiOkResponse({ type: CashPaymentsResponseDto })
  @ApiBadRequestResponse({
    description:
      'Fecha inválida, from > to, período de más de 366 días, método ' +
      'desconocido o sede ajena a la clínica',
  })
  @ApiForbiddenResponse({ description: 'Rol sin acceso a pagos' })
  listCash(
    @Query() query: ListCashPaymentsQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ListCashPaymentsOutput> {
    return this.listCashPayments.execute(
      {
        from: query.from,
        to: query.to,
        method: query.method,
        page: query.page,
        pageSize: query.pageSize,
      },
      // `canVoid` de cada fila se calcula para quien consulta (del token).
      { userId: req.user.sub, role: req.user.role },
    );
  }

  @Audit({
    action: 'CREATE',
    resource: 'PAYMENT',
    resourceId: { response: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
    // DX-136: el recibo numerado nace con el abono (misma transacción).
    reason: 'RECEIPT_ISSUED',
  })
  @Post('treatment-plans/:id/payments')
  @ApiCreatedResponse({
    type: PaymentDto,
    description:
      'Abono registrado, con su recibo de caja numerado (`receiptNumber`, DX-136). Repetir la MISMA petición (mismo plan y cuerpo) con la misma Idempotency-Key devuelve el abono original.',
  })
  @ApiConflictResponse({
    description:
      'El plan está rechazado o cancelado: no admite abonos (DX-109). Un plan completado sí.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'La Idempotency-Key ya se usó con otro plan u otro cuerpo (DX-109): genera una clave nueva.',
  })
  async create(
    @Param('id') id: string,
    @Body() dto: RecordPaymentDto,
    // Idempotency-Key (UUID) dedup header. Optional: absent → today's behavior
    // (no dedup, idempotencyKey stays NULL). Read from the header (never the
    // body), like tenant/createdById. A replay of the same key returns the
    // EXISTING payment instead of creating a second row.
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<Payment> {
    // `createdById` comes from the authenticated user (req.user.sub), never
    // from the client body -- same convention as
    // AppointmentsController.create / TreatmentPlansController.create.
    const payment = await this.recordPayment.execute(
      id,
      {
        amount: dto.amount,
        currency: dto.currency,
        paidAt: dto.paidAt,
        method: dto.method,
        notes: dto.notes,
      },
      req.user.sub,
      idempotencyKey,
    );
    // DX-150: si con este abono se cumple el compromiso abierto del paciente,
    // pasa a KEPT ya (auditado con este usuario). Nunca falla la petición: el
    // abono está confirmado y el barrido horario lo recogería.
    const context = auditRequestContext(req, this.tenantContext);
    if (context) {
      await this.settlePromises.afterPayment(payment.patientId, context);
    }
    return payment;
  }

  @Audit({
    action: 'CREATE',
    resource: 'PAYMENT',
    resourceId: { response: 'id' },
    patient: { lookup: 'openingBalance', param: 'id' },
    reason: 'RECEIPT_ISSUED',
  })
  @Post('opening-balances/:id/payments')
  @ApiOperation({
    summary: 'Abono contra el saldo migrado de un paciente (DX-262)',
    description:
      'Como un abono a un plan (recibo de caja numerado por sede, caja por turno, Idempotency-Key, anulación con DELETE /payments/:id), pero contra el «Saldo migrado» importado. En la moneda del saldo y sin pasar de lo pendiente.',
  })
  @ApiCreatedResponse({ type: PaymentDto })
  @ApiBadRequestResponse({
    description:
      'Otra moneda que la del saldo, o el abono supera lo pendiente (mensaje en español)',
  })
  @ApiNotFoundResponse({ description: OPENING_BALANCE_NOT_FOUND_MESSAGE })
  @ApiUnprocessableEntityResponse({
    description:
      'La Idempotency-Key ya se usó con otro destino u otro cuerpo: genera una clave nueva.',
  })
  async createForOpeningBalance(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordPaymentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<Payment> {
    const payment = await this.recordOpeningBalancePayment.execute(
      id,
      {
        amount: dto.amount,
        currency: dto.currency,
        paidAt: dto.paidAt,
        method: dto.method,
        notes: dto.notes,
      },
      req.user.sub,
      idempotencyKey,
    );
    // DX-150: un abono al saldo migrado también cuenta para el compromiso.
    const context = auditRequestContext(req, this.tenantContext);
    if (context) {
      await this.settlePromises.afterPayment(payment.patientId, context);
    }
    return payment;
  }

  @Audit({
    action: 'VIEW',
    resource: 'PAYMENT',
    patient: { lookup: 'treatmentPlan', param: 'id' },
  })
  @Get('treatment-plans/:id/payments')
  @ApiOkResponse({ type: [PaymentDto] })
  list(@Param('id') id: string): Promise<Payment[]> {
    return this.listPayments.execute(id);
  }

  @Audit({
    action: 'VIEW',
    resource: 'PAYMENT',
    patient: { lookup: 'treatmentPlan', param: 'id' },
  })
  @Get('treatment-plans/:id/balance')
  @ApiOkResponse({
    type: PlanBalanceDto,
    description:
      'Saldo del plan. Un plan rechazado o cancelado tiene `billable` 0 (misma regla que el estado de cuenta, DX-109); sus abonos siguen en `paid`.',
  })
  balance(@Param('id') id: string): Promise<GetPlanBalanceResult> {
    return this.getPlanBalance.execute(id);
  }

  @Audit({
    action: 'VOID',
    resource: 'PAYMENT',
    resourceId: { param: 'id' },
    patient: { lookup: 'payment', param: 'id' },
  })
  @Delete('payments/:id')
  @ApiOperation({
    summary: 'Anular un abono (con motivo; queda quién y cuándo)',
    description:
      'Borrado lógico: el abono deja de sumar pero se conserva con ' +
      '`voidedById`, `voidedAt` y `voidReason`. ADMIN anula cualquier abono; ' +
      'RECEPTION solo los que registró ella misma el mismo día (calendario ' +
      'de la sede del abono). Si el abono contaba para un compromiso de ' +
      'pago cumplido del paciente en su moneda y ya no queda cubierto, el compromiso ' +
      'vuelve a OPEN (o BROKEN si su día ya pasó en la zona de su sede), en ' +
      'la misma transacción y auditado (DX-215).',
  })
  @ApiOkResponse({ description: 'Abono anulado (cuerpo vacío)' })
  @ApiBadRequestResponse({
    description: 'Falta `reason` o no tiene 3–300 caracteres',
  })
  @ApiForbiddenResponse({
    description:
      'Rol sin acceso a pagos, o RECEPTION anulando un abono de otro usuario ' +
      'o de otro día',
  })
  @ApiNotFoundResponse({
    description: 'El abono no existe, ya está anulado o es de otra clínica',
  })
  remove(
    @Param('id') id: string,
    @Body() dto: VoidPaymentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    // DX-215: la sede, el request id, la IP y el user agent van al evento del
    // compromiso de pago que se reabre al anular el abono que lo cumplía.
    const context = auditRequestContext(req, this.tenantContext);
    return this.voidPayment.execute({
      paymentId: id,
      reason: dto.reason,
      actor: { userId: req.user.sub, role: req.user.role },
      request: context && {
        locationId: context.locationId,
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
      },
    });
  }
}
