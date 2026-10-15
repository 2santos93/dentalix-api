import { randomUUID } from 'node:crypto';
import {
  AppointmentConfirmationRepository,
  ConfirmationLookup,
  IssueConfirmationInput,
  RespondConfirmationInput,
  RespondOutcome,
} from '../../../domain/ports/appointment-confirmation-repository.port';
import {
  AppointmentConfirmation,
  ClinicBranding,
  ConfirmationAppointment,
} from '../../../domain/entities/appointment-confirmation.entity';

type StoredConfirmation = AppointmentConfirmation & { tokenHash: string };

/**
 * Doble en memoria de un solo tenant (el aislamiento real lo prueban los e2e
 * con Postgres + RLS). Reproduce la semántica del repositorio Prisma: revocar
 * al emitir, un solo uso y "no tocar la cita si cambió".
 */
export class InMemoryAppointmentConfirmationRepository implements AppointmentConfirmationRepository {
  readonly appointments = new Map<
    string,
    ConfirmationAppointment & {
      confirmationSentAt: Date | null;
      callbackRequestedAt: Date | null;
    }
  >();
  readonly confirmations: StoredConfirmation[] = [];
  branding: ClinicBranding | null = {
    name: 'Clínica Sonrisa',
    primaryColor: '#0E7490',
    logoUrl: null,
  };

  addAppointment(overrides: Partial<ConfirmationAppointment> = {}) {
    const start = overrides.start ?? new Date(Date.now() + 24 * 3600_000);
    const appointment = {
      id: randomUUID(),
      start,
      end: new Date(start.getTime() + 30 * 60_000),
      status: 'SCHEDULED' as const,
      patientFirstName: 'Ana María',
      patientPhone: '+57 310 555 0101',
      patientCountryCode: 'CO',
      providerName: 'Dra. Pérez',
      locationName: 'Sede Principal',
      locationAddress: 'Calle 1 # 2-3',
      ...overrides,
      confirmationSentAt: null,
      callbackRequestedAt: null,
    };
    this.appointments.set(appointment.id, appointment);
    return appointment;
  }

  findAppointment(id: string): Promise<ConfirmationAppointment | null> {
    return Promise.resolve(this.appointments.get(id) ?? null);
  }

  issue(input: IssueConfirmationInput): Promise<void> {
    for (const c of this.confirmations) {
      if (
        c.appointmentId === input.appointmentId &&
        !c.respondedAt &&
        !c.revokedAt
      ) {
        c.revokedAt = input.now;
      }
    }
    this.confirmations.push({
      id: randomUUID(),
      appointmentId: input.appointmentId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      appointmentStart: input.appointmentStart,
      appointmentStatus: input.appointmentStatus,
      respondedAt: null,
      response: null,
      revokedAt: null,
    });
    const appointment = this.appointments.get(input.appointmentId);
    if (appointment) appointment.confirmationSentAt = input.now;
    return Promise.resolve();
  }

  findByTokenHash(tokenHash: string): Promise<ConfirmationLookup | null> {
    const found = this.confirmations.find((c) => c.tokenHash === tokenHash);
    if (!found) return Promise.resolve(null);
    return Promise.resolve({
      confirmation: {
        id: found.id,
        appointmentId: found.appointmentId,
        expiresAt: found.expiresAt,
        appointmentStart: found.appointmentStart,
        appointmentStatus: found.appointmentStatus,
        respondedAt: found.respondedAt,
        response: found.response,
        revokedAt: found.revokedAt,
      },
      appointment: this.appointments.get(found.appointmentId) ?? null,
    });
  }

  findClinicBranding(): Promise<ClinicBranding | null> {
    return Promise.resolve(this.branding);
  }

  respond(input: RespondConfirmationInput): Promise<RespondOutcome> {
    const confirmation = this.confirmations.find(
      (c) => c.id === input.confirmationId,
    );
    if (!confirmation || confirmation.respondedAt || confirmation.revokedAt) {
      return Promise.resolve('ALREADY_USED');
    }
    const appointment = this.appointments.get(input.appointmentId);
    if (
      !appointment ||
      appointment.start.getTime() !== input.expectedStart.getTime() ||
      appointment.status !== input.expectedStatus
    ) {
      return Promise.resolve('STALE');
    }
    confirmation.respondedAt = input.now;
    confirmation.response = input.response;
    if (input.response === 'CONFIRM') appointment.status = 'CONFIRMED';
    if (input.response === 'CANCEL') appointment.status = 'CANCELLED';
    if (input.response === 'CALL_ME')
      appointment.callbackRequestedAt = input.now;
    return Promise.resolve('OK');
  }
}
