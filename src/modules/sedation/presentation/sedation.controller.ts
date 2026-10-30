import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  MethodNotAllowedException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiMethodNotAllowedResponse,
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
  CLINICAL_ROLES,
  SEDATION_VITALS_ROLES,
  SEDATION_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  SedationUseCases,
  type EntrySedation,
  type SedationSheetView,
} from '../application/use-cases/sedation.use-cases';
import {
  EntrySedationDto,
  SedationAgentDto,
  SedationAssessmentDto,
  SedationChecklistDto,
  SedationDischargeDto,
  SedationProblemsDto,
  SedationSheetDto,
  SedationVitalsDto,
} from './dto/sedation.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
}

/** Respuesta a cualquier intento de editar o borrar la hoja (DX-038). */
export const SEDATION_IMMUTABLE_MESSAGE =
  'La hoja de sedación no se puede modificar. Añade una adenda a la evolución.';

const SHEET = 'patients/:patientId/clinical-entries/:entryId/sedation';

const date = (value: string | undefined) =>
  value === undefined ? undefined : new Date(value);

/** Escritura de una parte de la hoja: auditada sin datos clínicos. */
function AuditSedationPart(reason: string) {
  return Audit({
    action: 'CREATE',
    resource: 'SEDATION_RECORD',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
    reason,
  });
}

