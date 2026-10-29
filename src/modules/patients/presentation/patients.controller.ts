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
  Put,
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
import {
  NO_COVERAGE,
  PatientCoverageFlags,
  type CoverageSummary,
} from '../../patient-coverages/application/patient-coverage-flags';
import {
  PatientAgreementFlags,
  type AgreementSummary,
} from '../../patient-agreements/application/patient-agreement-flags';
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
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  CLINIC_SETTINGS_WRITE_ROLES,
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
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  consentEvidenceFrom,
  EvidenceRequest,
} from '../../data-consents/presentation/consent-evidence';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  GetPatientSettingsUseCase,
  UpdatePatientSettingsUseCase,
  type PatientSettings,
} from '../application/use-cases/patient-settings.use-cases';
import { PatientSettingsDto } from './dto/patient-settings.dto';
import {
  GetDocumentTypeNamesUseCase,
  UpdateDocumentTypeNamesUseCase,
  type DocumentTypeNamesSettings,
} from '../application/use-cases/document-type-names.use-cases';
import { DocumentTypeNamesDto } from './dto/document-type-names.dto';

export const CLINIC_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar la mayoría de edad.';

export const DOCUMENT_TYPE_NAMES_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar los nombres de los documentos.';

type ListPatientsWithCoverageOutput = Omit<ListPatientsOutput, 'items'> & {
  items: (Patient & { coverage: CoverageSummary })[];
};

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
    // DX-153: resumen de cobertura de la ficha y del listado.
    private readonly coverageFlags: PatientCoverageFlags,
    private readonly agreementFlags: PatientAgreementFlags,
    // DX-328: mayoría de edad de la clínica.
    private readonly getSettings: GetPatientSettingsUseCase,
    private readonly updateSettings: UpdatePatientSettingsUseCase,
    // DX-327: nombre local de cada tipo de documento de la clínica.
    private readonly getDocumentTypeNames: GetDocumentTypeNamesUseCase,
    private readonly updateDocumentTypeNames: UpdateDocumentTypeNamesUseCase,
    private readonly tenantContext: TenantContextService,
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
  @ApiOkResponse({
    type: ListPatientsResponseDto,
    description:
      'Cada paciente lleva `coverage` (DX-153): resumen de su cobertura principal, calculado para la página entera en un número fijo de consultas. `payerId` limita a quienes tienen alguna cobertura viva de ese pagador.',
  })
  async list(
    @Query() query: ListPatientsQueryDto,
  ): Promise<ListPatientsWithCoverageOutput> {
    const result = await this.listPatients.execute({
      query: query.query,
      payerId: query.payerId,
      page: query.page,
      pageSize: query.pageSize,
    });
    const coverage = await this.coverageFlags.forPatients(
      result.items.map((p) => p.id),
    );
    return {
      ...result,
      items: result.items.map((p) => ({
        ...p,
        coverage: coverage.get(p.id) ?? NO_COVERAGE,
      })),
    };
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

  // Antes de `@Get(':id')`, como `retention/expiring`: si no, `settings` se
  // leería como el id de un paciente.
  @Get('settings')
  @ApiOperation({ summary: 'Mayoría de edad de la clínica (DX-328)' })
  @ApiOkResponse({ type: PatientSettingsDto })
  settings(): Promise<PatientSettings> {
    return this.getSettings.execute();
  }

  @Put('settings')
  @Roles(...CLINIC_SETTINGS_WRITE_ROLES)
  @RolesDeniedMessage(CLINIC_SETTINGS_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary:
      'Cambia la mayoría de edad de la clínica (14–21 años); queda en la auditoría',
    description:
      'DX-328. Aplica desde la siguiente petición. Si el valor no cambia, ' +
      'responde 200 sin evento de auditoría.',
  })
  @ApiOkResponse({ type: PatientSettingsDto })
  @ApiBadRequestResponse({ description: 'Fuera de 14–21 o no entero' })
  @ApiForbiddenResponse({ description: CLINIC_SETTINGS_FORBIDDEN_MESSAGE })
  updateClinicSettings(
    @Body() dto: PatientSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<PatientSettings> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.updateSettings.execute({ majorityAge: dto.majorityAge }, ctx);
  }

  // También antes de `@Get(':id')`, por lo mismo que `settings`.
  @Get('document-type-names')
  @ApiOperation({
    summary: 'Nombre local de cada tipo de documento de la clínica (DX-327)',
    description:
      'Null = sin nombre local: se usa el genérico. El nombre visible de un ' +
      'documento es la etiqueta del paciente, si no el nombre local de la ' +
      'clínica para su tipo, si no el genérico (R17). La importación de ' +
      'pacientes reconoce también estos nombres, antes que los genéricos (R19).',
  })
  @ApiOkResponse({ type: DocumentTypeNamesDto })
  documentTypeNames(): Promise<DocumentTypeNamesSettings> {
    return this.getDocumentTypeNames.execute();
  }

  @Put('document-type-names')
  @Roles(...CLINIC_SETTINGS_WRITE_ROLES)
  @RolesDeniedMessage(DOCUMENT_TYPE_NAMES_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary: 'Nombre local de cada tipo de documento de la clínica (DX-327)',
    description:
      'Sustituye los cinco nombres: una clave ausente o null queda sin nombre ' +
      'local. Hasta 60 caracteres. Dos tipos no pueden tener el mismo nombre ' +
      'ni el nombre genérico o el código de otro tipo (sin distinguir ' +
      'mayúsculas, tildes ni puntuación, en cualquier escritura). Cambia el ' +
      'nombre visible (R17) y lo que reconoce la importación (R19); no toca ' +
      'ningún paciente. Si nada cambia, 200 sin evento de auditoría.',
  })
  @ApiOkResponse({ type: DocumentTypeNamesDto })
  @ApiBadRequestResponse({
    description: 'Nombre ambiguo, sin letras ni números o de más de 60',
  })
  @ApiForbiddenResponse({ description: DOCUMENT_TYPE_NAMES_FORBIDDEN_MESSAGE })
  updateClinicDocumentTypeNames(
    @Body() dto: DocumentTypeNamesDto,
    @Req() req: AuditableRequest,
  ): Promise<DocumentTypeNamesSettings> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.updateDocumentTypeNames.execute(dto.names, ctx);
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
      'La ficha con `balance` (DX-150): marca «Saldo vencido» y días para todos los roles; el importe, solo ADMIN y RECEPTION. Con `coverage` (DX-153): resumen de la cobertura principal. Y con `agreement` (DX-105): resumen del convenio vigente.',
  })
  async get(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<
    Patient & {
      balance: OverdueBalance;
      coverage: CoverageSummary;
      agreement: AgreementSummary;
    }
  > {
    const patient = await this.getPatient.execute(id);
    const balance = await this.balanceFlags.forPatient(
      patient.id,
      req.user.role,
    );
    const coverage = await this.coverageFlags.forPatient(patient.id);
    const agreement = await this.agreementFlags.forPatient(patient.id);
    return { ...patient, balance, coverage, agreement };
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
