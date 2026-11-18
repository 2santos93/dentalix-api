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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  LEAD_ADMIN_ROLES,
  LEAD_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  LeadsUseCases,
  type ConvertLeadView,
  type LeadBoardView,
  type LeadDetailView,
  type LeadListView,
  type LeadReportView,
  type LeadView,
} from '../application/leads.use-cases';
import { LEAD_MESSAGES } from '../domain/lead-rules';
import type { LeadNoteRow } from '../domain/lead-repository.port';
import {
  AddLeadNoteDto,
  ChangeLeadStageDto,
  ConvertLeadDto,
  ConvertLeadResultDto,
  CreateLeadDto,
  LeadBoardDto,
  LeadBoardQueryDto,
  LeadCountDto,
  LeadDetailDto,
  LeadDto,
  LeadListDto,
  LeadListQueryDto,
  LeadNoteDto,
  LeadOwnerDto,
  LeadReportDto,
  LeadReportQueryDto,
  LeadScopeQueryDto,
  LeadSettingsDto,
  UpdateLeadDto,
  UpdateLeadSettingsDto,
} from './dto/leads.dto';

interface AuthenticatedRequest extends AuditableRequest {
  user: TenantJwtPayload;
}

const LOCATION_FORBIDDEN =
  'Sede fuera de las del usuario (o prospecto de una de ellas)';
const SCOPE =
  'Solo las sedes permitidas al usuario (DX-089): la pedida, la activa (X-Location-Id) o todas las que ve.';

const date = (value: string | undefined): Date | undefined =>
  value === undefined ? undefined : new Date(value);
const dateOrNull = (
  value: string | null | undefined,
): Date | null | undefined =>
  value === undefined ? undefined : value === null ? null : new Date(value);

/**
 * «Prospectos» (DX-556): interesados antes de ser paciente, por etapas, con
 * responsable, próxima acción, notas comerciales y la conversión en
 * paciente. Solo ADMIN y RECEPTION. Las escrituras dejan su `audit_event`
 * en la misma transacción (nunca el nombre, el teléfono ni las notas).
 */
