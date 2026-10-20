import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  APPOINTMENT_ROLES,
  PROVIDER_SCHEDULE_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  DeleteProviderOverrideUseCase,
  GetProviderScheduleSettingsUseCase,
  GetProviderScheduleUseCase,
  GetScheduleRosterUseCase,
  ListProviderOverridesUseCase,
  ReplaceProviderScheduleUseCase,
  SetProviderOverrideUseCase,
  UpdateProviderScheduleSettingsUseCase,
  type ProviderOverrideView,
  type ProviderScheduleSettings,
  type ProviderScheduleView,
  type RosterView,
} from '../application/use-cases/provider-schedule.use-cases';
import {
  ListOverridesQueryDto,
  ProviderOverrideDto,
  ProviderScheduleDto,
  ProviderScheduleSettingsDto,
  ReplaceProviderScheduleDto,
  RosterDto,
  RosterQueryDto,
  SetProviderOverrideDto,
  SetProviderOverrideResultDto,
} from './dto/provider-schedule.dto';

export const PROVIDER_SCHEDULE_WRITE_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar los horarios de los profesionales.';

const PROVIDER_PARAM = new ParseUUIDPipe();

/** Detrás del RolesGuard siempre hay sesión de clínica y tenant. */
function requireCtx(
  req: AuditableRequest,
  tenantContext: TenantContextService,
): AuditRequestContext {
  const ctx = auditRequestContext(req, tenantContext);
  if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
  return ctx;
}

/**
 * Horario de cada profesional por sede y sus excepciones por fecha (DX-233).
 * Leer: los cuatro roles de agenda. Escribir: ADMIN. Cada cambio deja un
 * `audit_event` PROVIDER_SCHEDULE con los tramos antes y después.
 */
@ApiTags('provider-schedule')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@Controller('providers/:providerId')
export class ProviderScheduleController {
  constructor(
    private readonly getSchedule: GetProviderScheduleUseCase,
    private readonly replaceSchedule: ReplaceProviderScheduleUseCase,
    private readonly listOverrides: ListProviderOverridesUseCase,
    private readonly setOverride: SetProviderOverrideUseCase,
    private readonly deleteOverride: DeleteProviderOverrideUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('schedule')
  @ApiOperation({ summary: 'Horario semanal del profesional, todas sus sedes' })
  @ApiOkResponse({ type: ProviderScheduleDto })
  @ApiBadRequestResponse({ description: 'El miembro no atiende pacientes' })
  @ApiNotFoundResponse({
    description: 'Profesional no encontrado (o de otra clínica)',
  })
  get(
    @Param('providerId', PROVIDER_PARAM) providerId: string,
  ): Promise<ProviderScheduleView> {
    return this.getSchedule.execute(providerId);
  }

  @Put('schedule')
  @Roles(...PROVIDER_SCHEDULE_WRITE_ROLES)
  @RolesDeniedMessage(PROVIDER_SCHEDULE_WRITE_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary: 'Reemplaza el horario semanal del profesional (todas sus sedes)',
  })
  @ApiOkResponse({ type: ProviderScheduleDto })
  @ApiBadRequestResponse({
    description:
      'Tramo inválido (minutos no múltiplos de 5, fuera de 0–1440, fin no posterior), más de 7 tramos por día y sede, solape en la misma sede, solape del mismo día en dos sedes o con una excepción de otra sede, sede inexistente o desactivada, o el miembro no atiende pacientes. Mensaje en español.',
  })
  @ApiForbiddenResponse({
    description: PROVIDER_SCHEDULE_WRITE_FORBIDDEN_MESSAGE,
  })
  @ApiNotFoundResponse({ description: 'Profesional no encontrado' })
  replace(
    @Param('providerId', PROVIDER_PARAM) providerId: string,
    @Body() dto: ReplaceProviderScheduleDto,
    @Req() req: AuditableRequest,
  ): Promise<ProviderScheduleView> {
    return this.replaceSchedule.execute(
      providerId,
      { locations: dto.locations },
      requireCtx(req, this.tenantContext),
    );
  }

  @Get('schedule-overrides')
  @ApiOperation({ summary: 'Excepciones por fecha del profesional' })
  @ApiOkResponse({ type: [ProviderOverrideDto] })
  @ApiBadRequestResponse({
    description: 'Fechas inválidas o rango de más de dos años',
  })
  @ApiNotFoundResponse({ description: 'Profesional no encontrado' })
  overrides(
    @Param('providerId', PROVIDER_PARAM) providerId: string,
    @Query() query: ListOverridesQueryDto,
  ): Promise<ProviderOverrideView[]> {
    return this.listOverrides.execute(providerId, {
      from: query.from,
      to: query.to,
    });
  }

