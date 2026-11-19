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
  ACQUISITION_CSV_ROLES,
  ACQUISITION_REPORT_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import { CSV_RESPONSE, sendCsv } from '../../../shared/csv/csv-response';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  ACQUISITION_INVALID_PERIOD_MESSAGE,
  ACQUISITION_PERIOD_TOO_LONG_MESSAGE,
  GetAcquisitionUseCase,
  type AcquisitionReport,
} from '../application/use-cases/get-acquisition.use-case';
import { toAcquisitionCsv } from '../application/acquisition-csv';
import {
  AcquisitionQueryDto,
  AcquisitionReportDto,
} from './dto/acquisition.dto';

export const ACQUISITION_FORBIDDEN_MESSAGE =
  'Solo la administración y quien tenga acceso a los reportes financieros ven la captación de pacientes.';
export const ACQUISITION_CSV_FORBIDDEN_MESSAGE =
  'Solo la administración descarga la captación de pacientes.';

const SCOPE =
  'Pacientes dados de alta en el período por «¿Cómo nos conoció?» (DX-172) y lo cobrado a esos pacientes en el período: abonos no anulados, por moneda, sin convertir. ' +
  'La sede de captación de un paciente es la de su PRIMERA cita (la ficha es de la clínica); sin citas, no es de ninguna y solo cuenta en «Todas las sedes» para quien las ve todas. Día civil: el de esa sede (sin sede, el de la principal); el de un abono, el de su sede. ' +
  'Filas: las fuentes activas (también con 0), las desactivadas que trajeron pacientes y «Sin dato»; y los 10 pacientes que más pacientes nuevos recomendaron. Solo las sedes que ve quien consulta (DX-089).';

const BAD_REQUEST = `${ACQUISITION_INVALID_PERIOD_MESSAGE} / ${ACQUISITION_PERIOD_TOO_LONG_MESSAGE} / filtros inválidos`;
const CONFLICT =
  'LOCATION_TIMEZONE_REQUIRED: una sede con abonos no tiene zona horaria';

// «Captación» (DX-172). El JSON lleva los nombres de los pacientes que más
// recomiendan: auditado (VIEW). El CSV, sin datos de pacientes, sale de la
// clínica: auditado (EXPORT) y solo ADMIN.
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...ACQUISITION_REPORT_ROLES)
@RolesDeniedMessage(ACQUISITION_FORBIDDEN_MESSAGE)
@Controller('reports')
export class AcquisitionController {
  constructor(
    private readonly acquisition: GetAcquisitionUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  private run(query: AcquisitionQueryDto): Promise<AcquisitionReport> {
    return this.acquisition.execute({
      from: query.from,
      to: query.to,
      locationId: query.locationId,
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
    });
  }

  @Audit({ action: 'VIEW', resource: 'PATIENT', reason: 'ACQUISITION_REPORT' })
  @AllowPermissions(ExtraPermission.FINANCIAL_REPORTS_VIEW)
  @Get('acquisition')
  @ApiOperation({
    summary: 'Captación: pacientes nuevos y lo cobrado por fuente',
    description: SCOPE,
  })
  @ApiOkResponse({ type: AcquisitionReportDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({
    description: `${ACQUISITION_FORBIDDEN_MESSAGE} / No tienes acceso a esta sede.`,
  })
  @ApiConflictResponse({ description: CONFLICT })
  get(@Query() query: AcquisitionQueryDto): Promise<AcquisitionReport> {
    return this.run(query);
  }

  @Audit({
    action: 'EXPORT',
    resource: 'PATIENT',
    reason: 'ACQUISITION_REPORT',
  })
  @Roles(...ACQUISITION_CSV_ROLES)
  @RolesDeniedMessage(ACQUISITION_CSV_FORBIDDEN_MESSAGE)
  @Get('acquisition.csv')
  @ApiOperation({
    summary: 'Captación en CSV (mismos filtros; solo ADMIN)',
    description: `${SCOPE} Una fila por fuente y el total, con lo cobrado en una columna por moneda; cabecera con período y sede. Sin datos de pacientes. UTF-8 con BOM; celdas protegidas contra fórmulas. Auditado (EXPORT).`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV_RESPONSE)
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({
    description: `${ACQUISITION_CSV_FORBIDDEN_MESSAGE} / No tienes acceso a esta sede.`,
  })
  @ApiConflictResponse({ description: CONFLICT })
  async csv(
    @Query() query: AcquisitionQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.run(query);
    sendCsv(res, `captacion-${report.period.from}-${report.period.to}.csv`);
    return toAcquisitionCsv(report);
  }
}
