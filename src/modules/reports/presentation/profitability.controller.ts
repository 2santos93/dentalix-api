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
import { PROFITABILITY_REPORT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { CSV_RESPONSE, sendCsv } from '../../../shared/csv/csv-response';
import {
  GetProfitabilityUseCase,
  type ProfitabilityInput,
  type ProfitabilityLines,
  type ProfitabilityReport,
} from '../application/use-cases/get-profitability.use-case';
import { toProfitabilityCsv } from '../application/profitability-csv';
import {
  ProfitabilityLinesDto,
  ProfitabilityLinesQueryDto,
  ProfitabilityQueryDto,
  ProfitabilityReportDto,
} from './dto/profitability.dto';

export const PROFITABILITY_FORBIDDEN_MESSAGE =
  'Solo la administración ve la rentabilidad de las sedes.';

const SCOPE =
  'Ingresos − gastos de cada sede que ve quien consulta (DX-089: un miembro restringido solo ve las suyas) y el «Total del grupo», que suma solo esas sedes. ' +
  '`basis=CASH` («Caja»): abonos no anulados − pagos de gastos no anulados, por fecha de pago. ' +
  '`basis=ACCRUAL` («Devengo»): producción realizada (precio − descuento de los ítems DONE, en la sede donde se realizaron) − gastos no anulados por fecha de factura, pagados o no. ' +
  'Días civiles en la zona de cada sede (DX-097). Gastos por categoría. Importes por moneda, sin convertir ni restar monedas distintas. ' +
  '`definition` trae la definición de la base (cabecera y «Cómo se calcula»). Sin datos de pacientes. La cabecera X-Location-Id no acota.';

const BAD_REQUEST =
  'Período inválido o de más de 366 días; `basis`, `locationId`, `side`, `currency`, `category` o la página inválidos';
const FORBIDDEN = `${PROFITABILITY_FORBIDDEN_MESSAGE} / sede fuera de las del usuario`;

// «Rentabilidad por sede» (DX-410): solo ADMIN (PROFITABILITY_REPORT_ROLES).
// Sin auditoría, como «Comparar sedes»: sumas por sede y filas sin ningún
// dato de paciente (nº de recibo, procedimiento, proveedor).
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PROFITABILITY_REPORT_ROLES)
@RolesDeniedMessage(PROFITABILITY_FORBIDDEN_MESSAGE)
@Controller('reports')
export class ProfitabilityController {
  constructor(
    private readonly profitability: GetProfitabilityUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  private input(query: ProfitabilityQueryDto): ProfitabilityInput {
    return {
      from: query.from,
      to: query.to,
      basis: query.basis,
      locationId: query.locationId,
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
    };
  }

  @Get('profitability')
  @ApiOperation({
    summary: 'Rentabilidad por sede: ingresos − gastos en base Caja o Devengo',
    description: SCOPE,
  })
  @ApiOkResponse({ type: ProfitabilityReportDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  get(@Query() query: ProfitabilityQueryDto): Promise<ProfitabilityReport> {
    return this.profitability.execute(this.input(query));
  }

  @Get('profitability.csv')
  @ApiOperation({
    summary: 'Rentabilidad por sede en CSV (mismos filtros y definición)',
    description: `${SCOPE} Por sede (y el total) y moneda: ingresos, una línea por categoría de gasto, total de gastos, resultado y margen, con la base en cada línea; UTF-8 con BOM; celdas protegidas contra fórmulas.`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV_RESPONSE)
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  async csv(
    @Query() query: ProfitabilityQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.profitability.execute(this.input(query));
    const basis = report.basis === 'CASH' ? 'caja' : 'devengo';
    sendCsv(res, `rentabilidad-${basis}-${report.from}-${report.to}.csv`);
    return toProfitabilityCsv(report);
  }

  @Get('profitability/lines')
  @ApiOperation({
    summary: 'Detalle de una cifra: los movimientos que la forman',
    description:
      'Mismos filtros y alcance que el informe, más el lado (`INCOME`/`EXPENSE`), la moneda y, en los gastos, la categoría: los abonos, procedimientos realizados, pagos de gastos o gastos que suman la cifra, del más reciente al más antiguo, con el `total` de todas las filas. Sin `locationId`, las de todas las sedes visibles (la cifra del total del grupo). Sin datos de pacientes.',
  })
  @ApiOkResponse({ type: ProfitabilityLinesDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  lines(
    @Query() query: ProfitabilityLinesQueryDto,
  ): Promise<ProfitabilityLines> {
    return this.profitability.lines({
      ...this.input(query),
      side: query.side,
      currency: query.currency,
      category: query.category,
      page: query.page,
      pageSize: query.pageSize,
    });
  }
}
