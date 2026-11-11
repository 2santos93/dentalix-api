import {
  Controller,
  Get,
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
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { PAYMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import { GetPaymentReceiptSummaryUseCase } from '../application/receipts/get-payment-receipt-summary.use-case';
import {
  SendPaymentReceiptSummaryUseCase,
  type SendPaymentReceiptSummaryResult,
} from '../application/receipts/send-payment-receipt-summary.use-case';
import type { PaymentReceiptSummaryView } from '../domain/receipt-summary';
import {
  PaymentReceiptSummaryDto,
  PaymentReceiptSummaryQueryDto,
} from './dto/payment-receipt-summary.dto';
import { SendPaymentReceiptResponseDto } from './dto/payment-receipt.dto';

export const PAYMENT_RECEIPT_SUMMARY_FORBIDDEN_MESSAGE =
  'Tu rol no tiene acceso al resumen de recibos de caja: lo ven, imprimen y envían administración y recepción.';

const SUMMARY_AUDIT = {
  resource: 'PAYMENT_RECEIPT_SUMMARY',
  resourceId: { param: 'patientId' },
  patient: { param: 'patientId' },
} as const;

interface SummaryRequest {
  /** DX-401: el período va a la metadata del evento (`period`). */
  auditMetadata?: Record<string, unknown>;
}

/**
 * DX-401: resumen de los recibos de caja de un paciente en un período (todos
 * sus abonos, anulados marcados). Mismos roles que el recibo de un abono
 * (PAYMENT_ROLES); el resto, 403 en español. La RLS lo limita a la clínica
 * (paciente de otra clínica: 404) y un miembro restringido a unas sedes solo
 * recibe los recibos de esas sedes (`restrictedToLocations`), sin 403. Cada
 * vista, impresión y envío deja su evento con el paciente y el período.
 */
@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PAYMENT_ROLES)
@RolesDeniedMessage(PAYMENT_RECEIPT_SUMMARY_FORBIDDEN_MESSAGE)
@Controller('patients/:patientId/payment-receipts/summary')
export class PaymentReceiptSummaryController {
  constructor(
    private readonly getSummary: GetPaymentReceiptSummaryUseCase,
    private readonly sendSummary: SendPaymentReceiptSummaryUseCase,
  ) {}

  @Audit({ action: 'VIEW', ...SUMMARY_AUDIT })
  @Get()
  @ApiOperation({
    summary:
      'Ver el resumen de los recibos de caja de un paciente en un período',
    description:
      'Los recibos emitidos del día `from` al `to` (ambos inclusive, en la ' +
      'zona de la sede de cada recibo), con su número, sede, forma de pago e ' +
      'importe; los anulados, marcados y fuera de los totales. Totales por ' +
      'moneda: nunca se suman monedas distintas. Período sin recibos: 200 con ' +
      'la lista vacía.',
  })
  @ApiParam({ name: 'patientId', format: 'uuid' })
  @ApiOkResponse({ type: PaymentReceiptSummaryDto })
  @ApiBadRequestResponse({
    description: 'Fechas ausentes o inválidas, from > to o más de 366 días',
  })
  @ApiForbiddenResponse({
    description: 'Rol sin acceso a pagos (403 en español)',
  })
  @ApiNotFoundResponse({
    description: 'El paciente no existe o es de otra clínica',
  })
  view(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query() query: PaymentReceiptSummaryQueryDto,
    @Req() req: SummaryRequest,
  ): Promise<PaymentReceiptSummaryView> {
    auditPeriod(req, query);
    return this.getSummary.execute(patientId, query);
  }

  @Audit({ action: 'PRINT', ...SUMMARY_AUDIT })
  @Post('print')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Imprimir el resumen (lo deja en la auditoría y lo devuelve)',
    description:
      'Devuelve el MISMO resumen que GET; la vista imprimible lo pide por ' +
      'aquí para que cada impresión quede registrada.',
  })
  @ApiParam({ name: 'patientId', format: 'uuid' })
  @ApiOkResponse({ type: PaymentReceiptSummaryDto })
  @ApiBadRequestResponse({
    description: 'Fechas ausentes o inválidas, from > to o más de 366 días',
  })
  @ApiForbiddenResponse({
    description: 'Rol sin acceso a pagos (403 en español)',
  })
  @ApiNotFoundResponse({
    description: 'El paciente no existe o es de otra clínica',
  })
  print(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query() query: PaymentReceiptSummaryQueryDto,
    @Req() req: SummaryRequest,
  ): Promise<PaymentReceiptSummaryView> {
    auditPeriod(req, query);
    return this.getSummary.execute(patientId, query);
  }

  @Audit({ action: 'SEND', ...SUMMARY_AUDIT })
  @Post('email')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Enviar el resumen por email al paciente',
    description:
      'Encola (outbox, DX-088) el MISMO resumen al email de la ficha del ' +
      'paciente, con el documento enmascarado. DX-203: el de un menor o de un ' +
      'paciente sin email va al responsable que recibe avisos ' +
      '(`sentToResponsible`).',
  })
  @ApiParam({ name: 'patientId', format: 'uuid' })
  @ApiAcceptedResponse({ type: SendPaymentReceiptResponseDto })
  @ApiBadRequestResponse({
    description: 'Fechas ausentes o inválidas, from > to o más de 366 días',
  })
  @ApiForbiddenResponse({
    description: 'Rol sin acceso a pagos (403 en español)',
  })
  @ApiNotFoundResponse({
    description: 'El paciente no existe o es de otra clínica',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'No hay abonos en el período, o ni el paciente ni un responsable que recibe avisos tienen email',
  })
  @ApiTooManyRequestsResponse({ description: 'Topes de envío de la clínica' })
  email(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query() query: PaymentReceiptSummaryQueryDto,
    @Req() req: SummaryRequest,
  ): Promise<SendPaymentReceiptSummaryResult> {
    auditPeriod(req, query);
    return this.sendSummary.execute(patientId, query);
  }
}

function auditPeriod(
  req: SummaryRequest,
  query: PaymentReceiptSummaryQueryDto,
): void {
  req.auditMetadata = { period: { from: query.from, to: query.to } };
}
