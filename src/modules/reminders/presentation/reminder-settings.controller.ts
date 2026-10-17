import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import {
  ListReminderSettingsUseCase,
  UpdateReminderSettingsUseCase,
} from '../application/use-cases/reminder-settings.use-cases';
import {
  LocationReminderSettingsDto,
  UpdateReminderSettingsDto,
} from './dto/reminder-settings.dto';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import type { JwtPayload } from '../../../shared/crypto/token.service';

export const REMINDER_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede ver y cambiar los recordatorios.';

/**
 * Ajustes → Recordatorios (DX-026): recordatorio automático de cita por email,
 * por sede. Solo ADMIN, para leer y para escribir.
 */
@ApiTags('reminders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(ClinicRole.ADMIN)
@RolesDeniedMessage(REMINDER_SETTINGS_FORBIDDEN_MESSAGE)
@Controller('reminder-settings')
export class ReminderSettingsController {
  constructor(
    private readonly list: ListReminderSettingsUseCase,
    private readonly update: UpdateReminderSettingsUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ type: [LocationReminderSettingsDto] })
  @ApiForbiddenResponse({ description: REMINDER_SETTINGS_FORBIDDEN_MESSAGE })
  findAll(): Promise<LocationReminderSettingsDto[]> {
    return this.list.execute();
  }

  @Put(':locationId')
  @ApiOkResponse({ type: LocationReminderSettingsDto })
  @ApiBadRequestResponse({
    description: 'Antelaciones inválidas (mensaje en español)',
  })
  @ApiForbiddenResponse({ description: REMINDER_SETTINGS_FORBIDDEN_MESSAGE })
  @ApiNotFoundResponse({ description: 'Sede no encontrada en esta clínica' })
  replace(
    @Param(
      'locationId',
      new ParseUUIDPipe({
        exceptionFactory: () =>
          new BadRequestException('El identificador de la sede no es válido.'),
      }),
    )
    locationId: string,
    @Body() dto: UpdateReminderSettingsDto,
    @Req() req: { user: JwtPayload },
  ): Promise<LocationReminderSettingsDto> {
    return this.update.execute(
      locationId,
      { enabled: dto.enabled, leadHours: dto.leadHours },
      req.user.sub,
    );
  }
}
