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
  ApiExtraModels,
  ApiNoContentResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
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
  LivePublicLinksDto,
  PartialSuppressionDto,
  SetRetentionExtensionDto,
} from './dto/retention.dto';
import {
  ArchivePatientUseCase,
  CountPatientLivePublicLinksUseCase,
  ListRetentionExpiringUseCase,
  type LivePublicLinksSummary,
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
  GetRetentionSettingsUseCase,
  UpdateRetentionSettingsUseCase,
  type RetentionSettings,
  type RetentionSettingsUpdateResult,
} from '../application/use-cases/retention-settings.use-cases';
import {
  RetentionReductionUnconfirmedErrorDto,
  RetentionSettingsBusyErrorDto,
  RetentionSettingsDto,
  RetentionSettingsUpdateResultDto,
  UpdateRetentionSettingsDto,
} from './dto/retention-settings.dto';
import {
  GetDocumentTypeNamesUseCase,
  UpdateDocumentTypeNamesUseCase,
  type DocumentTypeNamesSettings,
} from '../application/use-cases/document-type-names.use-cases';
import { DocumentTypeNamesDto } from './dto/document-type-names.dto';
import { DOCUMENT_TYPE_NAMES_FORBIDDEN_MESSAGE } from '../domain/document-type-names';
import { DocumentTypeNamesReader } from '../domain/ports/document-type-names-repository.port';
import {
  withDocTypeName,
  type WithDocTypeName,
} from './doc-type-name.presenter';
import { DefaultPhoneRegionReader } from '../domain/ports/default-phone-region-reader.port';
import {
  withPhoneInternational,
  type WithPhoneInternational,
} from '../../../shared/phone/with-phone-international';

export const CLINIC_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar la mayoría de edad.';

export const RETENTION_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar el plazo de conservación.';

type ListPatientsWithCoverageOutput = Omit<ListPatientsOutput, 'items'> & {
  items: WithPhoneInternational<
    WithDocTypeName<Patient & { coverage: CoverageSummary }>
  >[];
};

/**
 * DX-327 (R17): cada paciente de la respuesta con su `docTypeName`. DX-387:
 * y con su `phoneInternational`.
 */
