import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { DrainAllocationRebalancesInterceptor } from '../../payments/presentation/drain-allocation-rebalances.interceptor';
import {
  isTenantPayload,
  type JwtPayload,
} from '../../../shared/crypto/token.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  ChargeCancellationFeeUseCase,
  GetCancellationFeeUseCase,
  VoidCancellationFeeUseCase,
  WaiveCancellationFeeUseCase,
  type CancellationFeeView,
  type FeeActor,
} from '../application/cancellation-fee.use-cases';
import { CANCELLATION_FEE_MESSAGES } from '../domain/cancellation-fee';
import {
  CancellationFeeViewDto,
  ChargeCancellationFeeDto,
  VoidCancellationFeeDto,
  WaiveCancellationFeeDto,
} from './dto/cancellation-fee.dto';

function actorOf(req: { user: JwtPayload }): FeeActor {
  // Detrás del RolesGuard siempre es un token de clínica.
  if (!isTenantPayload(req.user)) throw new Error('Sin sesión de clínica');
  return { userId: req.user.sub, role: req.user.role };
}

/**
 * Cargo por inasistencia o cancelación tardía (DX-291). ADMIN siempre;
 * RECEPTION si la política vigente de la sede lo permite (el caso de uso da
 * 403 si no). El resto de roles: 403 del guard. SEC-050: anularlo también va
 * por aquí (`void`); desde el plan su ítem no se toca.
 */
