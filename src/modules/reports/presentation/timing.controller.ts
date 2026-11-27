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
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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
import { TIMING_REPORT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { CSV_RESPONSE, sendCsv } from '../../../shared/csv/csv-response';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  GetTimingUseCase,
  TIMING_FORBIDDEN_MESSAGE,
  TIMING_INVALID_PERIOD_MESSAGE,
  TIMING_LOCATION_NOT_FOUND_MESSAGE,
  TIMING_OWN_ONLY_MESSAGE,
  TIMING_PERIOD_TOO_LONG_MESSAGE,
  type TimingInput,
  type TimingReport,
} from '../application/use-cases/get-timing.use-case';
import { toTimingCsv } from '../application/timing-csv';
import { TimingQueryDto, TimingReportDto } from './dto/timing.dto';

interface AuthenticatedRequest {
  // RolesGuard ya exige un token de clínica (con rol).
  user: TenantJwtPayload;
}

const SCOPE =
  'Para el período, la sede y el profesional: espera en sala (sillón − máx(llegada, hora programada)), retraso de inicio (sillón − hora programada) y duración real (listo para cobrar − sillón) frente a la programada (fin − inicio), con media y p90, por profesional, por tipo de cita (con el aviso de los tipos que se exceden > 20 % en ≥ 10 citas) y por semana; y la ocupación histórica por profesional y semana (atendidas ÷ disponibles, con citadas, atendidas, no-show y libres; disponibles = horario DX-233 − festivos − bloqueos DX-122). ' +
  'Solo citas completadas y vivas, por su hora programada en la zona de su sede (semanas de lunes a domingo). Las que no tienen las tres horas del panel «En clínica» (`withoutTimes`) o las tienen fuera de los umbrales de `thresholds` (`incoherent`) se excluyen de medias y p90 y se cuentan aparte. Las definiciones van en `definitions`, para mostrarlas tal cual. ' +
  'Solo agregados de agenda, sin pacientes ni datos clínicos. Solo las sedes que ve quien consulta (DX-089). ADMIN ve todo el equipo (scope CLINIC); un DENTIST, solo lo suyo (scope OWN); recepción y asistente, 403.';

const BAD_REQUEST = `${TIMING_INVALID_PERIOD_MESSAGE} / ${TIMING_PERIOD_TOO_LONG_MESSAGE} / filtros inválidos`;
const NOT_FOUND = `${TIMING_LOCATION_NOT_FOUND_MESSAGE} (la sede no es de la clínica o está retirada)`;
const FORBIDDEN = `${TIMING_FORBIDDEN_MESSAGE} / ${TIMING_OWN_ONLY_MESSAGE} / No tienes acceso a esta sede.`;
const CONFLICT =
  'LOCATION_TIMEZONE_REQUIRED: una sede con citas no tiene zona horaria';

// «Tiempos» (DX-275). El informe no lleva pacientes; el CSV sale de la
// clínica y deja un evento EXPORT en la auditoría.
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...TIMING_REPORT_ROLES)
@RolesDeniedMessage(TIMING_FORBIDDEN_MESSAGE)
@Controller('reports')
export class TimingController {
  constructor(
    private readonly timing: GetTimingUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  private input(query: TimingQueryDto, req: AuthenticatedRequest): TimingInput {
    return {
      from: query.from,
      to: query.to,
      locationId: query.locationId,
      providerId: query.providerId,
      actor: { userId: req.user.sub, role: req.user.role },
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
    };
  }

  @Get('timing')
  @ApiOperation({
    summary:
      'Tiempos: espera en sala, retraso, duración real frente a la programada y ocupación por profesional',
    description: SCOPE,
  })
  @ApiOkResponse({ type: TimingReportDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: CONFLICT })
  get(
    @Query() query: TimingQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TimingReport> {
    return this.timing.execute(this.input(query, req));
  }

  @Audit({ action: 'EXPORT', resource: 'APPOINTMENT', reason: 'TIMING_REPORT' })
  @Get('timing.csv')
  @ApiOperation({
    summary: 'Tiempos en CSV (mismos filtros)',
    description: `${SCOPE} Las mismas tablas que la pantalla (por profesional con el total, por tipo, por semana, ocupación por profesional y por semana), con el período, los filtros y las definiciones en la cabecera. UTF-8 con BOM; celdas protegidas contra fórmulas. Auditado (EXPORT).`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV_RESPONSE)
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: CONFLICT })
  async csv(
    @Query() query: TimingQueryDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.timing.execute(this.input(query, req));
    sendCsv(res, `tiempos-${report.from}-${report.to}.csv`);
    return toTimingCsv(report);
  }
}
