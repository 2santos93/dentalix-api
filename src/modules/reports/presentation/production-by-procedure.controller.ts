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
import { PRODUCTION_REPORT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  GetProductionByProcedureUseCase,
  PRODUCTION_OWN_ONLY_MESSAGE,
  type ProductionByProcedure,
  type ProductionFiltersInput,
  type ProductionItems,
} from '../application/use-cases/get-production-by-procedure.use-case';
import { toProductionByProcedureCsv } from '../application/production-by-procedure-csv';
import {
  ProductionByProcedureDto,
  ProductionByProcedureQueryDto,
  ProductionItemsDto,
  ProductionItemsQueryDto,
} from './dto/production-by-procedure.dto';

export const PRODUCTION_REPORT_FORBIDDEN_MESSAGE =
  'Solo la administración y los odontólogos ven la producción por procedimiento.';

interface AuthenticatedRequest {
  // RolesGuard ya exige un token de clínica (con rol).
  user: TenantJwtPayload;
}

const SCOPE =
  'Ítems de plan REALIZADOS (DONE), vivos y de planes vivos, con `completedAt` en el período (días civiles en la zona de la sede) ' +
  'y `performedLocationId` en una de las sedes que ve quien consulta (DX-089): cuenta la sede donde se REALIZÓ, no la del paciente. ' +
  'Agrupado por categoría y código del catálogo, por moneda del plan sin convertir (subtotal y total por moneda, nunca mezclados). ' +
  'ADMIN ve todo el equipo; un DENTIST, solo lo suyo. Los realizados sin fecha o sin sede salen en `unattributed` («Sin atribuir», DX-305). ' +
  'Sin nombres de paciente.';

const BAD_REQUEST = 'Período inválido o de más de 24 meses';
const FORBIDDEN = `${PRODUCTION_REPORT_FORBIDDEN_MESSAGE} / ${PRODUCTION_OWN_ONLY_MESSAGE} / sede fuera de las del usuario`;

// «Producción por procedimiento» (DX-423). El agregado y el CSV no llevan
// datos de pacientes (como «Comparar sedes», sin auditoría); el detalle de una
// fila sí (nombre del paciente) y queda auditado como VIEW.
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PRODUCTION_REPORT_ROLES)
@RolesDeniedMessage(PRODUCTION_REPORT_FORBIDDEN_MESSAGE)
@Controller('reports')
export class ProductionByProcedureController {
  constructor(
    private readonly production: GetProductionByProcedureUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  private input(
    query: ProductionByProcedureQueryDto,
    req: AuthenticatedRequest,
  ): ProductionFiltersInput {
    return {
      from: query.from,
      to: query.to,
      locationId: query.locationId,
      professionalId: query.professionalId,
      category: query.category,
      actor: { userId: req.user.sub, role: req.user.role },
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
    };
  }

  @Get('production-by-procedure')
  @ApiOperation({
    summary:
      'Producción por procedimiento y categoría, con honorario medio frente a catálogo',
    description: SCOPE,
  })
  @ApiOkResponse({ type: ProductionByProcedureDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  get(
    @Query() query: ProductionByProcedureQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ProductionByProcedure> {
    return this.production.execute(this.input(query, req));
  }

  @Get('production-by-procedure.csv')
  @ApiOperation({
    summary: 'Producción por procedimiento en CSV (mismos filtros)',
    description: `${SCOPE} Las mismas filas, subtotales y totales que la pantalla, con el período y los filtros en la cabecera; UTF-8 con BOM; celdas protegidas contra fórmulas.`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Fichero CSV',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  async csv(
    @Query() query: ProductionByProcedureQueryDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.production.execute(this.input(query, req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="produccion-por-procedimiento-${report.from}-${report.to}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return toProductionByProcedureCsv(report);
  }

  @Audit({
    action: 'VIEW',
    resource: 'TREATMENT_PLAN_ITEM',
    reason: 'PRODUCTION_REPORT',
  })
  @Get('production-by-procedure/items')
  @ApiOperation({
    summary: 'Detalle de una fila: los ítems realizados de un procedimiento',
    description:
      'Mismos filtros y alcance que el reporte, más el procedimiento y la moneda de la fila: paciente, fecha, profesional y sede de cada ítem, del más reciente al más antiguo. Lleva el nombre del paciente: solo ADMIN y DENTIST (que ven pacientes), y el DENTIST solo los suyos. Auditado (VIEW).',
  })
  @ApiOkResponse({ type: ProductionItemsDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  items(
    @Query() query: ProductionItemsQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ProductionItems> {
    return this.production.items({
      ...this.input(query, req),
      catalogItemId: query.catalogItemId,
      currency: query.currency,
      page: query.page,
      pageSize: query.pageSize,
    });
  }
}
