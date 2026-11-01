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
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { DISCOUNT_REPORT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  GetDiscountReportUseCase,
  type DiscountReport,
} from '../application/use-cases/get-discount-report.use-case';
import { toDiscountReportCsv } from '../application/discount-report-csv';
import {
  DiscountReportDto,
  DiscountReportFiltersDto,
  DiscountReportQueryDto,
} from './dto/discount-report.dto';

export const DISCOUNT_REPORT_FORBIDDEN_MESSAGE =
  'Solo la administración ve el informe de descuentos.';

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description:
    'Sede activa. El parámetro `locationId` manda sobre ella; sin ninguno, toda la clínica.',
};

const SCOPE =
  'Ítems vivos (no retirados, de planes vivos y no anulados: ni rechazados ' +
  'ni cancelados) con descuento > 0, fechados ' +
  'por su descuento (antes de DX-204, por su alta) en días civiles de la zona ' +
  'de su sede. La sede es la del descuento (antes de DX-204, la de ' +
  'presentación del plan). Los totales cuadran con la suma de `discount` de ' +
  'esos ítems; el bruto es la suma de su precio. Por moneda, sin convertir.';

// Informe «Descuentos» (DX-204): solo ADMIN. Ver y exportar quedan auditados
// (VIEW / EXPORT de TREATMENT_PLAN_ITEM con `reason` DISCOUNT_REPORT): lleva
// nombres de pacientes e importes de muchos planes.
@ApiTags('discounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...DISCOUNT_REPORT_ROLES)
@RolesDeniedMessage(DISCOUNT_REPORT_FORBIDDEN_MESSAGE)
@Controller('reports')
export class DiscountReportController {
  constructor(
    private readonly report: GetDiscountReportUseCase,
    private readonly tenantContext: TenantContextService,
    // DX-340: decimales de cada moneda (currencies.rounding_digits).
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly currencyDigits: CurrencyDigitsCatalog,
  ) {}

  private filtersOf(query: DiscountReportFiltersDto) {
    return {
      from: query.from,
      to: query.to,
      locationId: query.locationId ?? this.tenantContext.getLocationId(),
      professionalId: query.professionalId,
    };
  }

  @Audit({
    action: 'VIEW',
    resource: 'TREATMENT_PLAN_ITEM',
    reason: 'DISCOUNT_REPORT',
  })
  @Get('discounts')
  @ApiOperation({
    summary: 'Informe de descuentos por periodo, sede y profesional',
    description: SCOPE,
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({ type: DiscountReportDto })
  @ApiBadRequestResponse({
    description:
      'Periodo inválido o de más de 366 días, o sede que no es de esta clínica',
  })
  @ApiForbiddenResponse({ description: DISCOUNT_REPORT_FORBIDDEN_MESSAGE })
  list(@Query() query: DiscountReportQueryDto): Promise<DiscountReport> {
    return this.report.execute({
      ...this.filtersOf(query),
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Audit({
    action: 'EXPORT',
    resource: 'TREATMENT_PLAN_ITEM',
    reason: 'DISCOUNT_REPORT',
  })
  @Get('discounts.csv')
  @ApiOperation({
    summary: 'Informe de descuentos en CSV (mismos filtros, sin paginar)',
    description: `${SCOPE} UTF-8 con BOM; celdas protegidas contra fórmulas.`,
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Fichero CSV',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({
    description:
      'Periodo inválido o de más de 366 días, o sede que no es de esta clínica',
  })
  @ApiForbiddenResponse({ description: DISCOUNT_REPORT_FORBIDDEN_MESSAGE })
  async csv(
    @Query() query: DiscountReportFiltersDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const rows = await this.report.exportRows(this.filtersOf(query));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="descuentos-${query.from}-${query.to}.csv"`,
    );
    // Dato personal: ni el navegador ni un proxy lo guardan.
    res.setHeader('Cache-Control', 'no-store');
    return toDiscountReportCsv(
      rows,
      await this.currencyDigits.table(rows.map((r) => r.currency)),
    );
  }
}