@ApiTags('leads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...LEAD_ROLES)
@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leads: LeadsUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  // Lleva nombres y teléfonos: queda auditada (VIEW).
  @Audit({ action: 'VIEW', resource: 'LEAD', reason: 'LEAD_LIST' })
  @Get()
  @ApiOperation({
    summary: 'Lista de prospectos (paginada, con filtros)',
    description:
      `${SCOPE} Más recientes primero. \`reached\` filtra a quien llegó a tener cita o asistió (las cifras del informe). ` +
      'Deja un `audit_event` VIEW LEAD (LEAD_LIST).',
  })
  @ApiOkResponse({ type: LeadListDto })
  @ApiBadRequestResponse({ description: 'Filtros o paginación inválidos' })
  @ApiForbiddenResponse({ description: LOCATION_FORBIDDEN })
  list(@Query() dto: LeadListQueryDto): Promise<LeadListView> {
    return this.leads.list({
      locationId: dto.locationId,
      stage: dto.stage,
      channel: dto.channel,
      ownerId: dto.ownerId,
      unowned: dto.unowned,
      q: dto.q,
      createdFrom: date(dto.createdFrom),
      createdTo: date(dto.createdTo),
      reached: dto.reached,
      stale: dto.stale,
      page: dto.page,
      pageSize: dto.pageSize,
    });
  }

  @Audit({ action: 'VIEW', resource: 'LEAD', reason: 'LEAD_BOARD' })
  @Get('board')
  @ApiOperation({
    summary: 'Tablero por etapas',
    description:
      `${SCOPE} Las cinco etapas con su total y los primeros de cada una (próxima acción más urgente arriba). ` +
      'Deja un `audit_event` VIEW LEAD (LEAD_BOARD).',
  })
  @ApiOkResponse({ type: LeadBoardDto })
  @ApiBadRequestResponse({ description: 'Filtros inválidos' })
  @ApiForbiddenResponse({ description: LOCATION_FORBIDDEN })
  board(@Query() dto: LeadBoardQueryDto): Promise<LeadBoardView> {
    return this.leads.board({
      locationId: dto.locationId,
      channel: dto.channel,
      ownerId: dto.ownerId,
      unowned: dto.unowned,
      q: dto.q,
      createdFrom: date(dto.createdFrom),
      createdTo: date(dto.createdTo),
      perStage: dto.perStage,
    });
  }

  @Get('count')
  @ApiOperation({
    summary: 'Contador de prospectos (Mi día)',
    description: `Abiertos y «sin contactar hace más de 24 h» (abiertos, sin contacto en 24 h y sin próxima acción pendiente). Solo números, sin auditoría. ${SCOPE}`,
  })
  @ApiOkResponse({ type: LeadCountDto })
  @ApiForbiddenResponse({ description: LOCATION_FORBIDDEN })
  count(
    @Query() dto: LeadScopeQueryDto,
  ): Promise<{ open: number; stale: number }> {
    return this.leads.count({ locationId: dto.locationId });
  }

  @Get('report')
  @ApiOperation({
    summary: 'Informe de conversión por canal y por responsable',
    description:
      `${SCOPE} Prospectos dados de alta en [from, to): cuántos, cuántos llegaron a tener cita, cuántos asistieron y la tasa de cada paso. ` +
      'Cuadra con `GET /leads` con los mismos filtros (y `reached`). Sin datos de los prospectos.',
  })
  @ApiOkResponse({ type: LeadReportDto })
  @ApiBadRequestResponse({ description: 'Período inválido' })
  @ApiForbiddenResponse({ description: LOCATION_FORBIDDEN })
  report(@Query() dto: LeadReportQueryDto): Promise<LeadReportView> {
    return this.leads.report({
      locationId: dto.locationId,
      from: new Date(dto.from),
      to: new Date(dto.to),
    });
  }

  @Get('owners')
  @ApiOperation({
    summary: 'Posibles responsables (ADMIN y recepción de la clínica)',
  })
  @ApiOkResponse({ type: [LeadOwnerDto] })
  owners(): Promise<{ userId: string; fullName: string; role: string }[]> {
    return this.leads.owners();
  }

  @Get('settings')
  @ApiOperation({ summary: 'Ajustes de prospectos (retención)' })
  @ApiOkResponse({ type: LeadSettingsDto })
  settings(): Promise<{ lostRetentionMonths: number }> {
    return this.leads.settings();
  }

  @Audit({
    action: 'UPDATE',
    resource: 'LEAD',
    reason: 'LEAD_RETENTION_UPDATED',
  })
  @Put('settings')
  @Roles(...LEAD_ADMIN_ROLES)
  @ApiOperation({
    summary: 'Cambiar la retención de los prospectos perdidos (solo ADMIN)',
    description:
      'Meses tras los que un prospecto PERDIDO se anonimiza (nombre, teléfono y notas). Lo aplica el barrido diario.',
  })
  @ApiOkResponse({ type: LeadSettingsDto })
  @ApiBadRequestResponse({ description: 'Meses fuera de 1–120' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  updateSettings(
    @Body() dto: UpdateLeadSettingsDto,
  ): Promise<{ lostRetentionMonths: number }> {
    return this.leads.updateSettings(dto.lostRetentionMonths);
  }

  @Post()
  @ApiOperation({
    summary: 'Dar de alta un prospecto',
    description:
      'Nace en «Nuevo». El teléfono se guarda en E.164 (con el prefijo de la sede). Si ya es de un paciente o de otro prospecto: 409 ' +
      '`LEAD_PHONE_TAKEN` con `existing { kind, id, name }` para abrir el existente (sin id ni nombre si es de una sede no permitida). ' +
      'Solo datos comerciales: nunca datos de salud. Deja un `audit_event` CREATE LEAD (LEAD_CREATED).',
  })
  @ApiCreatedResponse({ type: LeadDto })
  @ApiBadRequestResponse({
    description:
      'Teléfono no válido, motivo fuera del catálogo o responsable no válido',
  })
  @ApiForbiddenResponse({ description: LOCATION_FORBIDDEN })
  @ApiConflictResponse({ description: LEAD_MESSAGES.phoneTaken })
  create(
    @Body() dto: CreateLeadDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<LeadView> {
    return this.leads.create(
      {
        fullName: dto.fullName,
        phone: dto.phone,
        channel: dto.channel,
        interestReason: dto.interestReason,
        locationId: dto.locationId,
        ownerId: dto.ownerId,
        nextActionAt: dateOrNull(dto.nextActionAt),
        nextActionNote: dto.nextActionNote,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Audit({
    action: 'VIEW',
    resource: 'LEAD',
    resourceId: { param: 'id' },
    reason: 'LEAD_VIEWED',
  })
  @Get(':id')
  @ApiOperation({
    summary: 'Ficha del prospecto con sus notas',
    description: 'Deja un `audit_event` VIEW LEAD (LEAD_VIEWED).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: LeadDetailDto })
  @ApiForbiddenResponse({ description: LOCATION_FORBIDDEN })
  @ApiNotFoundResponse({ description: LEAD_MESSAGES.notFound })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<LeadDetailView> {
    return this.leads.get(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Editar el prospecto',
    description:
      'Nombre, teléfono (con el aviso de repetido), canal, motivo, sede, responsable y próxima acción. Deja un `audit_event` UPDATE LEAD ' +
      '(LEAD_UPDATED, con los nombres de los campos).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: LeadDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiForbiddenResponse({ description: LOCATION_FORBIDDEN })
  @ApiNotFoundResponse({ description: LEAD_MESSAGES.notFound })
  @ApiConflictResponse({
    description: `${LEAD_MESSAGES.phoneTaken} / ${LEAD_MESSAGES.anonymized}`,
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLeadDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<LeadView> {
    return this.leads.update(
      id,
      {
        fullName: dto.fullName,
        phone: dto.phone,
        channel: dto.channel,
        interestReason: dto.interestReason,
        locationId: dto.locationId,
        ownerId: dto.ownerId,
        nextActionAt: dateOrNull(dto.nextActionAt),
        nextActionNote: dto.nextActionNote,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Post(':id/stage')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cambiar la etapa',
    description:
      '«Perdido» exige un motivo del catálogo de pérdida. «Cita agendada» y «Asistió» los pone la cita (409). ' +
      'Deja un `audit_event` UPDATE LEAD (LEAD_STAGE_CHANGED, con la etapa antes y después).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: LeadDto })
  @ApiBadRequestResponse({ description: LEAD_MESSAGES.lostReasonRequired })
  @ApiForbiddenResponse({ description: LOCATION_FORBIDDEN })
  @ApiNotFoundResponse({ description: LEAD_MESSAGES.notFound })
  @ApiConflictResponse({ description: LEAD_MESSAGES.stageByAppointment })
  changeStage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeLeadStageDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<LeadView> {
    return this.leads.changeStage(
      id,
      { stage: dto.stage, lostReason: dto.lostReason },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Post(':id/notes')
  @ApiOperation({
    summary: 'Añadir una nota comercial (solo de añadir)',
    description:
      'Cuenta como contacto (sale de «sin contactar»). Nunca datos de salud. Deja un `audit_event` UPDATE LEAD (LEAD_NOTE_ADDED, sin el texto).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: LeadNoteDto })
  @ApiBadRequestResponse({
    description: 'Nota vacía o de más de 1000 caracteres',
  })
  @ApiForbiddenResponse({ description: LOCATION_FORBIDDEN })
  @ApiNotFoundResponse({ description: LEAD_MESSAGES.notFound })
  @ApiConflictResponse({ description: LEAD_MESSAGES.anonymized })
  addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddLeadNoteDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<LeadNoteRow> {
    return this.leads.addNote(
      id,
      dto.body,
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Post(':id/convert')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Convertir en paciente (idempotente)',
    description:
      'Si ya está convertido, devuelve el mismo paciente (`created: false`). Si un paciente vivo tiene su teléfono, lo enlaza ' +
      '(varios: 409 `LEAD_AMBIGUOUS_PATIENTS` con `candidates`, y se repite con `patientId`). Si no, crea la ficha sin datos clínicos ' +
      'con el nombre y el teléfono. Deja `audit_event` CREATE PATIENT (LEAD_CONVERTED) y UPDATE LEAD (LEAD_CONVERTED o LEAD_LINKED).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ConvertLeadResultDto })
  @ApiBadRequestResponse({ description: LEAD_MESSAGES.lastNameRequired })
  @ApiForbiddenResponse({ description: LOCATION_FORBIDDEN })
  @ApiNotFoundResponse({ description: LEAD_MESSAGES.notFound })
  @ApiConflictResponse({ description: LEAD_MESSAGES.ambiguousPatients })
  convert(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConvertLeadDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ConvertLeadView> {
    return this.leads.convert(
      id,
      {
        firstName: dto.firstName,
        lastName: dto.lastName,
        patientId: dto.patientId,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}
