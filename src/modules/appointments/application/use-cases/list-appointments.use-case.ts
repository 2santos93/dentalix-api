import { Inject, Injectable } from '@nestjs/common';
import { APPOINTMENT_REPOSITORY } from '../../domain/ports/appointment-repository.port';
import type { AppointmentRepository } from '../../domain/ports/appointment-repository.port';
import { Appointment } from '../../domain/entities/appointment.entity';

export interface ListAppointmentsInput {
  from: Date;
  to: Date;
  providerId?: string;
}

@Injectable()
export class ListAppointmentsUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly repo: AppointmentRepository,
  ) {}

  /**
   * Ordering (start ASC) and the active/deletedAt:null filter are the
   * repository's responsibility (see PrismaAppointmentRepository / the
   * in-memory fake in the spec for the same contract) — this use case only
   * forwards the range + optional providerId untouched.
   */
  async execute(input: ListAppointmentsInput): Promise<Appointment[]> {
    return this.repo.listByRange({
      from: input.from,
      to: input.to,
      providerId: input.providerId,
    });
  }
}
