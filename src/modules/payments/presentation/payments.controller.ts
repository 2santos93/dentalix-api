import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  CURRENCY_DIGITS_CATALOG,
  type CurrencyDigitsCatalog,
} from '../../../shared/money/currency-digits';
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
  ApiProduces,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { VoidPaymentDto } from './dto/void-payment.dto';
import { PaymentDto } from './dto/payment.dto';
import { PlanBalanceWithItemsDto } from './dto/plan-balance.dto';
import {
  ExportCashPaymentsQueryDto,
  ListCashPaymentsQueryDto,
} from './dto/list-cash-payments-query.dto';
import { toCashPaymentsCsv } from '../application/cash-payments-csv';
import { CSV_RESPONSE, sendCsv } from '../../../shared/csv/csv-response';
import { CashPaymentsResponseDto } from './dto/cash-payments-response.dto';
import { RecordPaymentUseCase } from '../application/use-cases/record-payment.use-case';
import { RecordOpeningBalancePaymentUseCase } from '../application/use-cases/record-opening-balance-payment.use-case';
import {
  RecordSplitPaymentUseCase,
  type SplitPaymentResult,
} from '../application/use-cases/record-split-payment.use-case';
import {
  RecordSplitPaymentDto,
  SplitPaymentDto,
} from './dto/record-split-payment.dto';
import { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import { OPENING_BALANCE_NOT_FOUND_MESSAGE } from '../domain/opening-balance-payment';
import { ListPaymentsUseCase } from '../application/use-cases/list-payments.use-case';
import { VoidPaymentUseCase } from '../application/use-cases/void-payment.use-case';
import {
  GetPlanBalanceUseCase,
  GetPlanBalanceWithItemsResult,
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
    // DX-390: el cobro dividido.
    private readonly recordSplitPayment: RecordSplitPaymentUseCase,
    // DX-390: el VOID de las otras líneas de un cobro dividido.
    private readonly audit: RecordAuditEventUseCase,
    // DX-340: decimales de cada moneda (currencies.rounding_digits).
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly currencyDigits: CurrencyDigitsCatalog,
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
      'desconocido, medio de pago de otra clínica o sede ajena a la clínica',
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
        paymentMethodId: query.paymentMethodId,
        page: query.page,
        pageSize: query.pageSize,
      },
      // `canVoid` de cada fila se calcula para quien consulta (del token).
      { userId: req.user.sub, role: req.user.role },
    );
  }

  /**
   * DX-395: la caja en CSV, con medio y referencia. Mismos roles, sede y
   * filtros que `GET /payments`, sin paginar. La descarga queda auditada.
   */
  @Audit({ action: 'EXPORT', resource: 'PAYMENT' })
  @Get('payments.csv')
  @ApiOperation({
    summary: 'Caja en CSV: abonos del período con medio y referencia',
    description:
      'Mismos filtros que `GET /payments` (período, método y medio) y la ' +
      'misma sede (`X-Location-Id`), sin paginar: hasta 10 000 abonos. UTF-8 ' +
      'con BOM y CRLF; celdas protegidas contra fórmulas; importes con los ' +
      'decimales de su moneda. Columnas: Fecha, Sede, Paciente, Destino, ' +
      'Medio, Referencia, Moneda, Importe.',
  })
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description: 'Sede activa. Sin cabecera: todas las sedes de la clínica.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV_RESPONSE)
  @ApiBadRequestResponse({
    description:
      'Período no válido, medio de otra clínica o más de 10 000 abonos',
  })
  @ApiForbiddenResponse({ description: 'Rol sin acceso a pagos' })
  async listCashCsv(
    @Query() query: ExportCashPaymentsQueryDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { items, from, to } = await this.listCashPayments.exportAll(
      {
        from: query.from,
        to: query.to,
        method: query.method,
        paymentMethodId: query.paymentMethodId,
      },
      { userId: req.user.sub, role: req.user.role },
    );
    sendCsv(res, `caja-${from}-${to}.csv`);
    return toCashPaymentsCsv(
      items,
      await this.currencyDigits.table(items.map((i) => i.currency)),
    );
  }

  @Audit({
    action: 'CREATE',
    resource: 'PAYMENT',
    resourceId: { response: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
    // DX-136: el recibo numerado nace con el abono (misma transacción).
    reason: 'RECEIPT_ISSUED',
    paymentReference: true,
  })
  @Post('treatment-plans/:id/payments')
  @ApiCreatedResponse({
    type: PaymentDto,
    description:
      'Abono registrado, con su recibo de caja numerado (`receiptNumber`, DX-136). Repetir la MISMA petición (mismo plan y cuerpo) con la misma Idempotency-Key devuelve el abono original.',
  })
  @ApiConflictResponse({
    description:
      'El plan está rechazado o cancelado: no admite abonos (DX-109). Un plan completado sí. ' +
      'DX-377: `code: PAYMENT_REFERENCE_DUPLICATE` si la referencia y el medio ya están en otro ' +
      'abono vivo de ±90 días (`matches`); se confirma repitiendo con `duplicateReferenceReason`.',
  })
  @ApiBadRequestResponse({
    description:
      'DX-377: el medio pide referencia y no llegó, o el medio no es de la clínica o está desactivado. ' +
      'DX-054: `paidAt` a más de 24 h en el futuro («La fecha del abono no puede estar más de 24 horas en el futuro.»).',
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
        paymentMethodId: dto.paymentMethodId,
        reference: dto.reference,
        duplicateReferenceReason: dto.duplicateReferenceReason,
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
    patient: { lookup: 'treatmentPlan', param: 'id' },
    // DX-390: un evento por línea (su abono y su referencia repetida).
    reason: 'SPLIT_RECEIPT_ISSUED',
    paymentReference: true,
    splitPayment: true,
  })
  @Post('treatment-plans/:id/split-payments')
  @ApiOperation({
    summary:
      'Cobro dividido en varias formas de pago con un solo recibo (DX-390)',
    description:
      'De 2 a 5 líneas (medio, moneda, importe y referencia), el mismo día. ' +
      'Cada línea es un abono con las reglas de siempre: su medio (referencia ' +
      'obligatoria y aviso de repetida, DX-377), su moneda (tasa congelada del ' +
      'día, DX-375) y su caja (el efectivo entra en la caja abierta de quien ' +
      'cobra, en su moneda, DX-027). Todas se registran en UNA transacción, ' +
      'con UN recibo numerado que lleva todas las líneas y el total en la ' +
      'moneda del plan: si una línea falla, no queda ninguna. Una ' +
      'Idempotency-Key para el cobro entero. Para un solo medio, ' +
      '`POST /treatment-plans/:id/payments`. Anular una línea ' +
      '(`DELETE /payments/:id`) anula el cobro entero y su recibo.',
  })
  @ApiCreatedResponse({
    type: SplitPaymentDto,
    description:
      'El cobro, con su recibo y un abono por línea. Repetir la MISMA petición con la misma Idempotency-Key devuelve el cobro original.',
  })
  @ApiConflictResponse({
    description:
      'Plan rechazado o cancelado (DX-109). `code: PAYMENT_REFERENCE_DUPLICATE` con `line` (desde 0) ' +
      'si la referencia de una línea ya está en otro abono vivo de ±90 días: se confirma con su ' +
      '`duplicateReferenceReason`. `code: SPLIT_PAYMENT_EXCEEDS_BALANCE` (con `total`, `pending` —nunca bajo 0—, ' +
      '`excess` —lo que este cobro supera lo pendiente— y `currency`, la del plan) si el total supera lo pendiente: ' +
      'se confirma con `confirmCreditBalance`. ' +
      '`code: SPLIT_PAYMENT_BALANCE_CHANGED` si, sin esa confirmación, otro abono entró al plan mientras ' +
      'se registraba el cobro: no se registra nada y se repite la petición (misma clave). ' +
      'Sin caja abierta, si la clínica la exige para el efectivo (DX-027).',
  })
  @ApiBadRequestResponse({
    description:
      'Menos de 2 o más de 5 líneas, una línea sin medio, un medio de otra clínica o desactivado, ' +
      'una referencia que falta, o dos líneas con el mismo medio y referencia. ' +
      'DX-054: `paidAt` a más de 24 h en el futuro.',
  })
  @ApiNotFoundResponse({
    description: 'El plan no existe o es de otra clínica',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'La Idempotency-Key ya se usó con otro plan, otro cuerpo o un abono suelto: genera una clave nueva.',
  })
  async createSplit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordSplitPaymentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<SplitPaymentResult> {
    const split = await this.recordSplitPayment.execute(
      id,
      {
        paidAt: dto.paidAt,
        notes: dto.notes,
        confirmCreditBalance: dto.confirmCreditBalance,
        lines: dto.lines.map((line) => ({
          amount: line.amount,
          currency: line.currency,
          paymentMethodId: line.paymentMethodId,
          reference: line.reference,
          duplicateReferenceReason: line.duplicateReferenceReason,
        })),
      },
      req.user.sub,
      idempotencyKey,
    );
    // DX-150: como un abono suelto, el cobro puede cumplir el compromiso.
    const context = auditRequestContext(req, this.tenantContext);
    const [head] = split.payments;
    if (context && head) {
      await this.settlePromises.afterPayment(head.patientId, context);
    }
    return split;
  }

  @Audit({
    action: 'CREATE',
    resource: 'PAYMENT',
    resourceId: { response: 'id' },
    patient: { lookup: 'openingBalance', param: 'id' },
    reason: 'RECEIPT_ISSUED',
    paymentReference: true,
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
      'Otra moneda que la del saldo, o el abono supera lo pendiente (mensaje en español). ' +
      'DX-054: `paidAt` a más de 24 h en el futuro.',
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
        paymentMethodId: dto.paymentMethodId,
        reference: dto.reference,
        duplicateReferenceReason: dto.duplicateReferenceReason,
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
    type: PlanBalanceWithItemsDto,
    description:
      'Saldo del plan. Un plan rechazado o cancelado tiene `billable` 0 (misma regla que el estado de cuenta, DX-109); sus abonos siguen en `paid`. Añade, por ítem, lo cobrado y lo pendiente (DX-051), y en el plan lo imputado y lo sin imputar. Solo ADMIN y recepción.',
  })
  balance(@Param('id') id: string): Promise<GetPlanBalanceWithItemsResult> {
    return this.getPlanBalance.executeWithItems(id);
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
  @ApiConflictResponse({
    description:
      'DX-253: el abono (o una línea de su cobro dividido) es referencia de ' +
      'una devolución de saldo a favor, o del plan ya se traspasó o devolvió ' +
      'saldo a favor y sin este abono quedaría al descubierto',
  })
  async remove(
    @Param('id') id: string,
    @Body() dto: VoidPaymentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    // DX-215: la sede, el request id, la IP y el user agent van al evento del
    // compromiso de pago que se reabre al anular el abono que lo cumplía.
    const context = auditRequestContext(req, this.tenantContext);
    const otherLines = await this.voidPayment.execute({
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
    // DX-390: las otras líneas de su cobro dividido se anularon con él; cada
    // una deja su evento (el de la pedida lo escribe `@Audit`).
    if (!context) return;
    for (const lineId of otherLines) {
      await this.audit.record({
        tenantId: context.tenantId,
        locationId: context.locationId,
        actor: {
          kind: 'user',
          userId: context.actor.userId,
          role: context.actor.role,
        },
        action: 'VOID',
        resourceType: 'PAYMENT',
        resourceId: lineId,
        patient: { kind: 'payment', id: lineId },
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'SPLIT_PAYMENT_VOIDED' },
      });
    }
  }
}
