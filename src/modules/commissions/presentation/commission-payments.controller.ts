import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { contentDispositionHeader } from '../../../shared/storage/file-storage.port';
import {
  resolvePublicWebProtocol,
  safeLinkHost,
} from '../../../shared/tenancy/public-link';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { COMMISSION_WRITE_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  COMMISSION_PAYMENT_MESSAGES,
  CommissionPaymentUseCases,
  type CommissionPdf,
  type CommissionReceiptLink,
} from '../application/commission-payment.use-cases';
import {
  COMMISSION_MESSAGES,
  type CommissionActor,
} from '../application/commission.use-cases';
import type { CommissionPaymentView } from '../domain/views';
import {
  CommissionPaymentDto,
  CommissionReceiptLinkDto,
  PayCommissionSettlementDto,
  VoidCommissionPaymentDto,
} from './dto/commission-payment.dto';

interface AuthenticatedRequest extends AuditableRequest, TenantHostRequest {
  user: TenantJwtPayload;
}

export const COMMISSION_PAYMENT_FORBIDDEN_MESSAGE =
  'Solo administración paga las liquidaciones de honorarios.';

const FORBIDDEN = `${COMMISSION_PAYMENT_FORBIDDEN_MESSAGE} / ${COMMISSION_MESSAGES.allLocations}`;
const PDF_SCHEMA = { type: 'string', format: 'binary' } as const;
const PAYMENT_PARAM = {
  name: 'paymentId',
  format: 'uuid',
  description: 'El pago de la liquidación.',
} as const;

const actorOf = (req: AuthenticatedRequest): CommissionActor => ({
  userId: req.user.sub,
  role: req.user.role,
});

function sendPdf(res: Response, result: CommissionPdf): StreamableFile {
  res.set('Content-Type', 'application/pdf');
  res.set(
    'Content-Disposition',
    contentDispositionHeader({
      disposition: 'attachment',
      filename: result.filename,
    }),
  );
  res.set('Cache-Control', 'private, no-store');
  return new StreamableFile(result.pdf);
}

/**
 * DX-464: pagar una liquidación de honorarios cerrada (gasto de la sede),
 * anular el pago, los PDF y el enlace de conformidad del profesional. Solo
 * ADMIN con todas las sedes. Nada de importes en la auditoría.
 */
