import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import type { AuditedRequest } from '../../audit/presentation/audit-request';
import type { AuditHolidaySide } from '../../audit/domain/audit-metadata';
import {
  CreateHolidayUseCase,
  GetLocationCalendarUseCase,
  RetireHolidayUseCase,
  SetWorkingWeekdaysUseCase,
  UpdateHolidayUseCase,
} from '../application/location-calendar.use-cases';
import { HOLIDAY_MESSAGES } from '../domain/holiday-rules';
import {
  holidayNotFound,
  locationNotFound,
} from '../domain/location-calendar-errors';
import type {
  HolidayView,
  LocationCalendarView,
} from '../domain/ports/location-calendar-repository.port';
import {
  CreateLocationHolidayDto,
  LocationCalendarDto,
  LocationHolidayDto,
  SetWorkingWeekdaysDto,
  UpdateLocationHolidayDto,
} from './dto/location-calendar.dto';

/** Un id que no es un uuid no es ninguna sede ni ningún festivo: 404. */
const locationIdPipe = new ParseUUIDPipe({
  exceptionFactory: () => locationNotFound(),
});
const holidayIdPipe = new ParseUUIDPipe({
  exceptionFactory: () => holidayNotFound(),
});

/** Lo que la auditoría guarda de un festivo: fecha y clase, nunca el nombre (R10). */
const auditSide = (h: HolidayView): AuditHolidaySide => ({
  date: h.date,
  recurring: h.recurring,
});

const LOCATION_404 = 'Sede inexistente, de otra clínica o retirada';

/**
 * Ajustes → «Calendario de la sede» (DX-316): días hábiles de la semana y
 * festivos de una sede, para los plazos en días hábiles. No es el horario de
 * atención (R4). Solo ADMIN, para leer y para escribir (R9). Una sede
 * inactiva se puede editar; una retirada es 404. Cada cambio queda auditado
 * como `LOCATION_CALENDAR` con la sede como recurso, sin el nombre del
 * festivo (R10).
 */
@ApiTags('location-calendar')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(ClinicRole.ADMIN)
@RolesDeniedMessage(HOLIDAY_MESSAGES.rolesDenied)
@Controller('locations/:id')
export class LocationCalendarController {
  constructor(
    private readonly getCalendar: GetLocationCalendarUseCase,
    private readonly setWeekdays: SetWorkingWeekdaysUseCase,
    private readonly createHoliday: CreateHolidayUseCase,
    private readonly updateHoliday: UpdateHolidayUseCase,
    private readonly retireHoliday: RetireHolidayUseCase,
  ) {}

