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
import { REPORT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  GetChairOccupancyUseCase,
  type ChairOccupancyReport,
} from '../application/use-cases/get-chair-occupancy.use-case';
import { toChairOccupancyCsv } from '../application/chair-occupancy-csv';
import {
  ChairOccupancyQueryDto,
  ChairOccupancyReportDto,
} from './dto/chair-occupancy.dto';
import { REPORTS_FORBIDDEN_MESSAGE } from './locations-comparison.controller';

const SCOPE =
  'Ocupación = reservados ÷ abiertos, por sede y sillón (DX-211), en días civiles de la zona de cada sede (DX-097). ' +
  'Abiertos (de cada sillón): el horario semanal de la sede (DX-122) en el período, menos los cierres de toda la sede (bloqueos sin profesional que no admiten citas) y los festivos de la sede (DX-316; los recurrentes, el mismo día y mes de cada año). ' +
  'Una sede sin tramos en su horario («sin restricción» en la agenda) sale como «Sin horario»: sin abiertos ni porcentajes. ' +
  'Reservados: minutos de las citas no canceladas (las inasistencias incluidas), recortados al período y al horario abierto; en un sillón las citas que se pisan cuentan una vez. ' +
  'Atendidos: lo mismo con las citas atendidas (COMPLETED). Las inasistencias (NO_SHOW) cuentan como reservadas y no atendidas, y van aparte. ' +
  'Porcentajes de 0 a 1 con tope en 1. Las citas sin sillón van en «Sin sillón» (sumadas cita a cita, sin porcentaje) y no entran en el total de la sede, que suma sus sillones sobre abiertos × sillones. ' +
  'Un sillón desactivado solo sale si tuvo citas. Solo ADMIN; un miembro restringido (DX-089) solo ve sus sedes. Sin datos de pacientes.';

const BAD_REQUEST = 'Período inválido o de más de 366 días';
const FORBIDDEN = `${REPORTS_FORBIDDEN_MESSAGE} / sede fuera de las del usuario`;
const CONFLICT =
  'LOCATION_TIMEZONE_REQUIRED: una sede con citas no tiene zona horaria válida';

// «Ocupación por sillón» (DX-481). La pantalla son agregados sin pacientes
// (sin auditoría, como «Comparar sedes»); el CSV se audita (EXPORT) porque
// sale de la clínica.
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...REPORT_ROLES)
@RolesDeniedMessage(REPORTS_FORBIDDEN_MESSAGE)
@Controller('reports')
export class ChairOccupancyController {
  constructor(
    private readonly chairOccupancy: GetChairOccupancyUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  private run(query: ChairOccupancyQueryDto): Promise<ChairOccupancyReport> {
    return this.chairOccupancy.execute({
      from: query.from,
      to: query.to,
      locationId: query.locationId,
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
    });
  }

  @Get('chair-occupancy')
  @ApiOperation({
    summary:
      'Ocupación por sillón: minutos abiertos, reservados y atendidos por sede y sillón',
    description: SCOPE,
  })
  @ApiOkResponse({ type: ChairOccupancyReportDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiConflictResponse({ description: CONFLICT })
  get(@Query() query: ChairOccupancyQueryDto): Promise<ChairOccupancyReport> {
    return this.run(query);
  }

  @Audit({
    action: 'EXPORT',
    resource: 'APPOINTMENT',
    reason: 'CHAIR_OCCUPANCY_REPORT',
  })
  @Get('chair-occupancy.csv')
  @ApiOperation({
    summary: 'Ocupación por sillón en CSV (mismos filtros, auditado)',
    description: `${SCOPE} Una fila por sillón, la de «Sin sillón» y el total de cada sede, con la fórmula en la cabecera. UTF-8 con BOM; celdas protegidas contra fórmulas. Cada descarga queda en auditoría (EXPORT).`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Fichero CSV',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiConflictResponse({ description: CONFLICT })
  async csv(
    @Query() query: ChairOccupancyQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.run(query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ocupacion-sillones-${report.from}-${report.to}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return toChairOccupancyCsv(report);
  }
}
