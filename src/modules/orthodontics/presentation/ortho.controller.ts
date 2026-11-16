import {
  Body,
  Controller,
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
  ApiForbiddenResponse,
  ApiHeader,
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
  ORTHO_FOLLOW_UP_ROLES,
  ORTHO_READ_ROLES,
  ORTHO_SETTINGS_READ_ROLES,
  ORTHO_SETTINGS_WRITE_ROLES,
  ORTHO_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  auditRequestContext,
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import {
  OrthoCaseUseCases,
  OrthoFollowUpUseCase,
  OrthoSettingsUseCases,
  OrthoVisitUseCases,
} from '../application/use-cases/ortho.use-cases';
import type {
  OrthoCaseView,
  OrthoFollowUpPage,
  OrthoSettings,
  OrthoVisitView,
} from '../domain/entities';
import {
  ChangeOrthoCaseStatusDto,
  CreateOrthoCaseDto,
  OrthoCaseDto,
  OrthoFollowUpPageDto,
  OrthoFollowUpQueryDto,
  OrthoSettingsDto,
  OrthoVisitDto,
  RegisterOrthoVisitDto,
  UpdateOrthoCaseDto,
  UpdateOrthoSettingsDto,
} from './dto/ortho.dto';

interface AuthenticatedRequest extends AuditableRequest {
  user: TenantJwtPayload;
}

export const ORTHO_WRITE_FORBIDDEN_MESSAGE =
  'Solo el odontólogo o la administración abren casos de ortodoncia y registran sus controles.';
export const ORTHO_READ_FORBIDDEN_MESSAGE =
  'El caso de ortodoncia es historia clínica: tu rol no lo consulta. La lista de seguimiento sí está en Pacientes › Ortodoncia.';
export const ORTHO_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar los ajustes de ortodoncia.';

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description: 'Sede activa. Sin ella, la sede principal (o las permitidas).',
};

/**
 * Caso de ortodoncia del paciente (DX-190). Sin DELETE A PROPÓSITO: es
 * historia clínica (la BD tampoco lo deja). Un control no se edita ni se
 * borra: se corrige con una adenda de su evolución
 * (POST /patients/:patientId/clinical-entries/:entryId/addenda).
 */
