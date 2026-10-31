import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  PATIENT_CREDIT_POLICY_WRITE_ROLES,
  PATIENT_CREDIT_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreditPolicyUseCases,
  GetCreditRefundUseCase,
  ListPatientCreditUseCase,
  RefundCreditUseCase,
  TransferCreditUseCase,
  type CreditPolicyView,
  type TransferResult,
} from '../application/patient-credit.use-cases';
import type {
  CreditRefundRecord,
  PatientCreditMovements,
} from '../domain/ports/patient-credit-repository.port';
import { CREDIT_ROLE_FORBIDDEN_MESSAGE } from '../domain/patient-credit';
import {
  CreditPolicyDto,
  CreditRefundDto,
  CreditTransferResultDto,
  PatientCreditMovementsDto,
  RefundCreditDto,
  TransferCreditDto,
  UpdateCreditPolicyDto,
} from './dto/patient-credit.dto';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: false,
  description:
    'UUID. Repetir la MISMA petición con la misma clave devuelve el movimiento original (DX-109); con otro cuerpo, 422.',
};

const POLICY_WRITE_FORBIDDEN_MESSAGE =
  'Solo la administración cambia el tope de saldo a favor de recepción.';

/**
 * Saldo a favor del paciente (DX-253): traspaso a otro plan vivo del mismo
 * paciente y devolución con comprobante. Dato FINANCIERO: ADMIN y RECEPTION
 * (esta, hasta el tope de la clínica); DENTIST y ASSISTANT no. Las escrituras
 * van auditadas (quién, cuándo y el movimiento, cuya fila inmutable guarda
 * importe y motivo); la sede es la de `X-Location-Id`.
 */
@ApiTags('patient-credit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_CREDIT_ROLES)
@RolesDeniedMessage(CREDIT_ROLE_FORBIDDEN_MESSAGE)
@Controller()
export class PatientCreditController {
  constructor(
    private readonly transferCredit: TransferCreditUseCase,
    private readonly refundCredit: RefundCreditUseCase,
    private readonly getRefund: GetCreditRefundUseCase,
    private readonly listCredit: ListPatientCreditUseCase,
    private readonly policy: CreditPolicyUseCases,
  ) {}

  @Audit({
    action: 'CREATE',
    resource: 'PATIENT_CREDIT',
    resourceId: { response: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
    reason: 'CREDIT_TRANSFER',
  })
  @Post('treatment-plans/:id/credit-transfers')
  @ApiOperation({
    summary: 'Traspasar saldo a favor de este plan a otro plan vivo',
    description:
      'Mismo paciente y misma moneda; importe ≤ saldo a favor del origen. Deja dos asientos inmutables (salida y entrada) sin tocar los abonos.',
  })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiCreatedResponse({ type: CreditTransferResultDto })
  @ApiBadRequestResponse({
    description:
      'Importe mayor que el saldo a favor, otra moneda, el mismo plan o un plan de otro paciente.',
  })
  @ApiForbiddenResponse({
    description: 'DENTIST/ASSISTANT, o RECEPTION por encima del tope.',
  })
  @ApiNotFoundResponse({ description: 'Plan inexistente o de otra clínica.' })
  @ApiConflictResponse({
    description:
      'El destino está cancelado o rechazado, o el saldo cambió a la vez.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'La Idempotency-Key ya se usó con otro cuerpo.',
  })
  transfer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferCreditDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<TransferResult> {
    return this.transferCredit.execute(
      id,
      dto,
      { userId: req.user.sub, role: req.user.role },
      key,
    );
  }

  @Audit({
    action: 'CREATE',
    resource: 'PATIENT_CREDIT',
    resourceId: { response: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
    reason: 'CREDIT_REFUND',
  })
  @Post('treatment-plans/:id/credit-refunds')
  @ApiOperation({
    summary: 'Devolver saldo a favor del plan al paciente',
    description:
      'Con comprobante numerado por sede (serie DEV-…). En efectivo, egreso de la caja abierta de quien devuelve; con «exigir caja abierta» y sin caja, 409.',
  })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiCreatedResponse({ type: CreditRefundDto })
  @ApiBadRequestResponse({
    description:
      'Importe mayor que el saldo a favor, otra moneda, sin motivo o abonos de referencia que no son del plan.',
  })
  @ApiForbiddenResponse({
    description: 'DENTIST/ASSISTANT, o RECEPTION por encima del tope.',
  })
  @ApiNotFoundResponse({ description: 'Plan inexistente o de otra clínica.' })
  @ApiConflictResponse({
    description:
      'El saldo cambió a la vez (otra devolución) o falta la caja abierta exigida.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'La Idempotency-Key ya se usó con otro cuerpo.',
  })
  refund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundCreditDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<CreditRefundRecord> {
    return this.refundCredit.execute(
      id,
      dto,
      { userId: req.user.sub, role: req.user.role },
      key,
    );
  }

  @Audit({
    action: 'VIEW',
    resource: 'PATIENT_CREDIT',
    resourceId: { param: 'id' },
    patient: { response: 'patientId' },
    reason: 'CREDIT_REFUND_RECEIPT',
  })
  @Get('credit-refunds/:id')
  @ApiOperation({ summary: 'Comprobante de una devolución (para imprimir)' })
  @ApiOkResponse({ type: CreditRefundDto })
  @ApiNotFoundResponse({ description: 'Inexistente o de otra clínica.' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<CreditRefundRecord> {
    return this.getRefund.execute(id);
  }

  @Audit({
    action: 'VIEW',
    resource: 'PATIENT_CREDIT',
    patient: { param: 'id' },
  })
  @Get('patients/:id/credit-movements')
  @ApiOperation({
    summary: 'Traspasos y devoluciones de saldo a favor del paciente',
  })
  @ApiOkResponse({ type: PatientCreditMovementsDto })
  @ApiNotFoundResponse({
    description: 'Paciente inexistente o de otra clínica.',
  })
  list(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PatientCreditMovements> {
    return this.listCredit.execute(id);
  }

  @Get('patient-credit/policy')
  @ApiOperation({ summary: 'Tope de recepción para mover saldo a favor' })
  @ApiOkResponse({ type: CreditPolicyDto })
  getPolicy(): Promise<CreditPolicyView> {
    return this.policy.get();
  }

  @Audit({ action: 'UPDATE', resource: 'PATIENT_CREDIT', reason: 'POLICY' })
  @Put('patient-credit/policy')
  @HttpCode(200)
  @Roles(...PATIENT_CREDIT_POLICY_WRITE_ROLES)
  @RolesDeniedMessage(POLICY_WRITE_FORBIDDEN_MESSAGE)
  @ApiOperation({ summary: 'Cambiar el tope de recepción (solo ADMIN)' })
  @ApiOkResponse({ type: CreditPolicyDto })
  @ApiForbiddenResponse({ description: POLICY_WRITE_FORBIDDEN_MESSAGE })
  updatePolicy(@Body() dto: UpdateCreditPolicyDto): Promise<CreditPolicyView> {
    return this.policy.update(dto.receptionMaxAmount);
  }
}
