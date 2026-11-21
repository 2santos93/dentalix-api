import {
  Body,
  Controller,
  Get,
  HttpCode,
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
  ApiNoContentResponse,
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
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  DismissDuplicatePairUseCase,
  ListDuplicatePatientsUseCase,
  ListMergeLeftoversUseCase,
  MergePatientsUseCase,
  MoveMergeLeftoversUseCase,
  PreviewPatientMergeUseCase,
  type DuplicatePage,
} from '../application/patient-merge.use-cases';
import type {
  MergeLeftover,
  MergeLeftoversResult,
  MergePreview,
  MergeResult,
} from '../domain/patient-merge-repository.port';
import {
  DismissDuplicateDto,
  DuplicatePageDto,
  ListDuplicatesQueryDto,
  MergeLeftoverListDto,
  MergeLeftoversQueryDto,
  MergeLeftoversResultDto,
  MergePatientsDto,
  MergePreviewDto,
  MergePreviewQueryDto,
  MergeResultDto,
  MoveMergeLeftoversDto,
} from './dto/patient-merge.dto';

export const PATIENT_MERGE_FORBIDDEN_MESSAGE =
  'Solo un administrador puede revisar y fusionar pacientes duplicados.';

/**
 * DX-266: «Posibles duplicados» y fusión segura. Todo solo ADMIN. Ruta propia
 * (no `patients/…`) para no chocar con `GET /patients/:id`.
 */