@ApiTags('commissions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...COMMISSION_WRITE_ROLES)
@RolesDeniedMessage(COMMISSION_PAYMENT_FORBIDDEN_MESSAGE)
@ApiForbiddenResponse({ description: FORBIDDEN })
@Controller('commissions')
export class CommissionPaymentsController {
  private readonly protocol: 'http' | 'https';

  constructor(
    private readonly payments: CommissionPaymentUseCases,
    private readonly tenantContext: TenantContextService,
    config: ConfigService,
  ) {
    this.protocol = resolvePublicWebProtocol((key) => config.get<string>(key));
  }

  // Auditado en la transacción (COMMISSION_SETTLEMENT CREATE
  // COMMISSION_PAYMENT_CREATED y EXPENSE CREATE COMMISSION_PAYMENT; sin importes).
  @Post('settlements/:id/payments')
  @HttpCode(201)
  @ApiParam({ name: 'id', format: 'uuid', description: 'La liquidación.' })
  @ApiOperation({
    summary: 'Registra un pago de la liquidación y su gasto en la sede',
    description:
      'Paga las líneas elegidas (o todas las pendientes) de UNA moneda, sin convertir: el importe es la suma de esas líneas. Crea en la misma transacción el gasto de la sede (categoría «Honorarios», proveedor = el profesional, descripción con el período y la referencia) ya pagado con el medio y el día indicados (o desde la caja abierta). La liquidación pasa a «Pagada parcialmente» o «Pagada». El día no puede caer en un período contable cerrado.',
  })
  @ApiCreatedResponse({ type: CommissionPaymentDto })
  @ApiBadRequestResponse({
    description:
      'Moneda, día, medio o referencia no válidos; `COMMISSION_PAYMENT_LINE_UNKNOWN`, `COMMISSION_PAYMENT_LINE_CURRENCY` o `COMMISSION_PAYMENT_NOT_POSITIVE`; reglas del gasto (fecha futura, sede, caja)',
  })
  @ApiNotFoundResponse({ description: COMMISSION_MESSAGES.settlementNotFound })
  @ApiConflictResponse({
    description:
      '`COMMISSION_NOTHING_PENDING` (nada pendiente en esa moneda), `COMMISSION_LINE_ALREADY_PAID`, `COMMISSION_PAYMENT_EXCEEDS_PENDING` (con `pending`), `PERIOD_LOCKED`, o la caja (sin caja abierta / efectivo siempre en caja)',
  })
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayCommissionSettlementDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CommissionPaymentView> {
    return this.payments.pay(
      actorOf(req),
      id,
      {
        currency: dto.currency,
        lineIds: dto.lineIds,
        paidOn: dto.paidOn,
        method: dto.method,
        reference: dto.reference,
        locationId: dto.locationId,
        fromCashSession: dto.fromCashSession,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // Auditado en la transacción (VOID de COMMISSION_SETTLEMENT y de EXPENSE;
  // el motivo se queda en el pago).
  @Post('payments/:paymentId/void')
  @HttpCode(200)
  @ApiParam(PAYMENT_PARAM)
  @ApiOperation({
    summary: 'Anula un pago de la liquidación (con motivo)',
    description:
      'Anula el gasto de la sede (y su salida de caja, si la hubo), devuelve las líneas a pendientes y revoca el enlace de conformidad vivo. No si el día del pago cae en un período contable cerrado.',
  })
  @ApiOkResponse({ type: CommissionPaymentDto })
  @ApiBadRequestResponse({ description: 'Motivo de 5 a 500 caracteres' })
  @ApiNotFoundResponse({
    description: COMMISSION_PAYMENT_MESSAGES.paymentNotFound,
  })
  @ApiConflictResponse({
    description: '`COMMISSION_PAYMENT_VOIDED` o `PERIOD_LOCKED`',
  })
  void(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: VoidCommissionPaymentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CommissionPaymentView> {
    return this.payments.void(
      actorOf(req),
      paymentId,
      dto.reason,
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Audit({
    action: 'EXPORT',
    resource: 'COMMISSION_SETTLEMENT',
    resourceId: { param: 'id' },
    reason: 'COMMISSION_SETTLEMENT_PDF',
  })
  @Get('settlements/:id/pdf')
  @ApiParam({ name: 'id', format: 'uuid', description: 'La liquidación.' })
  @ApiOperation({
    summary: 'PDF de la liquidación para el profesional',
    description:
      'Iniciales del paciente (nunca el nombre), procedimiento, fecha, base, %, deducciones y totales por moneda, con lo pagado y lo pendiente. Sale de la clínica: auditado (EXPORT).',
  })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'El PDF (attachment).', schema: PDF_SCHEMA })
  @ApiNotFoundResponse({ description: COMMISSION_MESSAGES.settlementNotFound })
  async settlementPdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return sendPdf(res, await this.payments.settlementPdf(actorOf(req), id));
  }

  @Audit({
    action: 'EXPORT',
    resource: 'COMMISSION_SETTLEMENT',
    resourceId: { param: 'paymentId' },
    reason: 'COMMISSION_RECEIPT_PDF',
  })
  @Get('payments/:paymentId/receipt/pdf')
  @ApiParam(PAYMENT_PARAM)
  @ApiOperation({
    summary: 'PDF del recibo del pago (firmado, si el profesional ya firmó)',
    description:
      'El recibo con las prestaciones pagadas (iniciales, procedimiento, fecha, base, %) y, si hay conformidad, la firma con fecha, IP, navegador y huellas SHA-256. Auditado (EXPORT).',
  })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'El PDF (attachment).', schema: PDF_SCHEMA })
  @ApiNotFoundResponse({
    description: COMMISSION_PAYMENT_MESSAGES.paymentNotFound,
  })
  async receiptPdf(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return sendPdf(
      res,
      await this.payments.receiptPdf(actorOf(req), paymentId),
    );
  }

  // Auditado en la transacción (SEND COMMISSION_RECEIPT_REQUESTED; ni la URL
  // ni el token van a la auditoría).
  @Post('payments/:paymentId/receipt-request')
  @HttpCode(201)
  @ApiParam(PAYMENT_PARAM)
  @ApiOperation({
    summary: 'Pide la conformidad del profesional («recibido conforme»)',
    description:
      'Crea un enlace de un solo uso que caduca a las 72 h con la foto del recibo (solo iniciales de los pacientes). Pedir otro revoca el anterior. La URL solo viene en esta respuesta: la web la envía por email (mailto) o WhatsApp (wa.me).',
  })
  @ApiCreatedResponse({ type: CommissionReceiptLinkDto })
  @ApiBadRequestResponse({ description: COMMISSION_PAYMENT_MESSAGES.noHost })
  @ApiNotFoundResponse({
    description: COMMISSION_PAYMENT_MESSAGES.paymentNotFound,
  })
  @ApiConflictResponse({
    description:
      '`COMMISSION_PAYMENT_VOIDED` o `COMMISSION_RECEIPT_ALREADY_SIGNED`',
  })
  requestReceipt(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<CommissionReceiptLink> {
    return this.payments.requestReceipt(
      actorOf(req),
      paymentId,
      { protocol: this.protocol, host: safeLinkHost(req.tenantHost?.host) },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}
