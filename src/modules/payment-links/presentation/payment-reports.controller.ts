import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { PAYMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { SettlePaymentPromises } from '../../collections/application/settle-payment-promises';
import { DrainAllocationRebalancesInterceptor } from '../../payments/presentation/drain-allocation-rebalances.interceptor';
import {
  ConfirmPaymentReportUseCase,
  CountPaymentReportsUseCase,
  GetPaymentReportProofUrlUseCase,
  ListPaymentReportsUseCase,
  RejectPaymentReportUseCase,
} from '../application/use-cases/payment-reports.use-cases';
import type { PaymentReportRow } from '../domain/ports/payment-link-repository.port';
import {
  ConfirmPaymentReportDto,
  ConfirmedPaymentReportDto,
  CountPaymentReportsQueryDto,
  ListPaymentReportsQueryDto,
  PaymentReportDto,
  PaymentReportProofUrlDto,
  PaymentReportsCountDto,
  PaymentReportsPageDto,
  RejectPaymentReportDto,
  RejectedPaymentReportDto,
} from './dto/payment-link.dto';

/** El reporte para la API: el comprobante solo con sus metadatos (nunca la clave). */
export function toPaymentReportDto(row: PaymentReportRow): PaymentReportDto {
  const { proof, ...rest } = row;
  return {
    ...rest,
    proof: proof
      ? { name: proof.name, mime: proof.mime, size: proof.size }
      : null,
  };
}

// «Pagos por confirmar» en Caja (DX-569, D7–D9): quien cobra (ADMIN y
// recepción), con el filtro de sede de Caja (la sede del enlace, la del plan).
// Confirmar registra el abono con los casos de uso de Caja; el reparto corre
// tras el COMMIT (DrainAllocationRebalancesInterceptor, como el abono).
@ApiTags('payment-reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor, DrainAllocationRebalancesInterceptor)
@Roles(...PAYMENT_ROLES)
@ApiForbiddenResponse({
  description: 'Rol sin acceso a pagos, o sede no permitida al usuario',
})
@Controller('payment-reports')
export class PaymentReportsController {
  constructor(
    private readonly listReports: ListPaymentReportsUseCase,
    private readonly countReports: CountPaymentReportsUseCase,
    private readonly proofUrlOf: GetPaymentReportProofUrlUseCase,
    private readonly confirmReport: ConfirmPaymentReportUseCase,
    private readonly rejectReport: RejectPaymentReportUseCase,
    private readonly settlePromises: SettlePaymentPromises,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Pagos reportados por los pacientes',
    description:
      'DX-569 (D9). Los pendientes del más antiguo al más reciente; los decididos, lo último primero. Sede: `locationId` (403 si no está permitida) o, sin ella, la de la cabecera o las permitidas, como Caja.',
  })
  @ApiOkResponse({ type: PaymentReportsPageDto })
  async list(
    @Query() query: ListPaymentReportsQueryDto,
  ): Promise<PaymentReportsPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const result = await this.listReports.execute({
      status: query.status,
      page,
      pageSize,
      locationId: query.locationId,
    });
    return {
      items: result.items.map(toPaymentReportDto),
      total: result.total,
      page,
      pageSize,
    };
  }

  @Get('count')
  @ApiOperation({
    summary: 'Pagos reportados pendientes de confirmar (la cola de «Mi día»)',
  })
  @ApiOkResponse({ type: PaymentReportsCountDto })
  count(
    @Query() query: CountPaymentReportsQueryDto,
  ): Promise<PaymentReportsCountDto> {
    return this.countReports.execute({ locationId: query.locationId });
  }

  // Auditada en el caso de uso (VIEW de PAYMENT_REPORT).
  @Get(':id/proof-url')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'URL firmada (5 min) para ver el comprobante del reporte',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PaymentReportProofUrlDto })
  @ApiNotFoundResponse({
    description: 'Reporte no encontrado en esta clínica o sin comprobante',
  })
  proofUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuditableRequest,
  ): Promise<PaymentReportProofUrlDto> {
    return this.proofUrlOf.execute(
      id,
      auditRequestContext(req, this.tenantContext),
    );
  }

  // Auditada en la transacción del abono: UPDATE de PAYMENT_REPORT (con las
  // correcciones) y CREATE de PAYMENT.
  @Post(':id/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirma el pago reportado: registra el abono',
    description:
      'DX-569 (D7). Con los casos de uso de Caja (`Idempotency-Key` = id del reporte, la caja de quien confirma, el comprobante del reporte como el del abono, la tasa del día del pago reportado) y el reporte CONFIRMED con su abono en la MISMA transacción. Correcciones opcionales (lo que llegó de verdad): importe, moneda, medio, referencia y día; `rateOverride` + `rateOverrideReason` fija la tasa. Ya confirmado (o dos confirmaciones a la vez): el mismo abono, nunca dos.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ConfirmedPaymentReportDto })
  @ApiBadRequestResponse({
    description:
      'Corrección no válida (medio de otra clínica o desactivado, referencia que el medio pide, día posterior a hoy), `rateOverride` sin motivo o con dos monedas que no son USD, o importe por encima de lo pendiente de un saldo migrado',
  })
  @ApiNotFoundResponse({ description: 'Reporte no encontrado en esta clínica' })
  @ApiConflictResponse({
    description:
      '`code: PAYMENT_REPORT_NOT_PENDING` (ya rechazado), `code: PAYMENT_REFERENCE_DUPLICATE` (se repite con `duplicateReferenceReason`), el plan ya no admite abonos o la clínica exige caja abierta para el efectivo',
  })
  @ApiUnprocessableEntityResponse({
    description: 'La sede no tiene formato regional configurado',
  })
  async confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmPaymentReportDto,
    @Req() req: AuditableRequest,
  ): Promise<ConfirmedPaymentReportDto> {
    const audit = requireAuditRequestContext(req, this.tenantContext);
    const confirmed = await this.confirmReport.execute(
      id,
      {
        amount: dto.amount,
        currency: dto.currency,
        paymentMethodId: dto.paymentMethodId,
        reference: dto.reference,
        paidOn: dto.paidOn,
        rateOverride: dto.rateOverride,
        rateOverrideReason: dto.rateOverrideReason,
        duplicateReferenceReason: dto.duplicateReferenceReason,
      },
      audit,
    );
    // DX-150: como el abono de Caja; nunca falla la petición.
    await this.settlePromises.afterPayment(confirmed.payment.patientId, audit);
    return confirmed;
  }

  // Auditada en la transacción del rechazo (UPDATE de PAYMENT_REPORT, sin el
  // motivo).
  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rechaza el pago reportado (no toca el saldo)',
    description:
      'DX-569 (D8). Queda REJECTED con el motivo interno. Si el paciente tiene email se le avisa con la plantilla `payment-report-rejected`, que NO lleva el motivo («La clínica no pudo confirmar tu pago; te contactará»). Para reportar otro hace falta un enlace nuevo.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RejectedPaymentReportDto })
  @ApiBadRequestResponse({ description: 'Motivo vacío o de más de 280' })
  @ApiNotFoundResponse({ description: 'Reporte no encontrado en esta clínica' })
  @ApiConflictResponse({
    description:
      '`code: PAYMENT_REPORT_NOT_PENDING`: ya confirmado o rechazado',
  })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectPaymentReportDto,
    @Req() req: AuditableRequest,
  ): Promise<RejectedPaymentReportDto> {
    const { report, patientNotified } = await this.rejectReport.execute(
      id,
      dto.reason,
      requireAuditRequestContext(req, this.tenantContext),
    );
    return { report: toPaymentReportDto(report), patientNotified };
  }
}