@ApiTags('patient-duplicates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(ClinicRole.ADMIN)
@RolesDeniedMessage(PATIENT_MERGE_FORBIDDEN_MESSAGE)
@ApiForbiddenResponse({ description: PATIENT_MERGE_FORBIDDEN_MESSAGE })
@Controller('patient-duplicates')
export class PatientDuplicatesController {
  constructor(
    private readonly listDuplicates: ListDuplicatePatientsUseCase,
    private readonly dismissPair: DismissDuplicatePairUseCase,
    private readonly previewMerge: PreviewPatientMergeUseCase,
    private readonly mergePatients: MergePatientsUseCase,
    private readonly listLeftovers: ListMergeLeftoversUseCase,
    private readonly moveLeftovers: MoveMergeLeftoversUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  private ctx(req: AuditableRequest): AuditRequestContext {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return ctx;
  }

  @Get()
  @ApiOperation({
    summary: 'Posibles pacientes duplicados (solo ADMIN)',
    description:
      'DX-266. Parejas de pacientes vivos de la clínica con el mismo documento normalizado, ' +
      'el mismo nombre y fecha de nacimiento o el mismo teléfono y nombre, con el motivo. ' +
      'Primero las de documento. No salen las marcadas «No es duplicado». Con `locationId`, ' +
      'solo las parejas con una cita o el saldo en esa sede.',
  })
  @ApiOkResponse({ type: DuplicatePageDto })
  @ApiBadRequestResponse({ description: 'Parámetros no válidos' })
  list(@Query() query: ListDuplicatesQueryDto): Promise<DuplicatePage> {
    return this.listDuplicates.execute(query);
  }

  @Post('dismissals')
  @HttpCode(204)
  @ApiOperation({
    summary: '«No es duplicado» (solo ADMIN)',
    description:
      'DX-266. La pareja deja de salir en «Posibles duplicados». Idempotente. Queda un ' +
      'audit_event (UPDATE de PATIENT, `PATIENT_DUPLICATE_DISMISSED`) en cada paciente.',
  })
  @ApiNoContentResponse({ description: 'Pareja descartada' })
  @ApiBadRequestResponse({ description: 'No son dos pacientes distintos' })
  @ApiNotFoundResponse({
    description: 'Alguno no existe en la clínica o está archivado',
  })
  async dismiss(
    @Body() dto: DismissDuplicateDto,
    @Req() req: AuditableRequest,
  ): Promise<void> {
    const [a, b] = dto.patientIds;
    await this.dismissPair.execute([a, b], this.ctx(req));
  }

  @Get('merge-preview')
  @ApiOperation({
    summary: 'Vista previa de la fusión (solo ADMIN)',
    description:
      'DX-266. Los dos pacientes campo a campo, cuánto tiene cada uno, lo que impide ' +
      'fusionar (`blockers`) y los enlaces públicos vivos del absorbido que se anularán. ' +
      'Deja un VIEW de cada ficha en la auditoría.',
  })
  @ApiOkResponse({ type: MergePreviewDto })
  @ApiBadRequestResponse({ description: 'No son dos pacientes distintos' })
  @ApiNotFoundResponse({
    description: 'Alguno no existe en la clínica o está archivado',
  })
  preview(
    @Query() query: MergePreviewQueryDto,
    @Req() req: AuditableRequest,
  ): Promise<MergePreview> {
    return this.previewMerge.execute(
      query.keptId,
      query.absorbedId,
      this.ctx(req),
    );
  }

  @Post('merge')
  @ApiOperation({
    summary: 'Fusionar dos pacientes (solo ADMIN)',
    description:
      'DX-266. En una transacción: anula los enlaces públicos vivos del absorbido, pasa al ' +
      'conservado TODO lo suyo (citas, historia clínica y evoluciones, odontograma, ' +
      'periodontograma, anamnesis, consentimientos, documentos, planes, pagos, saldos, ' +
      'coberturas, responsables…) sin cambiar su contenido, escribe en el conservado los ' +
      'datos elegidos del absorbido (`fields`) y deja al absorbido retirado con ' +
      '`mergedIntoId`: su ficha y su búsqueda llevan al conservado. El saldo total no ' +
      'cambia. Auditoría en los dos pacientes con lo movido por tipo y cantidad. Sin deshacer.',
  })
  @ApiCreatedResponse({ type: MergeResultDto })
  @ApiBadRequestResponse({ description: 'No son dos pacientes distintos' })
  @ApiNotFoundResponse({ description: 'Alguno no existe en la clínica' })
  @ApiConflictResponse({
    description:
      'Alguno ya está archivado o fusionado (`MERGE_PATIENT_INACTIVE`), tienen citas a la ' +
      'misma hora (`MERGE_OVERLAPPING_APPOINTMENTS`), saldos migrados del mismo lote ' +
      '(`MERGE_OPENING_BALANCE_CONFLICT`), dos compromisos de pago abiertos ' +
      '(`MERGE_OPEN_PAYMENT_PROMISES`), dos casos de ortodoncia activos ' +
      '(`MERGE_TWO_ACTIVE_ORTHO_CASES`) o el documento elegido ya es de otro paciente.',
  })
  merge(
    @Body() dto: MergePatientsDto,
    @Req() req: AuditableRequest,
  ): Promise<MergeResult> {
    return this.mergePatients.execute(
      {
        keptId: dto.keptId,
        absorbedId: dto.absorbedId,
        choices: { ...(dto.fields ?? {}) },
      },
      this.ctx(req),
    );
  }

  @Get('merge-leftovers')
  @ApiOperation({
    summary: 'Lo que quedó en los pacientes fusionados en este (solo ADMIN)',
    description:
      'DX-266-bis. Una escritura que validó al absorbido justo antes de la fusión y confirmó ' +
      'justo después (p. ej. una cita creada en ese mismo segundo) queda en el absorbido. ' +
      'Lista los pacientes fusionados en `keptId` que tienen algo así, con cuántas filas por ' +
      'tabla y por categoría. Vacío casi siempre. Solo recuentos: ningún dato de las filas.',
  })
  @ApiOkResponse({ type: MergeLeftoverListDto })
  @ApiBadRequestResponse({ description: 'Parámetros no válidos' })
  @ApiNotFoundResponse({
    description: 'El paciente no existe en la clínica o está archivado',
  })
  leftovers(
    @Query() query: MergeLeftoversQueryDto,
  ): Promise<{ items: MergeLeftover[] }> {
    return this.listLeftovers.execute(query.keptId);
  }

  @Post('merge-leftovers')
  @ApiOperation({
    summary: 'Volver a pasar al conservado lo que llegó tarde (solo ADMIN)',
    description:
      'DX-266-bis. Sobre un paciente ya fusionado: la misma fusión de la BD (misma lista de ' +
      'tablas, mismo orden de bloqueo, mismos bloqueos de negocio y «uno por paciente») pasa ' +
      'al conservado lo que quedó en el absorbido y anula sus enlaces públicos vivos. ' +
      'Idempotente: sin nada pendiente no cambia nada ni deja auditoría. Con algo, un ' +
      'audit_event (UPDATE de PATIENT, `PATIENT_MERGE_LEFTOVERS_MOVED`) en cada paciente con ' +
      'lo movido por tabla y cantidad.',
  })
  @ApiCreatedResponse({ type: MergeLeftoversResultDto })
  @ApiBadRequestResponse({ description: 'Parámetros no válidos' })
  @ApiNotFoundResponse({ description: 'El paciente no existe en la clínica' })
  @ApiConflictResponse({
    description:
      'El paciente no está fusionado (`MERGE_PATIENT_NOT_MERGED`), el conservado está ' +
      'archivado o se fusionó con otro mientras tanto (`MERGE_PATIENT_INACTIVE`), o lo que ' +
      'quedó choca con el conservado (`MERGE_OVERLAPPING_APPOINTMENTS`, ' +
      '`MERGE_OPENING_BALANCE_CONFLICT`, `MERGE_OPEN_PAYMENT_PROMISES`, ' +
      '`MERGE_TWO_ACTIVE_ORTHO_CASES`).',
  })
  move(
    @Body() dto: MoveMergeLeftoversDto,
    @Req() req: AuditableRequest,
  ): Promise<MergeLeftoversResult> {
    return this.moveLeftovers.execute(dto.absorbedId, this.ctx(req));
  }
}
