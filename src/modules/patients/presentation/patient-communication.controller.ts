import { Audit } from '../../audit/presentation/audit.decorator';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
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
import { PATIENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  GetPatientCommunicationUseCase,
  GetPatientOptOutWarningsUseCase,
  UpdatePatientCommunicationUseCase,
} from '../application/use-cases/patient-communication.use-cases';
import {
  PatientCommunicationDto,
  PatientOptOutMatchWarningDto,
  UpdatePatientCommunicationDto,
} from './dto/patient-communication.dto';

export const COMMUNICATION_FORBIDDEN_MESSAGE =
  'Solo recepción o un administrador pueden cambiar el canal de comunicación del paciente.';

const patientIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException('El identificador del paciente no es válido.'),
});

/**
 * Bloque «Comunicaciones» de la ficha (DX-128): canal de los avisos
 * automáticos, móvil validado, opt-in de WhatsApp y baja de recordatorios.
 * Lo ven los 4 roles (el profesional, en solo lectura); lo cambian recepción
 * y ADMIN. La preferencia no es un dato de salud. El cambio lo audita el caso
 * de uso (necesita el antes para saber qué cambió y de dónde salió).
 */
@ApiTags('patients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_ROLES)
@Controller('patients/:id/communication')
export class PatientCommunicationController {
  constructor(
    private readonly getCommunication: GetPatientCommunicationUseCase,
    private readonly getWarnings: GetPatientOptOutWarningsUseCase,
    private readonly updateCommunication: UpdatePatientCommunicationUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Comunicaciones del paciente (DX-128)' })
  @ApiOkResponse({ type: PatientCommunicationDto })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  get(
    @Param('id', patientIdPipe) id: string,
  ): Promise<PatientCommunicationDto> {
    return this.getCommunication.execute(id);
  }

  @Get('opt-out-warnings')
  @Roles(ClinicRole.RECEPTION, ClinicRole.ADMIN)
  @ApiOperation({
    summary: 'Últimos20 avisos de baja por móvil compartido (DX-214)',
  })
  @ApiOkResponse({ type: PatientOptOutMatchWarningDto, isArray: true })
  @ApiForbiddenResponse({ description: 'Solo recepción y ADMIN.' })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  @Audit({
    action: 'VIEW',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
    reason: 'REMINDER_OPT_OUT_WARNINGS',
  })
  warnings(
    @Param('id', patientIdPipe) id: string,
  ): Promise<PatientOptOutMatchWarningDto[]> {
    return this.getWarnings.execute(id);
  }

  @Patch()
  @Roles(ClinicRole.RECEPTION, ClinicRole.ADMIN)
  @RolesDeniedMessage(COMMUNICATION_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary: 'Cambiar canal, móvil, opt-in de WhatsApp o baja (DX-128)',
    description:
      'Solo recepción y ADMIN. El móvil se normaliza a E.164; sin «+» se lee con el prefijo telefónico por defecto de la sede. ' +
      'WHATSAPP exige un móvil válido (400 `WHATSAPP_REQUIRES_VALID_MOBILE`). ' +
      'Queda en la auditoría con el autor, los campos y el origen.',
  })
  @ApiOkResponse({ type: PatientCommunicationDto })
  @ApiBadRequestResponse({ description: 'Validación (mensaje en español)' })
  @ApiForbiddenResponse({ description: COMMUNICATION_FORBIDDEN_MESSAGE })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  async update(
    @Param('id', patientIdPipe) id: string,
    @Body() dto: UpdatePatientCommunicationDto,
    @Req() req: AuditableRequest,
  ): Promise<PatientCommunicationDto> {
    const ctx = auditRequestContext(req, this.tenantContext);
    // RolesGuard ya exigió un token de clínica: sin contexto no se llega aquí.
    if (!ctx) throw new Error('No audit context');
    return this.updateCommunication.execute(id, dto, ctx);
  }
}
