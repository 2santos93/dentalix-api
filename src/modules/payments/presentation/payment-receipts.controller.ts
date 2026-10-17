import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
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
import { GetPaymentReceiptUseCase } from '../application/receipts/get-payment-receipt.use-case';
import {
  SendPaymentReceiptUseCase,
  type SendPaymentReceiptResult,
} from '../application/receipts/send-payment-receipt.use-case';
import type { PaymentReceiptView } from '../domain/entities/payment-receipt.entity';
import {
  PaymentReceiptDto,
  SendPaymentReceiptResponseDto,
} from './dto/payment-receipt.dto';

export const PAYMENT_RECEIPT_FORBIDDEN_MESSAGE =
  'Tu rol no tiene acceso a los recibos de caja: los ven, imprimen y envían administración y recepción.';

const RECEIPT_AUDIT = {
  resource: 'PAYMENT_RECEIPT',
  resourceId: { param: 'id' },
  patient: { lookup: 'payment', param: 'id' },
} as const;

/**
 * Recibo de caja de un abono (DX-136). Mismos roles que los pagos
 * (PAYMENT_ROLES: ADMIN y RECEPTION); el resto, 403 en español. El `:id` es
 * el del ABONO (anulado o no); la RLS lo limita a la clínica. No se filtra
 * por sede, igual que los abonos de un plan: el paciente es de la clínica.
 * Cada lectura, reimpresión y envío deja su evento de auditoría.
 */
@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PAYMENT_ROLES)
@RolesDeniedMessage(PAYMENT_RECEIPT_FORBIDDEN_MESSAGE)
@Controller('payments/:id/receipt')
export class PaymentReceiptsController {
  constructor(
    private readonly getReceipt: GetPaymentReceiptUseCase,
    private readonly sendReceipt: SendPaymentReceiptUseCase,
  ) {}

  @Audit({ action: 'VIEW', ...RECEIPT_AUDIT })
  @Get()
  @ApiOperation({ summary: 'Ver el recibo de caja de un abono' })
  @ApiOkResponse({ type: PaymentReceiptDto })
  @ApiForbiddenResponse({
    description: 'Rol sin acceso a pagos (403 en español)',
  })
  @ApiNotFoundResponse({
    description: 'El abono no existe o es de otra clínica',
  })
  view(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentReceiptView> {
    return this.getReceipt.execute(id);
  }

  @Audit({ action: 'PRINT', ...RECEIPT_AUDIT })
  @Post('print')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reimprimir el recibo (lo deja en la auditoría y lo devuelve)',
    description:
      'Devuelve el MISMO recibo que GET (su foto al emitirlo); la vista ' +
      'imprimible lo pide por aquí para que cada impresión quede registrada.',
  })
  @ApiOkResponse({ type: PaymentReceiptDto })
  @ApiForbiddenResponse({
    description: 'Rol sin acceso a pagos (403 en español)',
  })
  @ApiNotFoundResponse({
    description: 'El abono no existe o es de otra clínica',
  })
  print(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentReceiptView> {
    return this.getReceipt.execute(id);
  }

  @Audit({ action: 'SEND', ...RECEIPT_AUDIT })
  @Post('email')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Enviar el recibo por email al paciente',
    description:
      'Encola el email (outbox, DX-088) con el MISMO recibo al email de la ' +
      'ficha del paciente, con el documento enmascarado. DX-203: el de un ' +
      'menor o de un paciente sin email va al responsable que recibe avisos ' +
      '(`sentToResponsible`).',
  })
  @ApiAcceptedResponse({ type: SendPaymentReceiptResponseDto })
  @ApiForbiddenResponse({
    description: 'Rol sin acceso a pagos (403 en español)',
  })
  @ApiNotFoundResponse({
    description: 'El abono no existe o es de otra clínica',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Ni el paciente ni un responsable que recibe avisos tienen email',
  })
  @ApiTooManyRequestsResponse({ description: 'Topes de envío de la clínica' })
  email(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SendPaymentReceiptResult> {
    return this.sendReceipt.execute(id);
  }
}
