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
import { Audit } from '../../audit/presentation/audit.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  GetRecoveredSlotsUseCase,
  type RecoveredSlotsReport,
} from '../application/use-cases/get-recovered-slots.use-case';
import { toRecoveredSlotsCsv } from '../application/recovered-slots-csv';
import {
  RecoveredSlotsQueryDto,
  RecoveredSlotsReportDto,
} from './dto/recovered-slots.dto';
import { REPORTS_FORBIDDEN_MESSAGE } from './locations-comparison.controller';

const SCOPE =
  'Hueco liberado: cita cancelada o en inasistencia cuya cancelación o marca fue al menos 1 h antes de su inicio (DX-279), con el inicio en el período (días civiles de la zona de cada sede, DX-097). ' +
  'Recuperado: una cita viva no cancelada del MISMO profesional y la MISMA sede que se solapa con el hueco y llegó a él (creada, o movida según el rastro de auditoría) después de liberarse y antes de que terminara; ' +
  'si solo ocupa parte, cuenta como relleno parcial con sus minutos. Un sobrecupo creado antes de la cancelación no cuenta. Cada minuto de una cita cuenta en un solo hueco. ' +
  '«Por la lista»: la cita nació de un pendiente de «Pendientes por agendar» o de una oferta ACEPTADA de ese hueco (DX-210/DX-435). ' +
  'Valor recuperado: precio − descuento de los ítems del plan ligados a las citas recuperadas, por moneda y sin convertir; sin ítems, «sin valorar». ' +
  'Ofertas: las de huecos que empiezan en el período. Tasa de cancelación: canceladas ÷ agendadas del período. ' +
  'Solo ADMIN; un miembro restringido (DX-089) solo ve sus sedes. Sin datos de pacientes.';

const BAD_REQUEST = 'Período inválido o de más de 366 días';
const FORBIDDEN = `${REPORTS_FORBIDDEN_MESSAGE} / sede fuera de las del usuario`;

// «Huecos recuperados» (DX-436). La pantalla son agregados sin pacientes
// (sin auditoría, como «Comparar sedes»); el CSV se audita (EXPORT) porque
// sale de la clínica.
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...REPORT_ROLES)
@RolesDeniedMessage(REPORTS_FORBIDDEN_MESSAGE)
@Controller('reports')
export class RecoveredSlotsController {
  constructor(
    private readonly recoveredSlots: GetRecoveredSlotsUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  private run(query: RecoveredSlotsQueryDto): Promise<RecoveredSlotsReport> {
    return this.recoveredSlots.execute({
      from: query.from,
      to: query.to,
      locationId: query.locationId,
      providerId: query.providerId,
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
    });
  }

  @Get('recovered-slots')
  @ApiOperation({
    summary:
      'Huecos recuperados: liberados, rellenados, por la lista, tiempo hasta rellenar y valor',
    description: SCOPE,
  })
  @ApiOkResponse({ type: RecoveredSlotsReportDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  get(@Query() query: RecoveredSlotsQueryDto): Promise<RecoveredSlotsReport> {
    return this.run(query);
  }

  @Audit({
    action: 'EXPORT',
    resource: 'APPOINTMENT',
    reason: 'RECOVERED_SLOTS_REPORT',
  })
  @Get('recovered-slots.csv')
  @ApiOperation({
    summary: 'Huecos recuperados en CSV (mismos filtros, auditado)',
    description: `${SCOPE} Solo agregados: el total, una fila por profesional y una por semana, con una columna de valor por moneda. UTF-8 con BOM; celdas protegidas contra fórmulas. Cada descarga queda en auditoría (EXPORT).`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Fichero CSV',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  async csv(
    @Query() query: RecoveredSlotsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.run(query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="huecos-recuperados-${report.from}-${report.to}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return toRecoveredSlotsCsv(report);
  }
}
