import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { PATIENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  AssignPatientAgreementUseCase,
  GetPatientAgreementUseCase,
  RemovePatientAgreementUseCase,
  type PatientAgreementOutput,
  type PatientAgreementView,
} from '../application/use-cases/patient-agreements.use-cases';
import {
  AssignPatientAgreementDto,
  GetPatientAgreementQueryDto,
  PatientAgreementDto,
  PatientAgreementResponseDto,
} from './dto/patient-agreement.dto';

const patientIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException('El identificador del paciente no es válido.'),
});

// Auditoría como DX-203/DX-153: UPDATE de PATIENT con el motivo. No lleva
// metadata del cuerpo (notas, fechas): solo quién, cuándo y el motivo. El GET
// no se audita (la ficha ya se audita en `GET /patients/:id`).
const audit = (reason: string) =>
  ({
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: { param: 'patientId' },
    patient: { param: 'patientId' },
    reason,
  }) as const;

/**
 * Convenio del paciente (DX-105): uno vigente, con historial. Datos
 * administrativos y de cobro, no clínicos: los 4 roles (PATIENT_ROLES, como
 * «Editar» de la ficha). SEC-047: asignar depende además del convenio (ver
 * `AssignPatientAgreementUseCase`): uno de pagador externo exige una cobertura
 * viva del paciente con él; uno interno, ser ADMIN.
 */
@ApiTags('patients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_ROLES)
@Controller('patients/:patientId/agreement')
export class PatientAgreementsController {
  constructor(
    private readonly getAgreement: GetPatientAgreementUseCase,
    private readonly assignAgreement: AssignPatientAgreementUseCase,
    private readonly removeAgreement: RemovePatientAgreementUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Convenio vigente del paciente y, con includeHistory, las asignaciones retiradas (DX-105)',
  })
  @ApiOkResponse({ type: PatientAgreementResponseDto })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  get(
    @Param('patientId', patientIdPipe) patientId: string,
    @Query() query: GetPatientAgreementQueryDto,
  ): Promise<PatientAgreementOutput> {
    return this.getAgreement.execute(patientId, query.includeHistory === true);
  }

  @Audit(audit('AGREEMENT_ASSIGNED'))
  @Put()
  @ApiOperation({
    summary:
      'Asignar un convenio al paciente, sustituyendo el vigente (DX-105)',
    description:
      'La asignación anterior queda en el historial. Un convenio desactivado se acepta y la asignación sale con estado INACTIVE. SEC-047: un convenio de pagador externo exige `coverageId` con una cobertura vigente del paciente con ese pagador (cualquier rol); uno de pagador OTRO (cortesía, empleados…) solo lo asigna ADMIN, con la cobertura opcional.',
  })
  @ApiOkResponse({ type: PatientAgreementDto })
  @ApiBadRequestResponse({
    description:
      'Validación, convenio inexistente o retirado, vigencia inválida, convenio de pagador sin cobertura, o cobertura que no es del paciente, ni del pagador del convenio, o no está vigente',
  })
  @ApiForbiddenResponse({
    description:
      'Convenio sin pagador externo (pagador OTRO) asignado por un rol distinto de ADMIN',
  })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  @ApiUnprocessableEntityResponse({
    description: 'Otra petición cambió el convenio del paciente a la vez',
  })
  put(
    @Param('patientId', patientIdPipe) patientId: string,
    @Body() dto: AssignPatientAgreementDto,
    @Req() req: { user: TenantJwtPayload },
  ): Promise<PatientAgreementView> {
    return this.assignAgreement.execute(patientId, dto, {
      userId: req.user.sub,
      role: req.user.role,
    });
  }

  @Audit(audit('AGREEMENT_REMOVED'))
  @Delete()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Retirar el convenio vigente del paciente (DX-105)',
  })
  @ApiNoContentResponse({ description: 'Retirado' })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado o sin convenio asignado',
  })
  async remove(
    @Param('patientId', patientIdPipe) patientId: string,
    @Req() req: { user: TenantJwtPayload },
  ): Promise<void> {
    await this.removeAgreement.execute(patientId, req.user.sub);
  }
}
