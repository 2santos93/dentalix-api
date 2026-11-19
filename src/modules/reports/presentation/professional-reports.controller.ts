import { ExtraPermission } from '@prisma/client';
import {
  Controller,
  Get,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import {
  RolesGuard,
  type PermissionAwareRequest,
} from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { AllowPermissions } from '../../auth/presentation/guards/permissions.decorator';
import {
  NO_SHOWS_CSV_ROLES,
  PROFESSIONAL_REPORT_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  PROFESSIONAL_REPORT_INVALID_PERIOD_MESSAGE,
  PROFESSIONAL_REPORT_PERIOD_TOO_LONG_MESSAGE,
} from '../application/professional-report-scope';
import {
  GetProfessionalProductivityUseCase,
  PRODUCTIVITY_FORBIDDEN_MESSAGE,
  PRODUCTIVITY_OWN_ONLY_MESSAGE,
  type ProfessionalProductivity,
  type ProfessionalReportInput,
} from '../application/use-cases/get-professional-productivity.use-case';
import {
  GetNoShowsUseCase,
  NO_SHOWS_CSV_MAX_ROWS,
  NO_SHOWS_FORBIDDEN_MESSAGE,
  NO_SHOWS_OWN_ONLY_MESSAGE,
  type NoShowsReport,
} from '../application/use-cases/get-no-shows.use-case';
import {
  toNoShowsCsv,
  toProfessionalProductivityCsv,
} from '../application/professional-reports-csv';
import {
  NoShowsQueryDto,
  NoShowsReportDto,
  ProfessionalProductivityDto,
  ProfessionalReportQueryDto,
} from './dto/professional-reports.dto';

export const NO_SHOWS_CSV_FORBIDDEN_MESSAGE =
  'Solo la administración puede exportar las inasistencias: llevan nombres de pacientes.';

interface AuthenticatedRequest extends PermissionAwareRequest {
  // RolesGuard ya exige un token de clínica (con rol).
  user: TenantJwtPayload;
}

const BAD_REQUEST = `${PROFESSIONAL_REPORT_INVALID_PERIOD_MESSAGE} / ${PROFESSIONAL_REPORT_PERIOD_TOO_LONG_MESSAGE} / filtros inválidos`;
const CONFLICT =
  'LOCATION_TIMEZONE_REQUIRED: una sede con citas o realizados no tiene zona horaria';

const PRODUCTIVITY_SCOPE =
  'Una fila por profesional con algo en el período: producción atribuible (Σ precio − descuento de los procedimientos que REALIZÓ, DX-050, por `completedAt` en la zona de la sede donde se realizaron y moneda del plan), cobrado atribuible (lo imputado a esos procedimientos desde abonos vivos con `paidAt` en el período, en la moneda del plan) y sus citas atendidas, no asistidas y canceladas tarde (DX-279) con el no-show % de kpi-definitions. ' +
  'Importes por moneda, nunca sumados entre monedas. Solo las sedes que ve quien consulta (DX-089). ADMIN o FINANCIAL_REPORTS_VIEW ve todo el equipo (scope CLINIC); un DENTIST, solo su fila (scope OWN); recepción y asistente, 403. Sin datos de pacientes.';

const NO_SHOWS_SCOPE =
  'El no-show % del período con la definición de kpi-definitions (no asistió ÷ atendidas + no asistió + cancelaciones tardías, DX-279) y la lista de las citas «No asistió» y canceladas tarde, de la más reciente a la más antigua (`page`/`pageSize`, 25 por defecto, máx. 100), con paciente, profesional, sede, tipo, motivo y aviso. ' +
  'Por inicio de la cita en la zona de su sede y solo en las sedes que ve quien consulta (DX-089). ADMIN o FINANCIAL_REPORTS_VIEW ve toda la clínica; un DENTIST, solo las de su agenda; recepción y asistente, 403. Lleva el nombre del paciente: auditado (VIEW).';

// «Profesionales» e «Inasistencias» (DX-304).
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PROFESSIONAL_REPORT_ROLES)
@Controller('reports')
export class ProfessionalReportsController {
  constructor(
    private readonly productivity: GetProfessionalProductivityUseCase,
    private readonly noShows: GetNoShowsUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  private input(
    query: ProfessionalReportQueryDto,
    req: AuthenticatedRequest,
  ): ProfessionalReportInput {
    return {
      from: query.from,
      to: query.to,
      locationId: query.locationId,
      professionalId: query.professionalId,
      actor: {
        userId: req.user.sub,
        role: req.user.role,
        permissions: req.effectivePermissions ?? [],
      },
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
    };
  }

  @RolesDeniedMessage(PRODUCTIVITY_FORBIDDEN_MESSAGE)
  @AllowPermissions(ExtraPermission.FINANCIAL_REPORTS_VIEW)
  @Get('professional-productivity')
  @ApiOperation({
    summary:
      'Productividad por profesional: producción, cobrado, citas atendidas y no-show',
    description: PRODUCTIVITY_SCOPE,
  })
  @ApiOkResponse({ type: ProfessionalProductivityDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({
    description: `${PRODUCTIVITY_FORBIDDEN_MESSAGE} / ${PRODUCTIVITY_OWN_ONLY_MESSAGE} / sede fuera de las del usuario`,
  })
  @ApiConflictResponse({ description: CONFLICT })
  getProductivity(
    @Query() query: ProfessionalReportQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ProfessionalProductivity> {
    return this.productivity.execute(this.input(query, req));
  }

  @RolesDeniedMessage(PRODUCTIVITY_FORBIDDEN_MESSAGE)
  @AllowPermissions(ExtraPermission.FINANCIAL_REPORTS_VIEW)
  @Get('professional-productivity.csv')
  @ApiOperation({
    summary: 'Productividad por profesional en CSV (mismos filtros)',
    description: `${PRODUCTIVITY_SCOPE} Las mismas filas que la pantalla (una línea por profesional y moneda; las citas, en la primera) y el total por moneda, con el período y los filtros en la cabecera; UTF-8 con BOM; celdas protegidas contra fórmulas.`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Fichero CSV',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: PRODUCTIVITY_FORBIDDEN_MESSAGE })
  @ApiConflictResponse({ description: CONFLICT })
  async productivityCsv(
    @Query() query: ProfessionalReportQueryDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.productivity.execute(this.input(query, req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="productividad-profesionales-${report.from}-${report.to}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return toProfessionalProductivityCsv(report);
  }

  @Audit({ action: 'VIEW', resource: 'APPOINTMENT', reason: 'NO_SHOW_REPORT' })
  @RolesDeniedMessage(NO_SHOWS_FORBIDDEN_MESSAGE)
  @AllowPermissions(ExtraPermission.FINANCIAL_REPORTS_VIEW)
  @Get('no-shows')
  @ApiOperation({
    summary:
      'Inasistencias: no-show % del período y lista de citas no asistidas y canceladas tarde',
    description: NO_SHOWS_SCOPE,
  })
  @ApiOkResponse({ type: NoShowsReportDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({
    description: `${NO_SHOWS_FORBIDDEN_MESSAGE} / ${NO_SHOWS_OWN_ONLY_MESSAGE} / sede fuera de las del usuario`,
  })
  @ApiConflictResponse({ description: CONFLICT })
  getNoShows(
    @Query() query: NoShowsQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<NoShowsReport> {
    return this.noShows.execute({
      ...this.input(query, req),
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Audit({
    action: 'EXPORT',
    resource: 'APPOINTMENT',
    reason: 'NO_SHOW_REPORT',
  })
  @Roles(...NO_SHOWS_CSV_ROLES)
  @RolesDeniedMessage(NO_SHOWS_CSV_FORBIDDEN_MESSAGE)
  @Get('no-shows.csv')
  @ApiOperation({
    summary: 'Inasistencias en CSV (mismos filtros, sin paginar)',
    description: `El resumen y las citas del período (como mucho ${NO_SHOWS_CSV_MAX_ROWS}, las más recientes; si hay más, lo avisa la cabecera), con fecha y hora en la zona de su sede. Lleva nombres de pacientes: solo ADMIN, y cada descarga deja un evento EXPORT en la auditoría. UTF-8 con BOM; celdas protegidas contra fórmulas.`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Fichero CSV',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: NO_SHOWS_CSV_FORBIDDEN_MESSAGE })
  @ApiConflictResponse({ description: CONFLICT })
  async noShowsCsv(
    @Query() query: ProfessionalReportQueryDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.noShows.exportAll(this.input(query, req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="inasistencias-${report.from}-${report.to}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return toNoShowsCsv(report);
  }
}
