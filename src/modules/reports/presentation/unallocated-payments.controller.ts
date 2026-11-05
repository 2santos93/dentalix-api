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
import { UNALLOCATED_PAYMENTS_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  GetUnallocatedPaymentsUseCase,
  type UnallocatedPayments,
} from '../application/use-cases/get-unallocated-payments.use-case';
import { toUnallocatedPaymentsCsv } from '../application/unallocated-payments-csv';
import {
  UnallocatedPaymentsFiltersDto,
  UnallocatedPaymentsPageDto,
  UnallocatedPaymentsQueryDto,
} from './dto/unallocated-payments.dto';

export const UNALLOCATED_PAYMENTS_FORBIDDEN_MESSAGE =
  'Tu rol no tiene acceso a lo cobrado sin imputar: es para administración y recepción.';

const SCOPE =
  'Abonos vivos a un plan que se cobra (ni cancelado ni rechazado) de pacientes vivos, con base en la moneda del plan, cuyo día civil (en la zona de la sede del abono) cae en el período y cuya sede ve quien consulta (DX-089). ' +
  '`allocated` es la suma de sus imputaciones vivas y `unallocated` la base menos lo imputado (> 0), por moneda del plan y sin convertir: son las cifras de GET /payments/:id/allocations. ' +
  'Los abonos sin tasa para su día (sin base) no se pueden imputar: se cuentan en `paymentsWithoutRateCount`. Sin datos clínicos.';

const BAD_REQUEST = 'Período inválido o de más de 24 meses';

// «Cobrado sin imputar / a cuenta» (DX-399): lista de abonos de muchos
// pacientes con importes. ADMIN y recepción (los roles de cobro); el evento
// de auditoría no lleva paciente (es una lista) pero sí quién la vio o se la
// llevó.
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...UNALLOCATED_PAYMENTS_ROLES)
@RolesDeniedMessage(UNALLOCATED_PAYMENTS_FORBIDDEN_MESSAGE)
@Controller('reports')
export class UnallocatedPaymentsController {
  constructor(
    private readonly unallocated: GetUnallocatedPaymentsUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Audit({
    action: 'VIEW',
    resource: 'ACCOUNT_STATEMENT',
    reason: 'UNALLOCATED_PAYMENTS',
  })
  @Get('unallocated-payments')
  @ApiOperation({
    summary: 'Cobrado sin imputar / a cuenta, por abono',
    description: SCOPE,
  })
  @ApiOkResponse({ type: UnallocatedPaymentsPageDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({
    description: `${UNALLOCATED_PAYMENTS_FORBIDDEN_MESSAGE} / sede fuera de las del usuario`,
  })
  list(
    @Query() query: UnallocatedPaymentsQueryDto,
  ): Promise<UnallocatedPayments> {
    return this.unallocated.execute({
      from: query.from,
      to: query.to,
      locationId: query.locationId,
      page: query.page,
      pageSize: query.pageSize,
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
    });
  }

  @Audit({
    action: 'EXPORT',
    resource: 'ACCOUNT_STATEMENT',
    reason: 'UNALLOCATED_PAYMENTS',
  })
  @Get('unallocated-payments.csv')
  @ApiOperation({
    summary:
      'Cobrado sin imputar / a cuenta en CSV (mismos filtros, sin paginar)',
    description: `${SCOPE} Las mismas filas que la pantalla, todas, con el período y la sede en la cabecera y los totales por moneda al final; UTF-8 con BOM; celdas protegidas contra fórmulas. Cada descarga deja un evento EXPORT en la auditoría.`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Fichero CSV',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({
    description: `${UNALLOCATED_PAYMENTS_FORBIDDEN_MESSAGE} / sede fuera de las del usuario`,
  })
  async csv(
    @Query() query: UnallocatedPaymentsFiltersDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.unallocated.exportAll({
      from: query.from,
      to: query.to,
      locationId: query.locationId,
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="cobrado-sin-imputar-${report.from}-${report.to}.csv"`,
    );
    // Dato personal y financiero: ni el navegador ni un proxy lo guardan.
    res.setHeader('Cache-Control', 'no-store');
    return toUnallocatedPaymentsCsv(report);
  }
}
