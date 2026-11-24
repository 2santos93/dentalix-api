import { ExtraPermission } from '@prisma/client';
import {
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { AllowPermissions } from '../../auth/presentation/guards/permissions.decorator';
import {
  RETENTION_PATIENTS_CSV_ROLES,
  RETENTION_REPORT_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import { CSV_RESPONSE, sendCsv } from '../../../shared/csv/csv-response';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  GetRetentionUseCase,
  RETENTION_CSV_FORBIDDEN_MESSAGE,
  RETENTION_CSV_MAX_ROWS,
  RETENTION_FORBIDDEN_MESSAGE,
  RETENTION_INVALID_PERIOD_MESSAGE,
  RETENTION_LOCATION_NOT_FOUND_MESSAGE,
  RETENTION_PERIOD_TOO_LONG_MESSAGE,
  type RetentionInput,
  type RetentionPatientsReport,
  type RetentionReport,
} from '../application/use-cases/get-retention.use-case';
import {
  toRetentionCsv,
  toRetentionPatientsCsv,
} from '../application/retention-csv';
import {
  RetentionPatientsCsvQueryDto,
  RetentionPatientsQueryDto,
  RetentionPatientsReportDto,
  RetentionQueryDto,
  RetentionReportDto,
} from './dto/retention.dto';

const SCOPE =
  'Por sede y profesional (los de la última cita atendida de cada paciente hasta el último día del período): activos al inicio, nuevos, perdidos, activos al final, recuperados, retención = ((activos al final − nuevos) ÷ activos al inicio) × 100 y nuevos sin regreso en 90 días. ' +
  'Solo citas atendidas (canceladas, no asistidas y borradas no cuentan) y pacientes vivos sin historia suprimida (DX-039); los de baja de avisos cuentan. Un paciente con cita futura agendada no es perdido. Activo = alguna atendida en los `activeMonths` meses anteriores (12, 18 o 24; 18 por defecto). Días civiles en la zona de cada sede. ' +
  'Las definiciones van en `definitions`, para mostrarlas tal cual. Solo las sedes que ve quien consulta (DX-089). ADMIN o FINANCIAL_REPORTS_VIEW (DX-090); el resto, 403.';

const BAD_REQUEST = `${RETENTION_INVALID_PERIOD_MESSAGE} / ${RETENTION_PERIOD_TOO_LONG_MESSAGE} / filtros inválidos`;
const NOT_FOUND = `${RETENTION_LOCATION_NOT_FOUND_MESSAGE} (la sede no es de la clínica o está retirada)`;
const FORBIDDEN = `${RETENTION_FORBIDDEN_MESSAGE} / No tienes acceso a esta sede.`;
const CONFLICT =
  'LOCATION_TIMEZONE_REQUIRED: una sede con citas no tiene zona horaria';

// «Retención» (DX-260). El informe no lleva pacientes; las listas sí
// (nombre y teléfono): auditadas (VIEW) y su CSV, solo ADMIN y auditado
// (EXPORT).
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...RETENTION_REPORT_ROLES)
@RolesDeniedMessage(RETENTION_FORBIDDEN_MESSAGE)
@Controller('reports')
export class RetentionController {
  constructor(
    private readonly retention: GetRetentionUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  private input(query: RetentionQueryDto): RetentionInput {
    return {
      from: query.from,
      to: query.to,
      locationId: query.locationId,
      providerId: query.providerId,
      activeMonths: query.activeMonths,
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
    };
  }

  @AllowPermissions(ExtraPermission.FINANCIAL_REPORTS_VIEW)
  @Get('retention')
  @ApiOperation({
    summary:
      'Retención: activos, nuevos, perdidos y nuevos sin regreso por sede y profesional',
    description: SCOPE,
  })
  @ApiOkResponse({ type: RetentionReportDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: CONFLICT })
  get(@Query() query: RetentionQueryDto): Promise<RetentionReport> {
    return this.retention.execute(this.input(query));
  }

  @Audit({ action: 'EXPORT', resource: 'PATIENT', reason: 'RETENTION_REPORT' })
  @AllowPermissions(ExtraPermission.FINANCIAL_REPORTS_VIEW)
  @Get('retention.csv')
  @ApiOperation({
    summary: 'Retención en CSV (mismos filtros)',
    description: `${SCOPE} Una fila por sede y profesional, el subtotal de cada sede y el total, con el período, los filtros y las definiciones en la cabecera. Sin datos de pacientes. UTF-8 con BOM; celdas protegidas contra fórmulas. Auditado (EXPORT).`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV_RESPONSE)
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: CONFLICT })
  async csv(
    @Query() query: RetentionQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.retention.execute(this.input(query));
    sendCsv(res, `retencion-${report.from}-${report.to}.csv`);
    return toRetentionCsv(report);
  }

  @Audit({ action: 'VIEW', resource: 'PATIENT', reason: 'RETENTION_REPORT' })
  @AllowPermissions(ExtraPermission.FINANCIAL_REPORTS_VIEW)
  @Get('retention/patients')
  @ApiOperation({
    summary: 'Retención: los pacientes que forman una cifra (paginado)',
    description: `Los pacientes de la cifra \`segment\` con los mismos filtros que el informe; \`total\` es la cifra. Nombre, teléfono, wa.me (null con baja de avisos, DX-128), primera y última visita, sede y profesional de la última y si tiene cita futura. De la última visita más reciente a la más antigua (\`page\`/\`pageSize\`, 25 por defecto, máx. 100). Lleva datos de contacto: auditado (VIEW). ${SCOPE}`,
  })
  @ApiOkResponse({ type: RetentionPatientsReportDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: CONFLICT })
  patients(
    @Query() query: RetentionPatientsQueryDto,
  ): Promise<RetentionPatientsReport> {
    return this.retention.patients({
      ...this.input(query),
      segment: query.segment,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Audit({ action: 'EXPORT', resource: 'PATIENT', reason: 'RETENTION_REPORT' })
  @Roles(...RETENTION_PATIENTS_CSV_ROLES)
  @RolesDeniedMessage(RETENTION_CSV_FORBIDDEN_MESSAGE)
  @Get('retention/patients.csv')
  @ApiOperation({
    summary:
      'Retención: los pacientes de una cifra en CSV (sin paginar; solo ADMIN)',
    description: `Los pacientes de la cifra \`segment\` (como mucho ${RETENTION_CSV_MAX_ROWS}, los de visita más reciente; si hay más, lo avisa la cabecera), con nombre, teléfono, baja de avisos, primera y última visita (día en la zona de su sede), sede, profesional y cita futura. Lleva datos de contacto: solo ADMIN, y cada descarga deja un evento EXPORT en la auditoría. UTF-8 con BOM; celdas protegidas contra fórmulas.`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV_RESPONSE)
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({
    description: `${RETENTION_CSV_FORBIDDEN_MESSAGE} / No tienes acceso a esta sede.`,
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: CONFLICT })
  async patientsCsv(
    @Query() query: RetentionPatientsCsvQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.retention.exportPatients({
      ...this.input(query),
      segment: query.segment,
    });
    sendCsv(
      res,
      `retencion-${report.segment.replace(/_/g, '-')}-${report.from}-${report.to}.csv`,
    );
    return toRetentionPatientsCsv(report);
  }
}
