import {
  applyDecorators,
  BadRequestException,
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
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  type ApiBodyOptions,
} from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { UPLOAD_TEMP_DIR } from '../../../shared/storage/local-file';
import {
  UPLOAD_BUSY_MESSAGE,
  UploadSlotGuard,
  UploadSlotInterceptor,
} from '../../../shared/storage/upload-slots';
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
import {
  ImportHolidaysUseCase,
  type HolidayImportResult,
} from '../application/import-holidays.use-case';
import { HOLIDAY_MESSAGES } from '../domain/holiday-rules';
import type {
  HolidayView,
  LocationCalendarView,
} from '../domain/ports/location-calendar-repository.port';
import {
  CreateLocationHolidayDto,
  HolidayImportResultDto,
  LocationCalendarDto,
  LocationHolidayDto,
  SetWorkingWeekdaysDto,
  UpdateLocationHolidayDto,
} from './dto/location-calendar.dto';
import { HolidayImportMultipartErrorsFilter } from './holiday-import-multipart-errors.filter';

/** Un id que no es un uuid: 400, como las demás rutas de sede. */
const locationIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException(HOLIDAY_MESSAGES.invalidLocationId),
});
const holidayIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException(HOLIDAY_MESSAGES.invalidHolidayId),
});

/** Lo que la auditoría guarda de un festivo: fecha y clase, nunca el nombre (R10). */
const auditSide = (h: HolidayView): AuditHolidaySide => ({
  date: h.date,
  recurring: h.recurring,
});

const LOCATION_404 = 'Sede inexistente, de otra clínica o retirada';

/** 256 KB por fichero (§5.1): más es 413 de multer, en español por el filtro. */
const MAX_IMPORT_BYTES = 256 * 1024;

const FILE_BODY: ApiBodyOptions = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: {
      file: {
        type: 'string',
        format: 'binary',
        description:
          '.csv (fecha, nombre y, si quieres, recurrente) o .ics; hasta 256 KB y 500 filas o días de festivo',
      },
    },
  },
};

/**
 * Las dos rutas de importación (P16, P17): semáforo de subidas y multer a un
 * temporal en disco, que `UploadSlotInterceptor` borra al terminar el
 * handler (el fichero no se guarda), con los errores de multer en español.
 */
const HolidayImportUpload = () =>
  applyDecorators(
    UseGuards(UploadSlotGuard),
    UseInterceptors(
      UploadSlotInterceptor,
      FileInterceptor('file', {
        dest: UPLOAD_TEMP_DIR,
        defParamCharset: 'utf8',
        limits: {
          fileSize: MAX_IMPORT_BYTES,
          files: 1,
          fields: 2,
          fieldSize: 1024,
        },
      }),
    ),
    UseFilters(HolidayImportMultipartErrorsFilter),
  );

const IMPORT_400 = `${HOLIDAY_MESSAGES.missingFile} / ${HOLIDAY_MESSAGES.wrongExtension} / ${HOLIDAY_MESSAGES.emptyFile} / extensión que no coincide con el contenido / fichero ilegible (cabecera del CSV, UTF-8, sin eventos, incompleto, más de 500 entradas) / ${HOLIDAY_MESSAGES.invalidLocationId}`;

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
    private readonly importHolidays: ImportHolidaysUseCase,
  ) {}

  @Get('calendar')
  @ApiOperation({ summary: 'Días hábiles y festivos vivos de la sede' })
  @ApiOkResponse({ type: LocationCalendarDto })
  @ApiBadRequestResponse({ description: HOLIDAY_MESSAGES.invalidLocationId })
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
      '`HOLIDAY_ALREADY_EXISTS` con `holidayId`: ese día ya es festivo de la sede (R5); `LOCATION_HOLIDAY_LIMIT`: la sede ya tiene 1000 festivos',
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
    // Un PATCH vacío o con los valores guardados no cambia nada: sin evento.
    if (
      before.date === after.date &&
      before.name === after.name &&
      before.recurring === after.recurring
    ) {
      req.skipAudit = true;
      return after;
    }
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
  @ApiBadRequestResponse({
    description: `${HOLIDAY_MESSAGES.invalidLocationId} / ${HOLIDAY_MESSAGES.invalidHolidayId}`,
  })
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

  @Post('holidays/import/preview')
  @HttpCode(200)
  @HolidayImportUpload()
  @ApiOperation({
    summary: 'Vista previa de una importación de festivos (CSV o ICS)',
    description:
      'Lee, valida y clasifica cada fila contra los festivos vivos de la sede sin escribir nada ni auditar.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  @ApiOkResponse({ type: HolidayImportResultDto })
  @ApiBadRequestResponse({ description: IMPORT_400 })
  @ApiForbiddenResponse({ description: HOLIDAY_MESSAGES.rolesDenied })
  @ApiNotFoundResponse({ description: LOCATION_404 })
  @ApiConflictResponse({
    description:
      '`LOCATION_HOLIDAY_LIMIT`: las filas nuevas pasarían de 1000 festivos en la sede',
  })
  @ApiPayloadTooLargeResponse({ description: HOLIDAY_MESSAGES.fileTooLarge })
  @ApiServiceUnavailableResponse({
    description: `${UPLOAD_BUSY_MESSAGE} (con Retry-After)`,
  })
  preview(
    @Param('id', locationIdPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<HolidayImportResult> {
    return this.importHolidays.execute(id, file, { dryRun: true });
  }

  @Audit({
    action: 'CREATE',
    resource: 'LOCATION_CALENDAR',
    resourceId: { param: 'id' },
    reason: 'HOLIDAYS_IMPORTED',
  })
  @Post('holidays/import')
  @HttpCode(200)
  @HolidayImportUpload()
  @ApiOperation({
    summary: 'Importar festivos (CSV o ICS) sin duplicar',
    description:
      'Escribe las filas NEW en una transacción con el calendario de la sede bloqueado; las filas con error no impiden escribir las demás. Importar dos veces el mismo fichero no duplica nada. Sin festivos creados no queda evento de auditoría.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  @ApiOkResponse({ type: HolidayImportResultDto })
  @ApiBadRequestResponse({ description: IMPORT_400 })
  @ApiForbiddenResponse({ description: HOLIDAY_MESSAGES.rolesDenied })
  @ApiNotFoundResponse({ description: LOCATION_404 })
  @ApiConflictResponse({
    description:
      '`LOCATION_HOLIDAY_LIMIT`: las filas nuevas pasarían de 1000 festivos en la sede; no se escribe nada',
  })
  @ApiPayloadTooLargeResponse({ description: HOLIDAY_MESSAGES.fileTooLarge })
  @ApiServiceUnavailableResponse({
    description: `${UPLOAD_BUSY_MESSAGE} (con Retry-After)`,
  })
  async import(
    @Param('id', locationIdPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: AuditedRequest,
  ): Promise<HolidayImportResult> {
    const result = await this.importHolidays.execute(id, file, {
      dryRun: false,
    });
    // Sin festivos creados el calendario no cambia: sin evento (como el PUT
    // y el PATCH sin cambio). Ni nombres ni filas: solo los recuentos (R10).
    if (result.counts.new === 0) {
      req.skipAudit = true;
    } else {
      req.auditMetadata = {
        locationCalendar: {
          import: {
            format: result.format,
            created: result.counts.new,
            duplicate: result.counts.duplicate,
            error: result.counts.error,
          },
        },
      };
    }
    return result;
  }
}
