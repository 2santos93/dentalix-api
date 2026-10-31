import {
  Controller,
  Get,
  Inject,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  CURRENCY_DIGITS_CATALOG,
  type CurrencyDigitsCatalog,
} from '../../../shared/money/currency-digits';
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
import { ListExpensesUseCase } from '../application/use-cases/list-expenses.use-case';
import { CSV_RESPONSE, sendCsv } from '../../../shared/csv/csv-response';
import { ExportExpensesQueryDto } from './dto/expense-requests.dto';

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description: 'Sede activa. Sin ella, todas las sedes que el usuario ve.',
};

/**
 * CSV de los gastos (DX-274, solo ADMIN). Controlador sin prefijo porque
 * `expenses.csv` cuelga de la raíz; el resumen y su CSV viven en
 * `ExpensesController`, encima de `:id`.
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
    // DX-340: decimales de cada moneda (currencies.rounding_digits).
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly currencyDigits: CurrencyDigitsCatalog,
  ) {}

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
    return toExpensesCsv(
      items,
      locationNames,
      await this.currencyDigits.table(),
    );
  }
}
