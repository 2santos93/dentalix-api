import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
  ApiNoContentResponse,
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
  CLINICAL_ROLES,
  CLINIC_SETTINGS_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import {
  ComparePerioExamsUseCase,
  CreatePerioExamUseCase,
  DeletePerioExamUseCase,
  FinalizePerioExamUseCase,
  GetPerioExamUseCase,
  GetPerioSettingsUseCase,
  ListPerioExamsUseCase,
  SavePerioMeasuresUseCase,
  UpdatePerioNotesUseCase,
  UpdatePerioSettingsUseCase,
} from '../application/use-cases/perio-exams.use-cases';
import type {
  PerioComparison,
  PerioExamDetail,
  PerioExamSummary,
} from '../domain/entities/perio-exam.entity';
import type { PerioThresholds } from '../domain/perio-measures';
import { CreatePerioExamDto } from './dto/create-perio-exam.dto';
import {
  PerioComparisonDto,
  PerioExamDetailDto,
  PerioExamSummaryDto,
} from './dto/perio-exam.dto';
import { SavePerioMeasuresDto } from './dto/save-perio-measures.dto';
import { UpdatePerioNotesDto } from './dto/update-perio-notes.dto';
import { ComparePerioExamsQueryDto } from './dto/compare-perio-exams.dto';
import {
  PerioSettingsDto,
  UpdatePerioSettingsDto,
} from './dto/perio-settings.dto';
import { Audit } from '../../audit/presentation/audit.decorator';
import { PERIO_LIST_MAX } from '../domain/perio-measures';

interface AuthenticatedRequest {
  user: JwtPayload;
}

const NOT_FOUND = 'Paciente o examen no encontrado en esta clínica';
const FINAL = 'El examen está finalizado (inmutable)';
export const PERIO_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar los umbrales del periodontograma.';

// Periodontograma (DX-007). Dato clínico: CLINICAL_ROLES (recepción 403),
// igual que el odontograma. Un examen FINAL es inmutable: PUT/finalize/DELETE
// dan 409 y una corrección es un examen nuevo.
@ApiTags('perio-exams')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@ApiForbiddenResponse({ description: 'Rol sin acceso clínico (recepción)' })
@Controller('patients/:patientId/perio-exams')
export class PerioExamsController {
  constructor(
    private readonly listExams: ListPerioExamsUseCase,
    private readonly createExam: CreatePerioExamUseCase,
    private readonly getExam: GetPerioExamUseCase,
    private readonly saveMeasures: SavePerioMeasuresUseCase,
    private readonly finalizeExam: FinalizePerioExamUseCase,
    private readonly deleteExam: DeletePerioExamUseCase,
    private readonly updateNotes: UpdatePerioNotesUseCase,
    private readonly compareExams: ComparePerioExamsUseCase,
  ) {}

  @Audit({
    action: 'VIEW',
    resource: 'PERIO_EXAM',
    patient: { param: 'patientId' },
  })
  @Get()
  @ApiOkResponse({
    type: [PerioExamSummaryDto],
    description: `Histórico del paciente por fecha de examen descendente, con sus índices y SIN las medidas (están en el detalle). Como máximo los ${PERIO_LIST_MAX} exámenes más recientes.`,
  })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<PerioExamSummary[]> {
    return this.listExams.execute(patientId);
  }

  @Audit({
    action: 'CREATE',
    resource: 'PERIO_EXAM',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
  })
  @Post()
  @ApiCreatedResponse({ type: PerioExamDetailDto })
  @ApiBadRequestResponse({ description: 'Fecha inválida o futura' })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreatePerioExamDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PerioExamDetail> {
    return this.createExam.execute(
      patientId,
      {
        examDate: dto.examDate,
        notes: dto.notes,
        copySkippedFromLast: dto.copySkippedFromLast,
      },
      req.user.sub,
    );
  }

