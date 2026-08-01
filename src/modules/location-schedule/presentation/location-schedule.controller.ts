import {
  Body,
  Controller,
  Get,
  Put,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
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
  ) {}

  /** `null` = sede sin horario configurado ⇒ no se restringe nada. */
  @Get()
  @ApiOkResponse({ description: 'Horario de la sede, o null si no se configuró' })
  get(): Promise<BusinessHours | null> {
    return this.getSchedule.execute();
  }

  @Put()
  @Roles(ClinicRole.ADMIN)
  @ApiOkResponse({ description: 'Horario reemplazado' })
  replace(@Body() dto: ReplaceLocationScheduleDto): Promise<BusinessHours> {
    return this.replaceSchedule.execute({
      timezone: dto.timezone,
      ranges: dto.ranges,
    });
  }
}