@ApiTags('orthodontics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...ORTHO_READ_ROLES)
@RolesDeniedMessage(ORTHO_READ_FORBIDDEN_MESSAGE)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId/ortho-cases')
export class PatientOrthoController {
  constructor(
    private readonly cases: OrthoCaseUseCases,
    private readonly visits: OrthoVisitUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Audit({
    action: 'VIEW',
    resource: 'ORTHO_CASE',
    patient: { param: 'patientId' },
  })
  @Get()
  @ApiOperation({
    summary: 'Casos de ortodoncia del paciente con progreso y arco actual',
  })
  @ApiOkResponse({ type: [OrthoCaseDto] })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  @ApiForbiddenResponse({ description: ORTHO_READ_FORBIDDEN_MESSAGE })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<OrthoCaseView[]> {
    return this.cases.list(patientId);
  }

  @Audit({
    action: 'CREATE',
    resource: 'ORTHO_CASE',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
  })
  @Post()
  @Roles(...ORTHO_WRITE_ROLES)
  @RolesDeniedMessage(ORTHO_WRITE_FORBIDDEN_MESSAGE)
  @ApiHeader(LOCATION_HEADER)
  @ApiOperation({
    summary: 'Abre un caso de ortodoncia (uno activo por paciente)',
  })
  @ApiCreatedResponse({ type: OrthoCaseDto })
  @ApiBadRequestResponse({
    description:
      'Técnica, fechas, meses, controles o intervalo fuera de rango; responsable que no atiende; plan de otro paciente',
  })
  @ApiNotFoundResponse({
    description: 'Paciente, sede o profesional no encontrados en esta clínica',
  })
  @ApiConflictResponse({
    description:
      'El paciente ya tiene un caso activo, o la clínica no tiene la ortodoncia activada',
  })
  @ApiForbiddenResponse({ description: ORTHO_WRITE_FORBIDDEN_MESSAGE })
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateOrthoCaseDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<OrthoCaseView> {
    return this.cases.create(
      patientId,
      {
        technique: dto.technique,
        startDate: dto.startDate,
        estimatedMonths: dto.estimatedMonths,
        plannedVisits: dto.plannedVisits,
        visitIntervalDays: dto.visitIntervalDays,
        bondedOn: dto.bondedOn,
        debondedOn: dto.debondedOn,
        providerId: dto.providerId,
        locationId: dto.locationId,
        treatmentPlanId: dto.treatmentPlanId,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'ORTHO_CASE',
    resourceId: { param: 'caseId' },
    patient: { param: 'patientId' },
    reason: 'ORTHO_CASE_UPDATED',
  })
  @Patch(':caseId')
  @Roles(...ORTHO_WRITE_ROLES)
  @RolesDeniedMessage(ORTHO_WRITE_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'caseId', format: 'uuid' })
  @ApiOperation({ summary: 'Cambia la planificación del caso (abierto)' })
  @ApiOkResponse({ type: OrthoCaseDto })
  @ApiBadRequestResponse({ description: 'Valores fuera de rango' })
  @ApiNotFoundResponse({ description: 'Paciente o caso de otra clínica' })
  @ApiConflictResponse({ description: 'El caso está cerrado' })
  @ApiForbiddenResponse({ description: ORTHO_WRITE_FORBIDDEN_MESSAGE })
  update(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: UpdateOrthoCaseDto,
  ): Promise<OrthoCaseView> {
    return this.cases.update(patientId, caseId, {
      technique: dto.technique,
      startDate: dto.startDate,
      estimatedMonths: dto.estimatedMonths,
      plannedVisits: dto.plannedVisits,
      visitIntervalDays: dto.visitIntervalDays,
      bondedOn: dto.bondedOn,
      debondedOn: dto.debondedOn,
      providerId: dto.providerId,
      treatmentPlanId: dto.treatmentPlanId,
    });
  }

  // Auditado en el caso de uso (UPDATE ORTHO_CASE con el estado antes y
  // después; nunca el motivo escrito).
  @Post(':caseId/status')
  @HttpCode(200)
  @Roles(...ORTHO_WRITE_ROLES)
  @RolesDeniedMessage(ORTHO_WRITE_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'caseId', format: 'uuid' })
  @ApiOperation({
    summary: 'Pasa el caso a retención, lo finaliza o lo da por abandonado',
    description:
      'ACTIVE → RETENTION | FINISHED | ABANDONED; RETENTION → FINISHED | ABANDONED. El abandono exige motivo. Un caso cerrado ya no cambia.',
  })
  @ApiOkResponse({ type: OrthoCaseDto })
  @ApiBadRequestResponse({
    description: 'Transición no permitida o sin motivo',
  })
  @ApiNotFoundResponse({ description: 'Paciente o caso de otra clínica' })
  @ApiConflictResponse({
    description: 'El caso está cerrado o cambió a la vez',
  })
  @ApiForbiddenResponse({ description: ORTHO_WRITE_FORBIDDEN_MESSAGE })
  changeStatus(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: ChangeOrthoCaseStatusDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<OrthoCaseView> {
    return this.cases.changeStatus(
      patientId,
      caseId,
      { status: dto.status, reason: dto.reason },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Audit({
    action: 'VIEW',
    resource: 'ORTHO_VISIT',
    patient: { param: 'patientId' },
  })
  @Get(':caseId/visits')
  @ApiParam({ name: 'caseId', format: 'uuid' })
  @ApiOperation({
    summary: 'Controles del caso con sus adendas, el más reciente primero',
  })
  @ApiOkResponse({ type: [OrthoVisitDto] })
  @ApiNotFoundResponse({ description: 'Paciente o caso de otra clínica' })
  listVisits(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ): Promise<OrthoVisitView[]> {
    return this.visits.list(patientId, caseId);
  }

  @Audit({
    action: 'CREATE',
    resource: 'ORTHO_VISIT',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
  })
  @Post(':caseId/visits')
  @Roles(...ORTHO_WRITE_ROLES)
  @RolesDeniedMessage(ORTHO_WRITE_FORBIDDEN_MESSAGE)
  @ApiHeader(LOCATION_HEADER)
  @ApiParam({ name: 'caseId', format: 'uuid' })
  @ApiOperation({
    summary: 'Registra un control (inalterable: se corrige con una adenda)',
    description:
      'Crea la evolución que lo documenta (mismas reglas que una evolución: cita de este paciente, atendida y no futura; fecha no futura) y el control estructurado en la misma transacción. Los calibres salen de la lista de la clínica.',
  })
  @ApiCreatedResponse({ type: OrthoVisitDto })
  @ApiBadRequestResponse({
    description:
      'Control vacío, calibre fuera de la lista, higiene fuera de 1–4, próximo control no posterior, cita de otro paciente o no atendida',
  })
  @ApiNotFoundResponse({
    description: 'Paciente, caso o cita no encontrados en esta clínica',
  })
  @ApiConflictResponse({
    description:
      'El caso no está activo ni en retención, o la clínica no tiene la ortodoncia activada',
  })
  @ApiForbiddenResponse({ description: ORTHO_WRITE_FORBIDDEN_MESSAGE })
  registerVisit(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: RegisterOrthoVisitDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<OrthoVisitView> {
    return this.visits.register(
      patientId,
      caseId,
      {
        entryDate: dto.entryDate,
        appointmentId: dto.appointmentId,
        upperWire: dto.upperWire,
        lowerWire: dto.lowerWire,
        elasticsType: dto.elasticsType,
        elasticsWear: dto.elasticsWear,
        applianceChanges: dto.applianceChanges,
        incidents: dto.incidents,
        hygieneIndex: dto.hygieneIndex,
        note: dto.note,
        nextVisitProposedOn: dto.nextVisitProposedOn,
      },
      req.user.sub,
      auditRequestContext(req, this.tenantContext),
    );
  }
}

/** Ajustes y lista de seguimiento de la clínica (DX-190). */
@ApiTags('orthodontics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...ORTHO_FOLLOW_UP_ROLES)
@Controller('ortho')
export class OrthoController {
  constructor(
    private readonly settings: OrthoSettingsUseCases,
    private readonly followUp: OrthoFollowUpUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('settings')
  @Roles(...ORTHO_SETTINGS_READ_ROLES)
  @ApiOperation({
    summary: 'Ajustes de ortodoncia: módulo activo y calibres de arco',
  })
  @ApiOkResponse({ type: OrthoSettingsDto })
  getSettings(): Promise<OrthoSettings> {
    return this.settings.get();
  }

  @Put('settings')
  @Roles(...ORTHO_SETTINGS_WRITE_ROLES)
  @RolesDeniedMessage(ORTHO_SETTINGS_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary:
      'Activa la ortodoncia o cambia los calibres (solo ADMIN, auditado)',
    description:
      'Un control guardado conserva el calibre que se eligió aunque la lista cambie. Si nada cambia, 200 sin evento de auditoría.',
  })
  @ApiOkResponse({ type: OrthoSettingsDto })
  @ApiBadRequestResponse({
    description:
      'Lista vacía, más de 40, calibres repetidos o de más de 20 caracteres',
  })
  @ApiForbiddenResponse({ description: ORTHO_SETTINGS_FORBIDDEN_MESSAGE })
  updateSettings(
    @Body() dto: UpdateOrthoSettingsDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<OrthoSettings> {
    return this.settings.update(
      { enabled: dto.enabled, wireGauges: dto.wireGauges },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // Lista de muchos pacientes con teléfonos: el evento no lleva paciente,
  // pero queda quién la consultó (mismo criterio que la lista de recall).
  @Audit({ action: 'VIEW', resource: 'ORTHO_CASE', reason: 'ORTHO_FOLLOW_UP' })
  @Get('follow-up')
  @ApiHeader(LOCATION_HEADER)
  @ApiOperation({
    summary: 'Casos activos: atrasados, sin próxima cita y no-show',
    description:
      '«Atrasado»: el último control (o, sin controles, el inicio) fue hace más de intervalo + 15 días, en el día civil de la sede del caso. «Sin próxima cita»: sin cita futura agendada o confirmada ni una en curso. Filtrable por sede y profesional; respeta las sedes del miembro.',
  })
  @ApiOkResponse({ type: OrthoFollowUpPageDto })
  @ApiBadRequestResponse({ description: 'Filtro, página o ids inválidos' })
  @ApiForbiddenResponse({
    description: '403 LOCATION_NOT_ALLOWED: sede no permitida al miembro',
  })
  list(@Query() query: OrthoFollowUpQueryDto): Promise<OrthoFollowUpPage> {
    return this.followUp.execute({
      filter: query.filter,
      locationId: query.locationId,
      providerId: query.providerId,
      page: query.page,
      pageSize: query.pageSize,
    });
  }
}
