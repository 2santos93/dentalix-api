import { Inject, Injectable } from '@nestjs/common';
import { APPOINTMENT_REPOSITORY } from '../../domain/ports/appointment-repository.port';
import type { AppointmentRepository } from '../../domain/ports/appointment-repository.port';
import { Appointment } from '../../domain/entities/appointment.entity';

export interface ListUpcomingAppointmentsInput {
  from: Date;
  to: Date;
  limit: number;
}

/**
 * Las próximas `limit` citas vivas con inicio en `[from, to)`, por inicio
 * ascendente, en la sede activa del request (o toda la clínica si no hay).
 * El corte lo hace la BD (DX-043, DB-008): antes el dashboard leía todas las
 * citas de 90 días para quedarse con 5.
 */
@Injectable()
export class ListUpcomingAppointmentsUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly repo: AppointmentRepository,
  ) {}

  execute(input: ListUpcomingAppointmentsInput): Promise<Appointment[]> {
    return this.repo.listUpcoming(input);
  }
}