type PatientOutput = WithPhoneInternational<WithDocTypeName<Patient>>;
type PatientPageOutput = Omit<ListPatientsOutput, 'items'> & {
  items: PatientOutput[];
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
    private readonly countLivePublicLinks: CountPatientLivePublicLinksUseCase,
    private readonly setRetention: SetRetentionExtensionUseCase,
    private readonly partiallySuppress: PartiallySuppressPatientUseCase,
    private readonly listRetentionExpiring: ListRetentionExpiringUseCase,
    // DX-330: plazo de conservación de la HC de la clínica.
    private readonly getRetentionSettings: GetRetentionSettingsUseCase,
    private readonly updateRetentionSettings: UpdateRetentionSettingsUseCase,
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
    // DX-327 (R17): nombres locales para el `docTypeName`, una lectura por petición.
    private readonly documentTypeNamesReader: DocumentTypeNamesReader,
    // DX-387: región del `phoneInternational`, una lectura por petición.
    private readonly phoneRegionReader: DefaultPhoneRegionReader,
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
  async create(
    @Body() dto: CreatePatientDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientOutput> {
    const patient = await this.createPatient.execute({
      ...dto,
      // DX-327 (R9): un código anterior llega como su genérico, sin etiqueta.
      docType: dto.docType,
      birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
      consentEvidence: consentEvidenceFrom(req),
      createdById: req.user.sub,
      actorRole: req.user.role,
    });
    return this.presentOne(patient);
  }

  /**
   * Los nombres de documento (DX-327, R17) y la región del teléfono de la
   * sede (DX-387), una sola vez por petición para todas las filas.
   */
  private async presenter(): Promise<
    <T extends Patient>(
      patient: T,
    ) => WithPhoneInternational<WithDocTypeName<T>>
  > {
    const [names, region] = await Promise.all([
      this.documentTypeNamesReader.get(),
      this.phoneRegionReader.defaultPhoneRegion(),
    ]);
    return (patient) =>
      withPhoneInternational(withDocTypeName(patient, names), region);
  }

  /** Un paciente con su `docTypeName` y su `phoneInternational`. */
  private async presentOne(patient: Patient): Promise<PatientOutput> {
    return (await this.presenter())(patient);
  }

  /** Una página con una sola lectura de nombres y región, no una por fila. */
  private async presentPage<T extends { items: Patient[] }>(
    page: T,
  ): Promise<Omit<T, 'items'> & { items: PatientOutput[] }> {
    const present = await this.presenter();
    return { ...page, items: page.items.map((p) => present(p)) };
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
    const [coverage, present] = await Promise.all([
      this.coverageFlags.forPatients(result.items.map((p) => p.id)),
      this.presenter(),
    ]);
    return {
      ...result,
      items: result.items.map((p) =>
        present({ ...p, coverage: coverage.get(p.id) ?? NO_COVERAGE }),
      ),
    };
  }

  @Get('retention/expiring')
  @Roles(...PATIENT_RETENTION_ROLES)
  @ApiOperation({
    summary: 'Historias que salen de retención (solo ADMIN)',
    description:
      'DX-039. Pacientes vivos cuya HC ya no está en retención o deja de ' +
      'estarlo dentro de `withinDays` (NONE: el plazo de la clínica, DOUBLE: ' +
      'el doble, desde la última atención; PERMANENT nunca sale). Una ' +
      'reducción del plazo no adelanta la lista: la fecha de fin que una ' +
      'historia ya tenía se respeta. Orden: `lastAttentionAt` ascendente; con ' +
      'esa fecha fijada, una fila puede aparecer más tarde que su última ' +
      'atención, y `retentionUntil` es la fecha efectiva. Paginada, con ' +
      'tope. Solo informa: no purga nada.',
  })
  @ApiOkResponse({ type: ListRetentionExpiringResponseDto })
  @ApiForbiddenResponse({ description: 'Rol distinto de ADMIN' })
  async retentionExpiring(
    @Query() query: ListRetentionExpiringQueryDto,
  ): Promise<PatientPageOutput> {
    const page = query.page ?? 1;
    const result = await this.listRetentionExpiring.execute({
      withinDays: query.withinDays ?? 90,
      page,
      pageSize: query.pageSize ?? 20,
    });
    return this.presentPage({
      ...result,
      page,
      pageSize: Math.min(
        query.pageSize ?? 20,
        RETENTION_EXPIRING_MAX_PAGE_SIZE,
      ),
    });
  }

  // DX-330: antes de `@Get(':id')`, como `retention/expiring`.
  @Get('retention/settings')
  @ApiOperation({
    summary: 'Plazo de conservación de la historia clínica de la clínica',
    description:
      'DX-330. `effectiveYears` es el plazo que rige (el guardado, nunca por ' +
      'debajo del mínimo de plataforma). `correctionWindow` aparece durante ' +
      'las 24 horas siguientes a una subida.',
  })
  @ApiOkResponse({ type: RetentionSettingsDto })
  retentionSettings(): Promise<RetentionSettings> {
    return this.getRetentionSettings.execute();
  }

  @Put('retention/settings')
  @Roles(...CLINIC_SETTINGS_WRITE_ROLES)
  @RolesDeniedMessage(RETENTION_SETTINGS_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary:
      'Cambia el plazo de conservación de la historia clínica; queda en la auditoría',
    description:
      'DX-330. Subir aplica desde la siguiente petición. Reducir pide ' +
      '`confirmReduction: true`: las historias que ya estaban en retención ' +
      'mantienen su fecha de fin y el plazo nuevo se aplica al resto y a las ' +
      'atenciones nuevas. Si el valor no cambia, responde 200 sin evento de ' +
      'auditoría.',
  })
  @ApiOkResponse({ type: RetentionSettingsUpdateResultDto })
  @ApiBadRequestResponse({
    description:
      'No entero o fuera del rango del mínimo de plataforma al máximo',
  })
  @ApiForbiddenResponse({ description: RETENTION_SETTINGS_FORBIDDEN_MESSAGE })
  @ApiExtraModels(
    RetentionReductionUnconfirmedErrorDto,
    RetentionSettingsBusyErrorDto,
  )
  @ApiConflictResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(RetentionReductionUnconfirmedErrorDto) },
        { $ref: getSchemaPath(RetentionSettingsBusyErrorDto) },
      ],
    },
    description:
      '`RETENTION_REDUCTION_UNCONFIRMED`: reducir sin confirmar, sin guardar nada. ' +
      '`RETENTION_SETTINGS_BUSY`: otra operación con los pacientes de la clínica en curso, o la reducción tarda demasiado; no se guardó nada.',
  })
  updateRetention(
    @Body() dto: UpdateRetentionSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<RetentionSettingsUpdateResult> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.updateRetentionSettings.execute(
      {
        clinicalRecordRetentionYears: dto.clinicalRecordRetentionYears,
        confirmReduction: dto.confirmReduction,
      },
      ctx,
    );
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
    PatientOutput & {
      balance: OverdueBalance;
      coverage: CoverageSummary;
      agreement: AgreementSummary;
    }
  > {
    const patient = await this.presentOne(await this.getPatient.execute(id));
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
  async update(
    @Param('id') id: string,
    @Body() dto: UpdatePatientDto,
  ): Promise<PatientOutput> {
    const patient = await this.updatePatient.execute(id, {
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
    return this.presentOne(patient);
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
      'conserva siempre. Si la HC está en retención (el plazo de la ' +
      'clínica desde la última atención, el doble con DOUBLE, siempre con ' +
      'PERMANENT) responde 409 ' +
      '`CLINICAL_RECORD_RETENTION` con la fecha hasta la que se conserva. Un ' +
      'paciente sin atenciones clínicas se archiva, salvo que tenga citas ' +
      'programadas o confirmadas (409 `PATIENT_HAS_PENDING_APPOINTMENTS`: ' +
      'hay que cancelarlas o cerrarlas antes). DX-461: en la misma ' +
      'transacción anula sus enlaces públicos vivos (ofertas de hueco, firma ' +
      'y presupuesto a distancia, copia del PDF firmado y anamnesis): sus ' +
      'rutas públicas responden como a un enlace caducado y desarchivar no ' +
      'los reactiva. Si anuló alguno, queda un audit_event (UPDATE de ' +
      'PATIENT, `PATIENT_ARCHIVED_LINKS_REVOKED`) con cuántos de cada tipo.',
  })
  @ApiNoContentResponse({ description: 'Paciente archivado' })
  @ApiConflictResponse({
    type: ClinicalRecordRetentionErrorDto,
    description:
      'HC en retención (`CLINICAL_RECORD_RETENTION`) o citas abiertas ' +
      '(`PATIENT_HAS_PENDING_APPOINTMENTS`, sin `retentionUntil`)',
  })
  @ApiForbiddenResponse({ description: 'Rol distinto de ADMIN' })
  async archive(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuditableRequest,
  ): Promise<void> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    await this.archivePatient.execute(id, ctx);
  }

  @Get(':id/live-public-links')
  @Roles(...PATIENT_RETENTION_ROLES)
  @ApiOperation({
    summary: 'Enlaces públicos vivos que anularía archivar (solo ADMIN)',
    description:
      'DX-461. Para avisar en el diálogo de archivar: cuántas ofertas de ' +
      'hueco, firmas y presupuestos a distancia, copias del PDF firmado y ' +
      'anamnesis enviados siguen sirviendo hoy (sin usar, sin anular y sin ' +
      'caducar), en todas las sedes: el paciente es de la clínica. Solo ' +
      'números. 404 si el paciente no existe en la clínica o ya está ' +
      'archivado.',
  })
  @ApiOkResponse({ type: LivePublicLinksDto })
  @ApiNotFoundResponse({ description: 'Paciente inexistente o archivado' })
  @ApiForbiddenResponse({ description: 'Rol distinto de ADMIN' })
  livePublicLinks(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LivePublicLinksSummary> {
    return this.countLivePublicLinks.execute(id);
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
      'DX-039. NONE (el plazo de la clínica), DOUBLE (el doble) o PERMANENT. Motivo obligatorio: ' +
      'queda con el autor y la fecha en el rastro de retención del paciente; ' +
      'el registro de auditoría guarda quién y cuándo (sin el motivo).',
  })
  @ApiOkResponse({ type: PatientDto })
  @ApiForbiddenResponse({ description: 'Rol distinto de ADMIN' })
  async changeRetention(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRetentionExtensionDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientOutput> {
    return this.presentOne(
      await this.setRetention.execute(id, {
        value: dto.retentionExtended,
        reason: dto.reason,
        actorId: req.user.sub,
      }),
    );
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
      'ocupación, aseguradora, médico y tutor). Motivo obligatorio. 409 ' +
      '`NOT_UNDER_RETENTION` si la HC no está en retención (se archiva).',
  })
  @ApiOkResponse({ type: PatientDto })
  @ApiConflictResponse({ description: 'La HC no está en retención' })
  @ApiForbiddenResponse({ description: 'Rol distinto de ADMIN' })
  async suppress(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PartialSuppressionDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientOutput> {
    return this.presentOne(
      await this.partiallySuppress.execute(id, {
        reason: dto.reason,
        actorId: req.user.sub,
      }),
    );
  }
}