  @Post('schedule-overrides')
  @Roles(...PROVIDER_SCHEDULE_WRITE_ROLES)
  @RolesDeniedMessage(PROVIDER_SCHEDULE_WRITE_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary:
      'Crea (o reemplaza) la excepción de una sede y fecha; sin tramos = «no trabaja»',
  })
  @ApiCreatedResponse({ type: SetProviderOverrideResultDto })
  @ApiBadRequestResponse({
    description:
      'Fecha pasada o a más de dos años, tramos inválidos o solapados, solape con lo que tiene ese día en otra sede, nota de más de 200 caracteres o sede inexistente. Mensaje en español.',
  })
  @ApiForbiddenResponse({
    description: PROVIDER_SCHEDULE_WRITE_FORBIDDEN_MESSAGE,
  })
  @ApiNotFoundResponse({ description: 'Profesional no encontrado' })
  create(
    @Param('providerId', PROVIDER_PARAM) providerId: string,
    @Body() dto: SetProviderOverrideDto,
    @Req() req: AuditableRequest,
  ): Promise<ProviderOverrideView & { replaced: boolean }> {
    return this.setOverride.execute(
      providerId,
      {
        locationId: dto.locationId,
        date: dto.date,
        ranges: dto.ranges,
        note: dto.note,
      },
      requireCtx(req, this.tenantContext),
    );
  }

  @Delete('schedule-overrides/:overrideId')
  @HttpCode(204)
  @Roles(...PROVIDER_SCHEDULE_WRITE_ROLES)
  @RolesDeniedMessage(PROVIDER_SCHEDULE_WRITE_FORBIDDEN_MESSAGE)
  @ApiOperation({ summary: 'Quita una excepción (vuelve a regir el semanal)' })
  @ApiNoContentResponse({ description: 'Excepción retirada' })
  @ApiForbiddenResponse({
    description: PROVIDER_SCHEDULE_WRITE_FORBIDDEN_MESSAGE,
  })
  @ApiNotFoundResponse({
    description: 'Profesional o excepción no encontrados',
  })
  async remove(
    @Param('providerId', PROVIDER_PARAM) providerId: string,
    @Param('overrideId', new ParseUUIDPipe()) overrideId: string,
    @Req() req: AuditableRequest,
  ): Promise<void> {
    await this.deleteOverride.execute(
      providerId,
      overrideId,
      requireCtx(req, this.tenantContext),
    );
  }
}

/**
 * Cuadrante semanal (profesional × día con la sede) y el modo estricto de la
 * clínica (DX-233).
 */
@ApiTags('provider-schedule')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@Controller('schedule')
export class ScheduleRosterController {
  constructor(
    private readonly getRoster: GetScheduleRosterUseCase,
    private readonly getSettings: GetProviderScheduleSettingsUseCase,
    private readonly updateSettings: UpdateProviderScheduleSettingsUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('roster')
  @ApiOperation({
    summary:
      'Cuadrante: cada profesional que atiende × día, con sus sedes y tramos',
  })
  @ApiOkResponse({ type: RosterDto })
  @ApiBadRequestResponse({ description: 'Fecha inválida o más de 31 días' })
  @ApiNotFoundResponse({ description: 'Sede no encontrada' })
  roster(@Query() query: RosterQueryDto): Promise<RosterView> {
    return this.getRoster.execute({
      weekStart: query.weekStart,
      days: query.days,
      locationId: query.locationId,
    });
  }

  @Get('settings')
  @ApiOperation({ summary: 'Modo estricto del horario de los profesionales' })
  @ApiOkResponse({ type: ProviderScheduleSettingsDto })
  settings(): Promise<ProviderScheduleSettings> {
    return this.getSettings.execute();
  }

  @Put('settings')
  @Roles(...PROVIDER_SCHEDULE_WRITE_ROLES)
  @RolesDeniedMessage(PROVIDER_SCHEDULE_WRITE_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary:
      'Activa o quita el modo estricto (cita fuera del horario del profesional → 409)',
  })
  @ApiOkResponse({ type: ProviderScheduleSettingsDto })
  @ApiForbiddenResponse({
    description: PROVIDER_SCHEDULE_WRITE_FORBIDDEN_MESSAGE,
  })
  update(
    @Body() dto: ProviderScheduleSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<ProviderScheduleSettings> {
    return this.updateSettings.execute(
      { strictProviderSchedule: dto.strictProviderSchedule },
      requireCtx(req, this.tenantContext),
    );
  }
}