@ApiTags('cancellation-fees')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
// DX-051: detrás del tenant, en el MISMO decorador (corre en su contexto).
@UseInterceptors(TenantContextInterceptor, DrainAllocationRebalancesInterceptor)
@Roles(ClinicRole.ADMIN, ClinicRole.RECEPTION)
@RolesDeniedMessage(CANCELLATION_FEE_MESSAGES.forbidden)
@Controller('appointments/:id/cancellation-fee')
export class CancellationFeeController {
  constructor(
    private readonly getFee: GetCancellationFeeUseCase,
    private readonly chargeFee: ChargeCancellationFeeUseCase,
    private readonly waiveFee: WaiveCancellationFeeUseCase,
    private readonly voidCharge: VoidCancellationFeeUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Estado del cargo por inasistencia o cancelación tardía de la cita',
  })
  @ApiOkResponse({ type: CancellationFeeViewDto })
  @ApiBadRequestResponse({ description: 'Id que no es UUID' })
  @ApiForbiddenResponse({
    description:
      'Rol sin permiso, o sede de la cita no permitida al usuario (DX-089)',
  })
  @ApiNotFoundResponse({ description: 'Cita no encontrada en esta clínica' })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayload },
  ): Promise<CancellationFeeView> {
    return this.getFee.execute(id, actorOf(req));
  }

  @Audit({
    action: 'CREATE',
    resource: 'APPOINTMENT',
    resourceId: { param: 'id' },
    patient: { response: 'patientId' },
    reason: 'CANCELLATION_FEE_CHARGED',
  })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Generar el cargo (ítem DONE en el plan «Cargos administrativos»)',
    description:
      'Solo una cita NO_SHOW o cancelada tarde con la política comunicada al paciente (`policyVersionId`). Crea o reutiliza el plan ACCEPTED «Cargos administrativos» del paciente en la moneda de esa versión y le añade un ítem DONE con el importe (el sugerido, o menos); sale en el estado de cuenta y se cobra con un abono y su recibo (DX-136). Idempotente: una sola decisión por cita (índice único y cita bloqueada). Auditado (APPOINTMENT, CANCELLATION_FEE_CHARGED).',
  })
  @ApiCreatedResponse({ type: CancellationFeeViewDto })
  @ApiBadRequestResponse({
    description:
      'Importe no válido o por encima del sugerido por la versión comunicada',
  })
  @ApiForbiddenResponse({
    description:
      'Ni ADMIN ni RECEPTION con permiso de la política; o sede no permitida',
  })
  @ApiNotFoundResponse({ description: 'Cita no encontrada en esta clínica' })
  @ApiConflictResponse({
    description:
      'No es inasistencia ni tardía, «No consta que el paciente fuera informado de la política», la versión comunicada no tiene importe, ya cobrado o condonado, o la cita cambió mientras tanto',
  })
  charge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChargeCancellationFeeDto,
    @Req() req: { user: JwtPayload },
  ): Promise<CancellationFeeView> {
    return this.chargeFee.execute(id, dto.amount, actorOf(req));
  }

  @Audit({
    action: 'UPDATE',
    resource: 'APPOINTMENT',
    resourceId: { param: 'id' },
    patient: { response: 'patientId' },
    reason: 'CANCELLATION_FEE_WAIVED',
  })
  @Post('waive')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Condonar el cargo con motivo (no se cobrará)',
    description:
      'Solo una cita NO_SHOW o cancelada tarde, antes de cobrar y una vez. El motivo (3–500) queda con la decisión; la auditoría registra la condonación (APPOINTMENT, CANCELLATION_FEE_WAIVED) sin el texto.',
  })
  @ApiCreatedResponse({ type: CancellationFeeViewDto })
  @ApiBadRequestResponse({ description: 'Motivo vacío o de más de 500' })
  @ApiForbiddenResponse({
    description:
      'Ni ADMIN ni RECEPTION con permiso de la política; o sede no permitida',
  })
  @ApiNotFoundResponse({ description: 'Cita no encontrada en esta clínica' })
  @ApiConflictResponse({
    description:
      'No es inasistencia ni tardía, ya cobrado o condonado, o la cita cambió',
  })
  waive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WaiveCancellationFeeDto,
    @Req() req: { user: JwtPayload },
  ): Promise<CancellationFeeView> {
    return this.waiveFee.execute(id, dto.reason, actorOf(req));
  }

  @Audit({
    action: 'VOID',
    resource: 'APPOINTMENT',
    resourceId: { param: 'id' },
    patient: { response: 'patientId' },
    reason: 'CANCELLATION_FEE_VOIDED',
    statusChange: { from: 'CHARGED', to: 'VOIDED' },
  })
  @Post('void')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Anular un cargo ya generado, con motivo (SEC-050)',
    description:
      'La única forma de dejar sin efecto un cargo generado: desde el plan, su ítem no cambia de precio, descuento ni estado ni se quita (409 a todo rol). En una transacción, con la cita y el cargo bloqueados, guarda en el cargo quién, cuándo y el motivo (3–500) y retira su ítem del plan «Cargos administrativos» (deja de salir en el estado de cuenta). Una vez por cargo. Si los abonos vivos de ese plan ya cubren el cargo, 409: se anula antes el abono. Lo cobrado se compara en la moneda del plan con la base de imputación de cada abono (DX-051, con la tasa que congeló, DX-375); si algún abono vivo aún no la tiene («sin tasa»), 409 «Hay abonos sin convertir» (DX-382). Auditado (VOID APPOINTMENT, CANCELLATION_FEE_VOIDED, estado CHARGED → VOIDED, sin el texto del motivo). Sin Idempotency-Key, como condonar: repetirla da 409 «ya se anuló».',
  })
  @ApiCreatedResponse({ type: CancellationFeeViewDto })
  @ApiBadRequestResponse({ description: 'Motivo vacío o de más de 500' })
  @ApiForbiddenResponse({
    description:
      'Ni ADMIN ni RECEPTION con permiso de la política; o sede no permitida (DX-089)',
  })
  @ApiNotFoundResponse({ description: 'Cita no encontrada en esta clínica' })
  @ApiConflictResponse({
    description:
      'Sin cargo generado (o condonado), ya anulado, ya cobrado (anula antes el abono), hay abonos del plan sin convertir a su moneda (registra la tasa del día), o la cita cambió. «Ya cobrado» compara en la moneda del plan con la base de cada abono (DX-382)',
  })
  voidFee(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidCancellationFeeDto,
    @Req() req: { user: JwtPayload },
  ): Promise<CancellationFeeView> {
    return this.voidCharge.execute(id, dto.reason, actorOf(req));
  }
}
