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
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  GetLocationsComparisonUseCase,
  type LocationsComparison,
} from '../application/use-cases/get-locations-comparison.use-case';
import { toLocationsComparisonCsv } from '../application/locations-comparison-csv';
import {
  LocationsComparisonDto,
  LocationsComparisonQueryDto,
} from './dto/locations-comparison.dto';

export const REPORTS_FORBIDDEN_MESSAGE =
  'Solo la administración ve los reportes de la clínica.';

const SCOPE =
  'Una fila por sede que ve quien consulta (DX-089: un miembro restringido solo ve las suyas, y el total solo las suma a ellas) y «Total clínica». ' +
  'La cabecera X-Location-Id no acota la comparación: siempre salen todas las sedes visibles. ' +
  'Indicadores (ver `kpis`, la definición de cada uno con su dirección): producción, cobrado, % de cobro, citas atendidas, no-show %, pacientes nuevos, ticket medio y ocupación %, ' +
  'en días civiles de la zona de cada sede (DX-097). Importes por moneda, sin convertir ni sumar monedas distintas. ' +
  'Con `compare`, cada valor trae el del período anterior, su variación % y si mejora o empeora.';

const BAD_REQUEST =
  'Período inválido o de más de 366 días, `compare` o `currency` inválidos';

// «Reportes» (DX-014): solo ADMIN. Sin auditoría, como el dashboard: son
// sumas por sede, sin datos de ningún paciente.
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...REPORT_ROLES)
@RolesDeniedMessage(REPORTS_FORBIDDEN_MESSAGE)
@Controller('reports')
export class LocationsComparisonController {
  constructor(
    private readonly comparison: GetLocationsComparisonUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  private run(
    query: LocationsComparisonQueryDto,
  ): Promise<LocationsComparison> {
    return this.comparison.execute({
      from: query.from,
      to: query.to,
      compare: query.compare ?? 'previous',
      currency: query.currency,
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
    });
  }

  @Get('locations-comparison')
  @ApiOperation({
    summary: 'Comparar sedes: indicadores por sede frente a otro período',
    description: SCOPE,
  })
  @ApiOkResponse({ type: LocationsComparisonDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: REPORTS_FORBIDDEN_MESSAGE })
  get(
    @Query() query: LocationsComparisonQueryDto,
  ): Promise<LocationsComparison> {
    return this.run(query);
  }

  @Get('locations-comparison.csv')
  @ApiOperation({
    summary: 'Comparar sedes en CSV (mismos filtros)',
    description: `${SCOPE} Una línea por sede, indicador y moneda; UTF-8 con BOM; celdas protegidas contra fórmulas.`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Fichero CSV',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: REPORTS_FORBIDDEN_MESSAGE })
  async csv(
    @Query() query: LocationsComparisonQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.run(query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="comparar-sedes-${report.from}-${report.to}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return toLocationsComparisonCsv(report);
  }
}
