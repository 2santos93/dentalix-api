import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { APPOINTMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { GetPatientAttendanceUseCase } from '../application/attendance/patient-attendance';
import type { PatientAttendanceSummary } from '../domain/attendance';
import { PatientAttendanceSummaryDto } from './dto/appointment.dto';

/**
 * DX-279: asistencia del paciente en los últimos 12 meses (la insignia de la
 * cabecera de su ficha). Los cuatro roles, como la agenda; cada uno ve solo
 * las sedes que tiene permitidas (DX-089).
 */
@ApiTags('appointments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@Controller('patients/:id/attendance-summary')
export class PatientAttendanceController {
  constructor(private readonly getAttendance: GetPatientAttendanceUseCase) {}

  @Get()
  @ApiOperation({
    summary: 'Citas, inasistencias y cancelaciones tardías de 12 meses',
    description:
      'Calculado al pedirlo (sin contador guardado): citas que ya empezaron, inasistencias (NO_SHOW) y cancelaciones tardías (nunca las de la clínica) cuyo inicio cae en los últimos 12 meses, por sede y en total. Un miembro restringido a sedes (DX-089) solo cuenta las suyas, sin mirar la sede activa de la cabecera.',
  })
  @ApiOkResponse({ type: PatientAttendanceSummaryDto })
  @ApiBadRequestResponse({
    description: 'El identificador del paciente no es válido.',
  })
  @ApiForbiddenResponse({ description: 'Rol sin acceso a la agenda' })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  get(
    @Param(
      'id',
      new ParseUUIDPipe({
        exceptionFactory: () =>
          new BadRequestException(
            'El identificador del paciente no es válido.',
          ),
      }),
    )
    id: string,
  ): Promise<PatientAttendanceSummary> {
    return this.getAttendance.execute(id);
  }
}
