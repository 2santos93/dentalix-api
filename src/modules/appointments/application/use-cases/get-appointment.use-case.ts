import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { APPOINTMENT_REPOSITORY } from '../../domain/ports/appointment-repository.port';
import type { AppointmentRepository } from '../../domain/ports/appointment-repository.port';
import { Appointment } from '../../domain/entities/appointment.entity';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

@Injectable()
export class GetAppointmentUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly repo: AppointmentRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(id: string): Promise<Appointment> {
    const appointment = await this.repo.findById(id);
    if (!appointment) {
      // Same rationale as GetPatientUseCase: a missing row and a row that
      // belongs to another tenant are indistinguishable here (RLS makes
      // cross-tenant rows invisible), so both surface as NotFound.
      throw new NotFoundException('Appointment not found');
    }
    // DX-089: una cita de una sede no permitida es 403 (no 404: existe).
    this.tenantContext.assertLocationAllowed(appointment.locationId);
    return appointment;
  }
}
