import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CreatePatientDto } from './dto/create-patient.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';
import { ListPatientsQueryDto } from './dto/list-patients-query.dto';
import { PatientDetailDto, PatientDto } from './dto/patient.dto';
import { PatientBalanceFlags } from '../../collections/application/patient-balance-flags';
import type { OverdueBalance } from '../../collections/domain/overdue-balance';
import { ListPatientsResponseDto } from './dto/list-patients-response.dto';
import { CreatePatientUseCase } from '../application/use-cases/create-patient.use-case';
import {
  ListPatientsUseCase,
  ListPatientsOutput,
} from '../application/use-cases/list-patients.use-case';
import { GetPatientUseCase } from '../application/use-cases/get-patient.use-case';
import { UpdatePatientUseCase } from '../application/use-cases/update-patient.use-case';
import { Patient } from '../domain/entities/patient.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  PATIENT_RETENTION_ROLES,
  PATIENT_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import {
  ClinicalRecordRetentionErrorDto,
  ListRetentionExpiringQueryDto,
  ListRetentionExpiringResponseDto,
  PartialSuppressionDto,
  SetRetentionExtensionDto,
} from './dto/retention.dto';
import {
  ArchivePatientUseCase,
  ListRetentionExpiringUseCase,
  PartiallySuppressPatientUseCase,
  RETENTION_EXPIRING_MAX_PAGE_SIZE,
  SetRetentionExtensionUseCase,
} from '../application/use-cases/retention.use-cases';
import { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import {
  consentEvidenceFrom,
  EvidenceRequest,
} from '../../data-consents/presentation/consent-evidence';
import { Audit } from '../../audit/presentation/audit.decorator';

// RolesGuard (a nivel de clase) ya rechazó cualquier token sin rol de clínica
// (los de plataforma), así que aquí `user` es siempre un token de clínica.
type AuthenticatedRequest = EvidenceRequest & { user: TenantJwtPayload };

@ApiTags('patients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_ROLES)
@Controller('patients')
export class PatientsController {
  constructor(
    private readonly createPatient: CreatePatientUseCase,
    private readonly listPatients: ListPatientsUseCase,
    private readonly getPatient: GetPatientUseCase,
    private readonly updatePatient: UpdatePatientUseCase,
    private readonly archivePatient: ArchivePatientUseCase,
    private readonly setRetention: SetRetentionExtensionUseCase,
    private readonly partiallySuppress: PartiallySuppressPatientUseCase,
    private readonly listRetentionExpiring: ListRetentionExpiringUseCase,
    // DX-150: marca «Saldo vencido» de la cabecera de la ficha.
    private readonly balanceFlags: PatientBalanceFlags,
  ) {}

  @Audit({
    action: 'CREATE',
    resource: 'PATIENT',
    resourceId: { response: 'id' },
    patient: { response: 'id' },
  })
  @Post()
  @ApiOperation({
    summary: 'Crear paciente (con anamnesis v1 opcional)',
    description:
      '`medicalHistory` crea la versión 1 de la historia clínica y solo lo ' +
      'pueden enviar los roles clínicos (DENTIST, ASSISTANT, ADMIN). ' +
      'RECEPTION crea el paciente sin ese campo; si lo envía, 403.',
  })
  @ApiCreatedResponse({ type: PatientDto })
  @ApiForbiddenResponse({
    description:
      'Rol sin acceso a pacientes, o rol no clínico (RECEPTION) enviando ' +
      '`medicalHistory`',
  })
  create(
    @Body() dto: CreatePatientDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Patient> {
    return this.createPatient.execute({
      ...dto,
      birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
      consentEvidence: consentEvidenceFrom(req),
      createdById: req.user.sub,
      actorRole: req.user.role,
    });
  }

  @Get()
  @ApiOkResponse({ type: ListPatientsResponseDto })
  list(@Query() query: ListPatientsQueryDto): Promise<ListPatientsOutput> {
    return this.listPatients.execute({
      query: query.query,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get('retention/expiring')
  @Roles(...PATIENT_RETENTION_ROLES)
  @ApiOperation({
    summary: 'Historias que salen de retención legal (solo ADMIN)',
    description:
      'DX-039. Pacientes vivos cuya HC ya no está en retención o deja de ' +
      'estarlo dentro de `withinDays` (NONE: 15 años, DOUBLE: 30 años desde ' +
      'la última atención; PERMANENT nunca sale). Orden: la que antes vence. ' +
      'Paginada, con tope. Solo informa: no purga nada.',
  })
  @ApiOkResponse({ type: ListRetentionExpiringResponseDto })
  @ApiForbiddenResponse({ description: 'Rol distinto de ADMIN' })
  async retentionExpiring(
    @Query() query: ListRetentionExpiringQueryDto,
  ): Promise<ListPatientsOutput> {
    const page = query.page ?? 1;
    const result = await this.listRetentionExpiring.execute({
      withinDays: query.withinDays ?? 90,
      page,
      pageSize: query.pageSize ?? 20,
    });
    return {
      ...result,
      page,
      pageSize: Math.min(
        query.pageSize ?? 20,
        RETENTION_EXPIRING_MAX_PAGE_SIZE,
      ),
    };
  }

  @Audit({
    action: 'VIEW',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
  })
  @Get(':id')
  @ApiOkResponse({
    type: PatientDetailDto,
    description:
      'La ficha con `balance` (DX-150): marca «Saldo vencido» y días para todos los roles; el importe, solo ADMIN y RECEPTION.',
  })
  async get(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<Patient & { balance: OverdueBalance }> {
    const patient = await this.getPatient.execute(id);
    const balance = await this.balanceFlags.forPatient(
      patient.id,
      req.user.role,
    );
    return { ...patient, balance };
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
  })
  @Patch(':id')
  @ApiOkResponse({ type: PatientDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePatientDto,
  ): Promise<Patient> {
    return this.updatePatient.execute(id, {
      ...dto,
      // Tres casos, no dos: ausente = no tocar, `null` = vaciar la columna
      // (es nullable), y una fecha = parsearla. El guard anterior sólo miraba
      // `undefined`, así que un `null` caía en `new Date(null)` y escribía
      // 1970-01-01 en vez de vaciar.
      birthDate:
        dto.birthDate === undefined || dto.birthDate === null
          ? dto.birthDate
          : new Date(dto.birthDate),
    });
  }

  @Audit({
    action: 'DELETE',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
  })
  @Delete(':id')
  @HttpCode(204)
  @Roles(...PATIENT_RETENTION_ROLES)
  @ApiOperation({
    summary: 'Archivar paciente (borrado blando, solo ADMIN)',
    description:
      'DX-039. Retira al paciente de los listados (`deletedAt`); su HC se ' +
      'conserva siempre. Si la HC está en retención legal (15 años desde la ' +
      'última atención, 30 con DOUBLE, siempre con PERMANENT) responde 409 ' +
      '`CLINICAL_RECORD_RETENTION` con la fecha hasta la que se conserva. Un ' +
      'paciente sin atenciones clínicas se archiva, salvo que tenga citas ' +
      'programadas o confirmadas (409 `PATIENT_HAS_PENDING_APPOINTMENTS`: ' +
      'hay que cancelarlas o cerrarlas antes).',
  })
  @ApiNoContentResponse({ description: 'Paciente archivado' })
  @ApiConflictResponse({
    type: ClinicalRecordRetentionErrorDto,
    description:
      'HC en retención legal (`CLINICAL_RECORD_RETENTION`) o citas abiertas ' +
      '(`PATIENT_HAS_PENDING_APPOINTMENTS`, sin `retentionUntil`)',
  })
  @ApiForbiddenResponse({ description: 'Rol distinto de ADMIN' })
  async archive(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.archivePatient.execute(id);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
    reason: 'RETENTION_EXTENSION_CHANGED',
  })
  @Patch(':id/retention')
  @Roles(...PATIENT_RETENTION_ROLES)
  @ApiOperation({
    summary: 'Cambiar la retención extendida de la HC (solo ADMIN)',
    description:
      'DX-039. NONE (15 años), DOUBLE (30) o PERMANENT. Motivo obligatorio: ' +
      'queda con el autor y la fecha en el rastro de retención del paciente; ' +
      'el registro de auditoría guarda quién y cuándo (sin el motivo).',
  })
  @ApiOkResponse({ type: PatientDto })
  @ApiForbiddenResponse({ description: 'Rol distinto de ADMIN' })
  changeRetention(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRetentionExtensionDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Patient> {
    return this.setRetention.execute(id, {
      value: dto.retentionExtended,
      reason: dto.reason,
      actorId: req.user.sub,
    });
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PATIENT',
    resourceId: { param: 'id' },
    patient: { param: 'id' },
    reason: 'PARTIAL_SUPPRESSION',
  })
  @Post(':id/partial-suppression')
  @HttpCode(200)
  @Roles(...PATIENT_RETENTION_ROLES)
  @ApiOperation({
    summary: 'Supresión parcial de datos no clínicos (solo ADMIN)',
    description:
      'DX-039. Para un paciente cuya HC está en retención (y por eso no se ' +
      'puede archivar): vacía teléfono, email, dirección, notas ' +
      'administrativas y contacto de emergencia, y retira la autorización ' +
      'de marketing vigente. Conserva la HC y la identificación que exige ' +
      '(nombre, documento, nacimiento, sexo, residencia, estado civil, ' +
      'ocupación, aseguradora, médico y acudiente). Motivo obligatorio. 409 ' +
      '`NOT_UNDER_RETENTION` si la HC no está en retención (se archiva).',
  })
  @ApiOkResponse({ type: PatientDto })
  @ApiConflictResponse({ description: 'La HC no está en retención' })
  @ApiForbiddenResponse({ description: 'Rol distinto de ADMIN' })
  suppress(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PartialSuppressionDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Patient> {
    return this.partiallySuppress.execute(id, {
      reason: dto.reason,
      actorId: req.user.sub,
    });
  }
}
