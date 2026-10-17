import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { GetAppointmentRemindersUseCase } from '../application/use-cases/get-appointment-reminders.use-case';
import { AppointmentRemindersDto } from './dto/appointment-reminders.dto';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { APPOINTMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

// Mismos roles que la agenda: quien abre el detalle de la cita ve si al
// paciente le llegó (o no, y por qué) el recordatorio.
@ApiTags('appointments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@Controller('appointments')
export class AppointmentRemindersController {
  constructor(private readonly getReminders: GetAppointmentRemindersUseCase) {}

  @Get(':id/reminders')
  @ApiOkResponse({ type: AppointmentRemindersDto })
  @ApiNotFoundResponse({ description: 'Cita no encontrada en esta clínica' })
  find(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AppointmentRemindersDto> {
    return this.getReminders.execute(id);
  }
}