  // Antes de `:id` para que «compare» no se lea como un id.
  @Audit({
    action: 'VIEW',
    resource: 'PERIO_EXAM',
    patient: { param: 'patientId' },
    reason: 'PERIO_COMPARISON',
  })
  @Get('compare')
  @ApiOperation({
    summary: 'Compara de 2 a 4 exámenes FINAL del paciente (DX-066)',
    description:
      'Índices de cada examen con los umbrales de la clínica y, por sitio, sondaje y NIC en cada examen con el Δ frente al anterior y el Δ total (último − primero). `worsened` = algún Δ total ≥ 2 mm.',
  })
  @ApiOkResponse({ type: PerioComparisonDto })
  @ApiBadRequestResponse({
    description:
      'Menos de 2 o más de 4 exámenes, ids repetidos o inválidos, o algún borrador',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  compare(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query() query: ComparePerioExamsQueryDto,
  ): Promise<PerioComparison> {
    return this.compareExams.execute(patientId, query.examIds);
  }

  @Audit({
    action: 'VIEW',
    resource: 'PERIO_EXAM',
    resourceId: { param: 'id' },
    patient: { param: 'patientId' },
  })
  @Get(':id')
  @ApiOkResponse({ type: PerioExamDetailDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  get(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PerioExamDetail> {
    return this.getExam.execute(patientId, id);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PERIO_EXAM',
    resourceId: { param: 'id' },
    patient: { param: 'patientId' },
  })
  @Put(':id/measures')
  @ApiOkResponse({ type: PerioExamDetailDto })
  @ApiBadRequestResponse({
    description: 'Valores fuera de rango, FDI o sitio inválidos, duplicados',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: FINAL })
  save(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SavePerioMeasuresDto,
  ): Promise<PerioExamDetail> {
    return this.saveMeasures.execute(patientId, id, {
      sites: dto.sites.map((s) => ({
        toothFdi: s.toothFdi,
        site: s.site,
        probingMm: s.probingMm ?? null,
        recessionMm: s.recessionMm ?? null,
        furcation: s.furcation ?? null,
        bleeding: s.bleeding ?? false,
        suppuration: s.suppuration ?? false,
        plaque: s.plaque ?? false,
        calculus: s.calculus ?? false,
      })),
      teeth: dto.teeth.map((t) => ({
        toothFdi: t.toothFdi,
        mobility: t.mobility ?? null,
        skipped: t.skipped ?? false,
      })),
      notes: dto.notes,
    });
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PERIO_EXAM',
    resourceId: { param: 'id' },
    patient: { param: 'patientId' },
    reason: 'PERIO_NOTES',
  })
  @Patch(':id')
  @ApiOperation({
    summary: 'Cambia las notas de un examen en DRAFT (DX-066)',
  })
  @ApiOkResponse({ type: PerioExamDetailDto })
  @ApiBadRequestResponse({
    description: 'Faltan las notas, no son texto o pasan de 2000 caracteres',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: FINAL })
  patchNotes(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePerioNotesDto,
  ): Promise<PerioExamDetail> {
    return this.updateNotes.execute(patientId, id, dto.notes);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PERIO_EXAM',
    resourceId: { param: 'id' },
    patient: { param: 'patientId' },
  })
  @Post(':id/finalize')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: PerioExamDetailDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: 'El examen ya estaba finalizado' })
  finalize(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PerioExamDetail> {
    return this.finalizeExam.execute(patientId, id);
  }

  @Audit({
    action: 'DELETE',
    resource: 'PERIO_EXAM',
    resourceId: { param: 'id' },
    patient: { param: 'patientId' },
  })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Borrador eliminado' })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: FINAL })
  remove(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.deleteExam.execute(patientId, id);
  }
}

/**
 * DX-066: umbrales de sondaje de la clínica. Los leen los roles clínicos (la
 * carta los usa para colorear); los cambia solo ADMIN, auditado en el caso de
 * uso (CLINIC_SETTINGS · PERIO_SETTINGS, sin evento si nada cambia).
 */
@ApiTags('perio-exams')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@ApiForbiddenResponse({ description: 'Rol sin acceso clínico (recepción)' })
@Controller('perio/settings')
export class PerioSettingsController {
  constructor(
    private readonly getSettings: GetPerioSettingsUseCase,
    private readonly updateSettings: UpdatePerioSettingsUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Umbrales de sondaje del periodontograma de la clínica (DX-066)',
  })
  @ApiOkResponse({ type: PerioSettingsDto })
  settings(): Promise<PerioThresholds> {
    return this.getSettings.execute();
  }

  @Put()
  @Roles(...CLINIC_SETTINGS_WRITE_ROLES)
  @RolesDeniedMessage(PERIO_SETTINGS_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary:
      'Cambia los umbrales de alerta y severo (solo ADMIN, auditado; DX-066)',
    description:
      'Un campo ausente conserva su valor. Alerta 2–10 mm, severo 3–12 mm y alerta < severo. Aplica al leer cualquier examen (también los FINAL: colorean, no se congelan). Si nada cambia, 200 sin evento de auditoría.',
  })
  @ApiOkResponse({ type: PerioSettingsDto })
  @ApiBadRequestResponse({
    description: 'Fuera de rango, no enteros o alerta ≥ severo',
  })
  @ApiForbiddenResponse({ description: PERIO_SETTINGS_FORBIDDEN_MESSAGE })
  update(
    @Body() dto: UpdatePerioSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<PerioThresholds> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.updateSettings.execute(
      { pdAlertMm: dto.pdAlertMm, pdSevereMm: dto.pdSevereMm },
      ctx,
    );
  }
}