  @Get('calendar')
  @ApiOperation({ summary: 'Días hábiles y festivos vivos de la sede' })
  @ApiOkResponse({ type: LocationCalendarDto })
  @ApiForbiddenResponse({ description: HOLIDAY_MESSAGES.rolesDenied })
  @ApiNotFoundResponse({ description: LOCATION_404 })
  get(@Param('id', locationIdPipe) id: string): Promise<LocationCalendarView> {
    return this.getCalendar.execute(id);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'LOCATION_CALENDAR',
    resourceId: { param: 'id' },
    reason: 'WORKING_WEEKDAYS_CHANGED',
  })
  @Put('calendar/working-weekdays')
  @ApiOperation({
    summary: 'Fijar los días hábiles de la semana de la sede',
    description:
      'Reemplaza la semana entera. Se guardan ordenados y sin repetidos. Sin cambio real no queda evento de auditoría.',
  })
  @ApiOkResponse({ type: LocationCalendarDto })
  @ApiBadRequestResponse({
    description: `${HOLIDAY_MESSAGES.weekdaysEmpty} / ${HOLIDAY_MESSAGES.weekdayOutOfRange}`,
  })
  @ApiForbiddenResponse({ description: HOLIDAY_MESSAGES.rolesDenied })
  @ApiNotFoundResponse({ description: LOCATION_404 })
  async setWorkingWeekdays(
    @Param('id', locationIdPipe) id: string,
    @Body() dto: SetWorkingWeekdaysDto,
    @Req() req: AuditedRequest,
  ): Promise<LocationCalendarView> {
    const { view, before, after, changed } = await this.setWeekdays.execute(
      id,
      dto.workingWeekdays,
    );
    if (changed) {
      req.auditMetadata = {
        locationCalendar: { workingWeekdays: { before, after } },
      };
    } else {
      req.skipAudit = true;
    }
    return view;
  }

  @Audit({
    action: 'CREATE',
    resource: 'LOCATION_CALENDAR',
    resourceId: { param: 'id' },
    reason: 'HOLIDAY_CREATED',
  })
  @Post('holidays')
  @ApiOperation({ summary: 'Añadir un festivo a la sede' })
  @ApiCreatedResponse({ type: LocationHolidayDto })
  @ApiBadRequestResponse({
    description:
      'Fecha que no es AAAA-MM-DD o fuera de 2000–2100, nombre vacío o de más de 120 caracteres, o recurrente el 29 de febrero',
  })
  @ApiForbiddenResponse({ description: HOLIDAY_MESSAGES.rolesDenied })
  @ApiNotFoundResponse({ description: LOCATION_404 })
  @ApiConflictResponse({
    description:
      '`HOLIDAY_ALREADY_EXISTS` con `holidayId`: ese día ya es festivo de la sede (R5)',
  })
  async create(
    @Param('id', locationIdPipe) id: string,
    @Body() dto: CreateLocationHolidayDto,
    @Req() req: AuditedRequest,
  ): Promise<HolidayView> {
    const holiday = await this.createHoliday.execute(id, dto);
    req.auditMetadata = {
      locationCalendar: { holiday: { after: auditSide(holiday) } },
    };
    return holiday;
  }

  @Audit({
    action: 'UPDATE',
    resource: 'LOCATION_CALENDAR',
    resourceId: { param: 'id' },
    reason: 'HOLIDAY_UPDATED',
  })
  @Patch('holidays/:holidayId')
  @ApiOperation({
    summary: 'Cambiar la fecha, el nombre o la clase de un festivo',
    description: 'Un campo ausente no cambia; `null` es 400.',
  })
  @ApiOkResponse({ type: LocationHolidayDto })
  @ApiBadRequestResponse({
    description:
      'Un campo en null, fecha o nombre no válidos, o recurrente el 29 de febrero',
  })
  @ApiForbiddenResponse({ description: HOLIDAY_MESSAGES.rolesDenied })
  @ApiNotFoundResponse({
    description: `${LOCATION_404}, o festivo inexistente, retirado o de otra sede`,
  })
  @ApiConflictResponse({
    description:
      '`HOLIDAY_ALREADY_EXISTS` con `holidayId`: el día ya es festivo de la sede (el propio no cuenta)',
  })
  async update(
    @Param('id', locationIdPipe) id: string,
    @Param('holidayId', holidayIdPipe) holidayId: string,
    @Body() dto: UpdateLocationHolidayDto,
    @Req() req: AuditedRequest,
  ): Promise<HolidayView> {
    const { before, after } = await this.updateHoliday.execute(
      id,
      holidayId,
      dto,
    );
    req.auditMetadata = {
      locationCalendar: {
        holiday: { before: auditSide(before), after: auditSide(after) },
      },
    };
    return after;
  }

  @Audit({
    action: 'DELETE',
    resource: 'LOCATION_CALENDAR',
    resourceId: { param: 'id' },
    reason: 'HOLIDAY_DELETED',
  })
  @Delete('holidays/:holidayId')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Eliminar un festivo (se retira; la fecha se puede volver a añadir)',
  })
  @ApiNoContentResponse({ description: 'Retirado' })
  @ApiForbiddenResponse({ description: HOLIDAY_MESSAGES.rolesDenied })
  @ApiNotFoundResponse({
    description: `${LOCATION_404}, o festivo inexistente, retirado o de otra sede`,
  })
  async retire(
    @Param('id', locationIdPipe) id: string,
    @Param('holidayId', holidayIdPipe) holidayId: string,
    @Req() req: AuditedRequest,
  ): Promise<void> {
    const before = await this.retireHoliday.execute(id, holidayId);
    req.auditMetadata = {
      locationCalendar: { holiday: { before: auditSide(before) } },
    };
  }
}