// Hoja de sedación consciente en la evolución (DX-407). Inalterable como la
// evolución (DX-038): cada parte es un POST que añade filas; PATCH/PUT/DELETE
// existen solo para responder 405 con un mensaje que remite a la adenda.
@ApiTags('sedation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller()
export class SedationController {
  constructor(private readonly sedation: SedationUseCases) {}

  @Audit({
    action: 'VIEW',
    resource: 'SEDATION_RECORD',
    patient: { param: 'patientId' },
  })
  @Get('patients/:patientId/sedation')
  @Roles(...CLINICAL_ROLES)
  @ApiOperation({
    summary: 'Hojas de sedación de las evoluciones del paciente (ficha)',
  })
  @ApiOkResponse({ type: [SedationSheetDto] })
  @ApiNotFoundResponse({ description: 'Paciente no encontrado' })
  listByPatient(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<SedationSheetView[]> {
    return this.sedation.listByPatient(patientId);
  }

  @Audit({
    action: 'VIEW',
    resource: 'SEDATION_RECORD',
    resourceId: { param: 'entryId' },
    patient: { param: 'patientId' },
  })
  @Get(SHEET)
  @Roles(...CLINICAL_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiOperation({
    summary: 'Hoja de sedación de una evolución y su plantilla',
    description:
      'Sin hoja, `sheet` es null y `template` es la plantilla con la que se abriría. `sheet.watch` dice si se pasó el intervalo de constantes sin toma.',
  })
  @ApiOkResponse({ type: EntrySedationDto })
  @ApiNotFoundResponse({ description: 'Paciente o evolución no encontrados' })
  getEntry(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ): Promise<EntrySedation> {
    return this.sedation.getEntry(patientId, entryId);
  }

  @AuditSedationPart('SEDATION_ASSESSMENT')
  @Post(SHEET)
  @Roles(...SEDATION_WRITE_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiOperation({
    summary: 'Abre la hoja con la valoración previa (inalterable)',
    description:
      'ASA I–V + E, ayuno, Mallampati, peso, talla, acompañante y consentimiento según la plantilla. El servidor calcula el IMC y los reversores por peso. Con ASA III o más exige interconsulta o justificación.',
  })
  @ApiCreatedResponse({ type: SedationSheetDto })
  @ApiBadRequestResponse({ type: SedationProblemsDto })
  @ApiConflictResponse({ description: 'La evolución ya tiene hoja' })
  @ApiNotFoundResponse({
    description: 'Paciente, evolución o consentimiento no encontrados',
  })
  assess(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: SedationAssessmentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<SedationSheetView> {
    return this.sedation.assess(patientId, entryId, dto, req.user.sub);
  }

  @AuditSedationPart('SEDATION_CHECKLIST')
  @Post(`${SHEET}/checklist`)
  @Roles(...SEDATION_WRITE_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiOperation({
    summary: 'Checklist previo (hora del servidor y quien lo marca)',
  })
  @ApiCreatedResponse({ type: SedationSheetDto })
  @ApiBadRequestResponse({ type: SedationProblemsDto })
  @ApiConflictResponse({ description: 'Ya registrado o egreso firmado' })
  @ApiNotFoundResponse({
    description: 'Paciente, evolución u hoja no encontrados',
  })
  check(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: SedationChecklistDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<SedationSheetView> {
    return this.sedation.check(patientId, entryId, dto.items, req.user.sub);
  }

  @AuditSedationPart('SEDATION_AGENT')
  @Post(`${SHEET}/agents`)
  @Roles(...SEDATION_WRITE_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiOperation({
    summary: 'Fármaco de sedación: N2O (% y flujo), oral u otro',
  })
  @ApiCreatedResponse({ type: SedationSheetDto })
  @ApiBadRequestResponse({ type: SedationProblemsDto })
  @ApiConflictResponse({ description: 'Sin checklist o egreso firmado' })
  @ApiNotFoundResponse({
    description: 'Paciente, evolución u hoja no encontrados',
  })
  addAgent(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: SedationAgentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<SedationSheetView> {
    return this.sedation.addAgent(
      patientId,
      entryId,
      { ...dto, administeredAt: date(dto.administeredAt) },
      req.user.sub,
    );
  }

  @AuditSedationPart('SEDATION_VITALS')
  @Post(`${SHEET}/vitals`)
  @Roles(...SEDATION_VITALS_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiOperation({
    summary: 'Toma de constantes basal o intraoperatoria',
    description:
      'También la registra la asistente que monitoriza. La intraoperatoria exige el checklist.',
  })
  @ApiCreatedResponse({ type: SedationSheetDto })
  @ApiBadRequestResponse({ type: SedationProblemsDto })
  @ApiConflictResponse({ description: 'Sin checklist o egreso firmado' })
  @ApiNotFoundResponse({
    description: 'Paciente, evolución u hoja no encontrados',
  })
  addVitals(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: SedationVitalsDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<SedationSheetView> {
    return this.sedation.addVitals(
      patientId,
      entryId,
      { ...dto, takenAt: date(dto.takenAt) },
      req.user.sub,
    );
  }

  @AuditSedationPart('SEDATION_DISCHARGE')
  @Post(`${SHEET}/discharge`)
  @Roles(...SEDATION_WRITE_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiOperation({
    summary: 'Egreso: cierra la hoja (firma el operador que lo registra)',
    description:
      'Criterios de alta (o Aldrete modificado ≥ 9), constantes al alta, hora, a quién se entrega, indicaciones entregadas y quien monitorizó. En sedación moderada, si quien monitoriza es el operador, exige justificación.',
  })
  @ApiCreatedResponse({ type: SedationSheetDto })
  @ApiBadRequestResponse({ type: SedationProblemsDto })
  @ApiConflictResponse({ description: 'Sin checklist o egreso ya firmado' })
  @ApiNotFoundResponse({
    description: 'Paciente, evolución u hoja no encontrados',
  })
  discharge(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: SedationDischargeDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<SedationSheetView> {
    return this.sedation.discharge(
      patientId,
      entryId,
      { ...dto, dischargedAt: date(dto.dischargedAt) },
      req.user.sub,
    );
  }

  @Patch(SHEET)
  @HttpCode(405)
  @Roles(...CLINICAL_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiOperation({ summary: 'No permitido: la hoja de sedación no se edita' })
  @ApiMethodNotAllowedResponse({ description: SEDATION_IMMUTABLE_MESSAGE })
  rejectPatch(): never {
    throw new MethodNotAllowedException(SEDATION_IMMUTABLE_MESSAGE);
  }

  @Put(SHEET)
  @HttpCode(405)
  @Roles(...CLINICAL_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiOperation({ summary: 'No permitido: la hoja de sedación no se edita' })
  @ApiMethodNotAllowedResponse({ description: SEDATION_IMMUTABLE_MESSAGE })
  rejectPut(): never {
    throw new MethodNotAllowedException(SEDATION_IMMUTABLE_MESSAGE);
  }

  @Delete(SHEET)
  @HttpCode(405)
  @Roles(...CLINICAL_ROLES)
  @ApiParam({ name: 'entryId', format: 'uuid' })
  @ApiOperation({ summary: 'No permitido: la hoja de sedación no se borra' })
  @ApiMethodNotAllowedResponse({ description: SEDATION_IMMUTABLE_MESSAGE })
  rejectDelete(): never {
    throw new MethodNotAllowedException(SEDATION_IMMUTABLE_MESSAGE);
  }
}
