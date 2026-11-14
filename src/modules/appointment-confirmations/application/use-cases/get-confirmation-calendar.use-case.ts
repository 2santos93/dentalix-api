import { GoneException, Inject, Injectable } from '@nestjs/common';
import { APPOINTMENT_CONFIRMATION_REPOSITORY } from '../../domain/ports/appointment-confirmation-repository.port';
import type { AppointmentConfirmationRepository } from '../../domain/ports/appointment-confirmation-repository.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { confirmationState } from '../confirmation-token';
import { findConfirmationByToken } from '../find-confirmation-by-token';
import { buildAppointmentIcs } from '../../../../shared/calendar/appointment-calendar';

const EXPIRED = 'Este enlace ya no es válido';

/**
 * DX-469: el .ics de la cita del enlace de confirmación. Solo lee. Vale con
 * el enlace pendiente o ya respondido, mientras la cita no haya terminado;
 * caducado, revocado, cita que cambió o ya pasada: 410 (la página genérica de
 * enlace vencido). Una cita cancelada sale con STATUS:CANCELLED para que el
 * calendario la quite.
 */
@Injectable()
export class GetConfirmationCalendarUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(APPOINTMENT_CONFIRMATION_REPOSITORY)
    private readonly repo: AppointmentConfirmationRepository,
  ) {}

  async execute(token: string): Promise<string> {
    const { confirmation, appointment } = await findConfirmationByToken(
      this.tenantContext,
      this.repo,
      token,
    );
    const now = new Date();
    const status = confirmationState(confirmation, appointment, now);
    if (
      status === 'EXPIRED' ||
      !appointment ||
      appointment.end.getTime() <= now.getTime()
    ) {
      throw new GoneException(EXPIRED);
    }
    const clinic = await this.repo.findClinicBranding();
    return buildAppointmentIcs({
      // El tenant del host: el mismo con el que la RLS encontró el enlace.
      tenantId: this.tenantContext.getTenantId() ?? '',
      appointmentId: appointment.id,
      start: appointment.start,
      end: appointment.end,
      updatedAt: appointment.updatedAt,
      cancelled: appointment.status === 'CANCELLED',
      clinicName: clinic?.name ?? 'la clínica',
      providerName: appointment.providerName,
      locationName: appointment.locationName,
      locationAddress: appointment.locationAddress,
      alarmHours: appointment.calendarAlarmHours,
    });
  }
}
