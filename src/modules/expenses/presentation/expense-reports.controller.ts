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
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { EXPENSE_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import { toExpensesCsv } from '../application/expenses-csv';
import { toExpensesSummaryCsv } from '../application/expenses-summary-csv';
import { GetExpenseSummaryUseCase } from '../application/use-cases/get-expense-summary.use-case';
import { ListExpensesUseCase } from '../application/use-cases/list-expenses.use-case';
import {
  ExpenseSummaryQueryDto,
  ExportExpensesQueryDto,
} from './dto/expense-requests.dto';
import { ExpenseSummaryDto } from './dto/expense.dto';

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description: 'Sede activa. Sin ella, todas las sedes que el usuario ve.',
};
const CSV_RESPONSE = {
  description: 'Fichero CSV',
  content: { 'text/csv': { schema: { type: 'string' } } },
};

/**
 * Resumen mensual y exportaciones CSV de los gastos (DX-274, solo ADMIN).
 * Controlador sin prefijo porque `expenses.csv` cuelga de la raíz; sus rutas
 * fijas (`expenses/summary`, `expenses/summary.csv`) tienen que registrarse
 * ANTES que `expenses/:id`, por eso el módulo lo declara primero.
 */
@ApiTags('expenses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...EXPENSE_ROLES)
@Controller()
export class ExpenseReportsController {
  constructor(
    private readonly listExpenses: ListExpensesUseCase,
    private readonly summary: GetExpenseSummaryUseCase,
  ) {}

  @Audit({ action: 'VIEW', resource: 'EXPENSE', reason: 'EXPENSE_SUMMARY' })
  @Get('expenses/summary')
  @ApiOperation({
    summary: 'Resumen mensual: ingresos − gastos por sede y moneda',
    description:
      'Gastos no anulados por fecha de factura (devengado), con su desglose por categoría; ingresos = abonos vivos por el día civil de la sede. Rango de hasta 366 días; las monedas no se convierten. Respeta las sedes permitidas del usuario.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({ type: ExpenseSummaryDto })
  @ApiBadRequestResponse({
    description: 'Periodo no válido o de más de 366 días',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  summaryOf(
    @Query() query: ExpenseSummaryQueryDto,
  ): ReturnType<GetExpenseSummaryUseCase['execute']> {
    return this.summary.execute(query);
  }

  @Audit({ action: 'EXPORT', resource: 'EXPENSE', reason: 'EXPENSE_SUMMARY' })
  @Get('expenses/summary.csv')
  @ApiOperation({ summary: 'Resumen mensual en CSV' })
  @ApiHeader(LOCATION_HEADER)
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV_RESPONSE)
  @ApiBadRequestResponse({
    description: 'Periodo no válido o de más de 366 días',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async summaryCsv(
    @Query() query: ExpenseSummaryQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const summary = await this.summary.execute(query);
    sendCsv(res, `gastos-resumen-${summary.from}-${summary.to}.csv`);
    return toExpensesSummaryCsv(summary.rows);
  }

  @Audit({ action: 'EXPORT', resource: 'EXPENSE', reason: 'EXPENSE_LIST' })
  @Get('expenses.csv')
  @ApiOperation({
    summary: 'Gastos en CSV (mismos filtros que la lista, sin paginar)',
    description:
      'UTF-8 con BOM; celdas protegidas contra fórmulas; importes con los decimales de su moneda. Hasta 10 000 filas.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV_RESPONSE)
  @ApiBadRequestResponse({
    description: 'Filtros no válidos o más de 10 000 gastos',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async expensesCsv(
    @Query() query: ExportExpensesQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { items, locationNames } = await this.listExpenses.exportAll(query);
    sendCsv(res, `gastos-${query.from ?? 'inicio'}-${query.to ?? 'hoy'}.csv`);
    return toExpensesCsv(items, locationNames);
  }
}

function sendCsv(res: Response, filename: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Datos de gestión de la clínica: ni el navegador ni un proxy los guardan.
  res.setHeader('Cache-Control', 'no-store');
}
