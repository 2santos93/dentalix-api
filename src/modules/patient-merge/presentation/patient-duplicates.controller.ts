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
  MergePatientsUseCase,
  PreviewPatientMergeUseCase,
  type DuplicatePage,
} from '../application/patient-merge.use-cases';
import type {
  MergePreview,
  MergeResult,
} from '../domain/patient-merge-repository.port';
import {
  DismissDuplicateDto,
  DuplicatePageDto,
  ListDuplicatesQueryDto,
  MergePatientsDto,
  MergePreviewDto,
  MergePreviewQueryDto,
  MergeResultDto,
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
}
