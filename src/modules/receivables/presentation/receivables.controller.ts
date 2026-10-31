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
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  RECEIVABLES_EXPORT_ROLES,
  RECEIVABLES_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import { GetReceivablesAgingUseCase } from '../application/use-cases/get-receivables-aging.use-case';
import { toReceivablesCsv } from '../application/receivables-csv';
import {
  ReceivablesAgingFiltersDto,
  ReceivablesAgingQueryDto,
} from './dto/receivables-aging-query.dto';
import {
  ReceivablesAgingPageDto,
  ReceivablesAgingSummaryDto,
} from './dto/receivables-aging.dto';

export const RECEIVABLES_FORBIDDEN_MESSAGE =
  'Tu rol no tiene acceso a la cartera: es para administración y recepción.';
export const RECEIVABLES_EXPORT_FORBIDDEN_MESSAGE =
  'Solo la administración puede exportar la cartera.';

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description:
    'Sede activa. El parámetro `locationId` manda sobre ella; sin ninguno, toda la clínica.',
};

// Cartera por antigüedad (DX-145): dato FINANCIERO de muchos pacientes ->
// RECEIVABLES_ROLES (ADMIN + RECEPTION), con 403 en español para el resto.
// El CSV, solo ADMIN. Las dos lecturas quedan auditadas (DX-009): el evento no
// lleva paciente (es una lista), pero sí quién vio o se llevó importes y
// teléfonos; `reason` las distingue del estado de cuenta de un paciente.
@ApiTags('receivables')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...RECEIVABLES_ROLES)
@RolesDeniedMessage(RECEIVABLES_FORBIDDEN_MESSAGE)
@Controller('receivables')
export class ReceivablesController {
  constructor(
    private readonly getAging: GetReceivablesAgingUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Sede explícita (DX-089: tiene que ser permitida, si no 403) o la del
   * request. Sin ninguna, el repositorio acota a las sedes permitidas.
   */
  private locationOf(query: ReceivablesAgingFiltersDto): string | undefined {
    if (query.locationId) {
      this.tenantContext.assertLocationAllowed(query.locationId);
    }
    return query.locationId ?? this.tenantContext.getLocationId();
  }

  // Inicio (I1): solo los totales por moneda (pacientes, saldo, tramos), sin
  // ninguna fila de paciente ni teléfono, así que no lleva @Audit (mismo
  // criterio que GET /closing-queue/count). Mismos filtros, sede y roles que
  // la lista: los totales son los mismos que pinta la cabecera de la cartera.
  @Get('aging/summary')
  @ApiOperation({
    summary: 'Totales de la cartera por antigüedad, sin pacientes',
    description:
      'Los `totals` de GET /receivables/aging con los mismos filtros, sin filas. Por moneda, sin convertir.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({ type: ReceivablesAgingSummaryDto })
  @ApiBadRequestResponse({
    description: 'Filtro inválido o sede que no es de esta clínica',
  })
  @ApiForbiddenResponse({ description: RECEIVABLES_FORBIDDEN_MESSAGE })
  async summary(
    @Query() query: ReceivablesAgingFiltersDto,
  ): Promise<ReceivablesAgingSummaryDto> {
    const page = await this.getAging.execute({
      locationId: this.locationOf(query),
      currency: query.currency,
      minBalance: query.minBalance,
      minAgeDays: query.minAgeDays,
      providerId: query.providerId,
      hasPromise: query.hasPromise,
      page: 1,
      pageSize: 1,
    });
    return { asOf: page.asOf, scope: page.scope, totals: page.totals };
  }

  @Audit({
    action: 'VIEW',
    resource: 'ACCOUNT_STATEMENT',
    reason: 'RECEIVABLES_AGING',
  })
  @Get('aging')
  @ApiOperation({
    summary:
      'Cartera por antigüedad: deudores de la sede con tramos 0–30/31–60/61–90/>90 por moneda',
    description:
      'El saldo de cada paciente es el de su estado de cuenta (mismo cálculo), ' +
      'repartido por antigüedad: cada cuota desde su vencimiento; el saldo sin ' +
      'cuotas desde la aceptación (o presentación, o creación) del plan, con ' +
      '`ageApproximate`. Días civiles de la zona de la sede. Por moneda, sin ' +
      'convertir; el saldo a favor va aparte. Sin datos clínicos. DX-150: ' +
      'cada fila trae su última gestión de cobro y su último compromiso de ' +
      'pago; filtros `providerId` y `hasPromise`.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({ type: ReceivablesAgingPageDto })
  @ApiBadRequestResponse({
    description: 'Filtro inválido o sede que no es de esta clínica',
  })
  @ApiForbiddenResponse({ description: RECEIVABLES_FORBIDDEN_MESSAGE })
  list(
    @Query() query: ReceivablesAgingQueryDto,
  ): Promise<ReceivablesAgingPageDto> {
    return this.getAging.execute({
      locationId: this.locationOf(query),
      currency: query.currency,
      minBalance: query.minBalance,
      minAgeDays: query.minAgeDays,
      providerId: query.providerId,
      hasPromise: query.hasPromise,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Audit({
    action: 'EXPORT',
    resource: 'ACCOUNT_STATEMENT',
    reason: 'RECEIVABLES_AGING',
  })
  @Roles(...RECEIVABLES_EXPORT_ROLES)
  @RolesDeniedMessage(RECEIVABLES_EXPORT_FORBIDDEN_MESSAGE)
  @Get('aging.csv')
  @ApiOperation({
    summary: 'Cartera por antigüedad en CSV (mismos filtros, sin paginar)',
    description:
      'Una línea por paciente y moneda, UTF-8 con BOM. La columna «Fecha ' +
      'aproximada» marca la deuda que envejece desde la fecha del plan. Solo ' +
      'ADMIN; cada descarga deja un evento EXPORT en la auditoría.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Fichero CSV',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({
    description: 'Filtro inválido o sede que no es de esta clínica',
  })
  @ApiForbiddenResponse({ description: RECEIVABLES_EXPORT_FORBIDDEN_MESSAGE })
  async csv(
    @Query() query: ReceivablesAgingFiltersDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const rows = await this.getAging.exportRows({
      locationId: this.locationOf(query),
      currency: query.currency,
      minBalance: query.minBalance,
      minAgeDays: query.minAgeDays,
      providerId: query.providerId,
      hasPromise: query.hasPromise,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="cartera-por-antiguedad.csv"',
    );
    // Dato personal: ni el navegador ni un proxy lo guardan.
    res.setHeader('Cache-Control', 'no-store');
    return toReceivablesCsv(rows);
  }
}
