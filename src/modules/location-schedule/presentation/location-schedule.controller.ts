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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import {
  GetLocationScheduleUseCase,
  ReplaceLocationScheduleUseCase,
} from '../application/use-cases/manage-location-schedule.use-cases';
import { BusinessHours } from '../application/business-hours';
import {
  LocationScheduleDto,
  ReplaceLocationScheduleDto,
} from './dto/replace-location-schedule.dto';
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

/** 409 de la sede sin zona (G1): lo lanzan la lectura y el reemplazo. */
const TIME_ZONE_CONFLICT =
  'LOCATION_TIMEZONE_REQUIRED: la sede en contexto no tiene zona horaria válida (se configura en Ajustes → Sedes)';

/**
 * Horario de atención de la sede EN CONTEXTO (cabecera `X-Location-Id` si vino,
 * si no la sede por defecto) — la misma sede en la que se escribirían las citas.
 *
 * Lectura para cualquier rol que agenda (necesita saber el horario para validar
 * antes de enviar); escritura solo ADMIN, igual que el CRUD de sedes.
 */
@ApiTags('location-schedule')
@ApiBearerAuth()
@ApiExtraModels(LocationScheduleDto)
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
    // `null` es una respuesta válida: en OpenAPI 3.0 el `$ref` va dentro de
    // `allOf` para poder marcarlo `nullable` (DX-352).
    schema: {
      nullable: true,
      allOf: [{ $ref: getSchemaPath(LocationScheduleDto) }],
    },
  })
  @ApiConflictResponse({ description: TIME_ZONE_CONFLICT })
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
    type: LocationScheduleDto,
    description:
      'Horario reemplazado; `timezone` en la respuesta es la zona de la sede',
  })
  @ApiBadRequestResponse({
    description:
      'Tramo fuera de rango, fin no posterior al inicio, tramos solapados en el mismo día, o `timezone` (obsoleto) distinta de la zona de la sede',
  })
  @ApiConflictResponse({ description: TIME_ZONE_CONFLICT })
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
