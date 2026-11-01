import {
  Body,
  Controller,
  Get,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import {
  GetLocationScheduleUseCase,
  ReplaceLocationScheduleUseCase,
} from '../application/use-cases/manage-location-schedule.use-cases';
import { BusinessHours } from '../application/business-hours';
import { ReplaceLocationScheduleDto } from './dto/replace-location-schedule.dto';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { PATIENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';

/**
 * Horario de atención de la sede EN CONTEXTO (cabecera `X-Location-Id` si vino,
 * si no la sede por defecto) — la misma sede en la que se escribirían las citas.
 *
 * Lectura para cualquier rol que agenda (necesita saber el horario para validar
 * antes de enviar); escritura solo ADMIN, igual que el CRUD de sedes.
 */
@ApiTags('location-schedule')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_ROLES)
@Controller('locations/schedule')
export class LocationScheduleController {
  constructor(
    private readonly getSchedule: GetLocationScheduleUseCase,
    private readonly replaceSchedule: ReplaceLocationScheduleUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** `null` = sede sin horario configurado ⇒ no se restringe nada. */
  @Get()
  @ApiOkResponse({
    description: 'Horario de la sede, o null si no se configuró',
  })
  get(): Promise<BusinessHours | null> {
    return this.getSchedule.execute();
  }

  // DX-360: auditado en la transacción (UPDATE LOCATION_SCHEDULE) con los
  // tramos antes y después; sin evento si la semana no cambia.
  @Put()
  @Roles(ClinicRole.ADMIN)
  @ApiOperation({
    summary: 'Reemplaza el horario semanal de la sede en contexto',
    description:
      'Queda en la auditoría (LOCATION_SCHEDULE_REPLACED) con los tramos antes y después, en la sede del horario. Guardar la misma semana no deja evento.',
  })
  @ApiOkResponse({
    description:
      'Horario reemplazado; `timezone` en la respuesta es la zona de la sede',
  })
  replace(
    @Body() dto: ReplaceLocationScheduleDto,
    @Req() req: AuditableRequest,
  ): Promise<BusinessHours> {
    return this.replaceSchedule.execute(
      { ranges: dto.ranges, legacyTimeZone: dto.timezone },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}
