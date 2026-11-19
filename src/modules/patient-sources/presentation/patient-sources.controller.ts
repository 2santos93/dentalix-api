import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  PATIENT_ROLES,
  PATIENT_SOURCE_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { PatientSourcesUseCases } from '../application/patient-sources.use-cases';
import {
  PATIENT_SOURCE_MESSAGES,
  type PatientSourceEntity,
} from '../domain/patient-source';
import type { PatientAcquisitionView } from '../domain/patient-source-repository.port';
import {
  CreatePatientSourceDto,
  ListPatientSourcesQueryDto,
  PatientAcquisitionDto,
  PatientSourceDto,
  UpdatePatientSourceDto,
} from './dto/patient-source.dto';

// «¿Cómo nos conoció?» (DX-172): el catálogo de la clínica. Lo lee quien da
// de alta o edita pacientes; crear, renombrar y (des)activar, solo ADMIN, con
// su evento CLINIC_SETTINGS (antes/después) en la misma transacción. No se
// borran: un paciente las referencia.
@ApiTags('patient-sources')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_ROLES)
@Controller('patient-sources')
export class PatientSourcesController {
  constructor(
    private readonly sources: PatientSourcesUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Fuentes de captación de la clínica («¿Cómo nos conoció?»)',
    description:
      'Las activas, o todas con `includeInactive=true`. Una clínica sin ninguna recibe las de por defecto (Recomendación de paciente, Instagram, Facebook, Google, Marketplace de reservas, Convenio/empresa, Profesional externo, Paso por la sede, Otro).',
  })
  @ApiOkResponse({ type: [PatientSourceDto] })
  @ApiForbiddenResponse({ description: 'Rol sin acceso a pacientes' })
  list(
    @Query() query: ListPatientSourcesQueryDto,
  ): Promise<PatientSourceEntity[]> {
    return this.sources.list(query.includeInactive ?? false);
  }

  @Post()
  @Roles(...PATIENT_SOURCE_WRITE_ROLES)
  @RolesDeniedMessage(PATIENT_SOURCE_MESSAGES.adminOnly)
  @ApiOperation({ summary: 'Crear una fuente propia (solo ADMIN)' })
  @ApiCreatedResponse({ type: PatientSourceDto })
  @ApiBadRequestResponse({ description: PATIENT_SOURCE_MESSAGES.nameLength })
  @ApiConflictResponse({ description: PATIENT_SOURCE_MESSAGES.nameTaken })
  @ApiForbiddenResponse({ description: PATIENT_SOURCE_MESSAGES.adminOnly })
  create(
    @Body() dto: CreatePatientSourceDto,
    @Req() req: AuditableRequest,
  ): Promise<PatientSourceEntity> {
    return this.sources.create(
      { name: dto.name, kind: dto.kind },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Patch(':id')
  @Roles(...PATIENT_SOURCE_WRITE_ROLES)
  @RolesDeniedMessage(PATIENT_SOURCE_MESSAGES.adminOnly)
  @ApiOperation({
    summary: 'Renombrar o (des)activar una fuente (solo ADMIN)',
    description:
      'El tipo no cambia. Desactivarla la quita del alta; los pacientes que la tienen y el informe la conservan.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PatientSourceDto })
  @ApiBadRequestResponse({ description: PATIENT_SOURCE_MESSAGES.nameLength })
  @ApiNotFoundResponse({ description: PATIENT_SOURCE_MESSAGES.notFound })
  @ApiConflictResponse({ description: PATIENT_SOURCE_MESSAGES.nameTaken })
  @ApiForbiddenResponse({ description: PATIENT_SOURCE_MESSAGES.adminOnly })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePatientSourceDto,
    @Req() req: AuditableRequest,
  ): Promise<PatientSourceEntity> {
    return this.sources.update(
      id,
      { name: dto.name, isActive: dto.isActive },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}

// La captación de un paciente en su ficha: de dónde vino, quién lo recomendó
// y a cuántos ha recomendado él. Dato personal del personal de la clínica
// (nunca el portal): lectura auditada como la ficha.
@ApiTags('patients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_ROLES)
@Controller('patients')
export class PatientAcquisitionController {
  constructor(private readonly sources: PatientSourcesUseCases) {}

  @Audit({
    action: 'VIEW',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
    reason: 'PATIENT_ACQUISITION',
  })
  @Get(':id/acquisition')
  @ApiOperation({
    summary: '«¿Cómo nos conoció?» del paciente y a quién ha recomendado',
    description:
      'DX-172. La fuente, el paciente que lo recomendó o el profesional externo que lo derivó, y cuántos pacientes (vivos) ha recomendado él, con los 10 más recientes. 404 como `GET /patients/:id`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PatientAcquisitionDto })
  @ApiBadRequestResponse({ description: 'Id que no es UUID' })
  @ApiNotFoundResponse({ description: 'Paciente inexistente en la clínica' })
  acquisition(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PatientAcquisitionView> {
    return this.sources.acquisition(id);
  }
}
