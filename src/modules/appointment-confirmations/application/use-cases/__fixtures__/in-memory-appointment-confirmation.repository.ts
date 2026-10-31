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
import {
  isLateLinkCancellation,
  linkResponseBlock,
  type LinkCancellationPolicy,
} from '../../../domain/link-cancellation-policy';
import {
  confirmationLinkAuditEvent,
  confirmationResponseAuditEvent,
} from '../../../domain/confirmation-audit';
import { computeCancellationNotice } from '../../../../cancellation-policies/domain/cancellation-policy';
import type { AuditEventDraft } from '../../../../audit/domain/audit-event';
import type { TenantContextService } from '../../../../../shared/tenancy/tenant-context.service';

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
      /** DX-291: versión comunicada guardada al responder. */
      policyVersionId: string | null;
      /** DX-291: si la cancelación por el enlace fue tardía. */
      noticeLate: boolean | null;
    }
  >();
  /** DX-291: política vigente de la sede (una sola sede en el doble). */
  policy: LinkCancellationPolicy | null = null;
  readonly confirmations: StoredConfirmation[] = [];
  /** DX-361: eventos que el repositorio Prisma escribe en la transacción. */
  readonly auditEvents: AuditEventDraft[] = [];
  branding: ClinicBranding | null = {
    name: 'Clínica Sonrisa',
    primaryColor: '#0E7490',
    logoUrl: null,
  };

  /** El tenant de los eventos de la respuesta sale del contexto, como en Prisma. */
  constructor(private readonly tenantContext?: TenantContextService) {}

  addAppointment(overrides: Partial<ConfirmationAppointment> = {}) {
    const start = overrides.start ?? new Date(Date.now() + 24 * 3600_000);
    const appointment = {
      id: randomUUID(),
      start,
      end: new Date(start.getTime() + 30 * 60_000),
      status: 'SCHEDULED' as const,
      patientFirstName: 'Ana María',
      patientPhone: '+57 310 555 0101',
      providerName: 'Dra. Pérez',
      locationId: 'loc-principal',
      locationName: 'Sede Principal',
      locationAddress: 'Calle 1 # 2-3',
      // Sin región por defecto: cada test fija la suya (DX-329, m13).
      locationPhoneRegion: null,
      ...overrides,
      confirmationSentAt: null,
      callbackRequestedAt: null,
      policyVersionId: null as string | null,
      noticeLate: null as boolean | null,
    };
    this.appointments.set(appointment.id, appointment);
    return appointment;
  }

  findAppointment(id: string): Promise<ConfirmationAppointment | null> {
    return Promise.resolve(this.appointments.get(id) ?? null);
  }

  issue(input: IssueConfirmationInput): Promise<void> {
    const issuedFor = this.appointments.get(input.appointmentId);
    if (input.audit && issuedFor) {
      this.auditEvents.push(
        confirmationLinkAuditEvent(
          input.audit,
          issuedFor,
          issuedFor.confirmationSentAt !== null,
        ),
      );
    }
    for (const c of this.confirmations) {
      if (
        input.revokePrevious !== false &&
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
      policy: this.policy,
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
      confirmation.expiresAt.getTime() <= input.now.getTime() ||
      appointment.start.getTime() !== input.expectedStart.getTime() ||
      appointment.status !== input.expectedStatus
    ) {
      return Promise.resolve('STALE');
    }
    const late = isLateLinkCancellation(
      appointment.start,
      input.now,
      this.policy,
    );
    const block = linkResponseBlock({
      cancelling: input.response === 'CANCEL',
      late,
      acknowledgePolicy: input.acknowledgePolicy === true,
      shownPolicyVersionId: input.shownPolicyVersionId,
      currentPolicyId: this.policy?.id ?? null,
    });
    if (block) return Promise.resolve(block);
    if (this.policy) appointment.policyVersionId = this.policy.id;
    if (input.response === 'CANCEL') appointment.noticeLate = late;
    for (const link of this.confirmations) {
      if (
        link.appointmentId === input.appointmentId &&
        !link.respondedAt &&
        !link.revokedAt
      ) {
        link.respondedAt = input.now;
        link.response = input.response;
      }
    }
    this.auditEvents.push(
      confirmationResponseAuditEvent(input.request ?? null, {
        tenantId: this.tenantContext?.getTenantId() ?? 'tenant-en-memoria',
        appointmentId: appointment.id,
        locationId: appointment.locationId,
        response: input.response,
        statusBefore: appointment.status,
        notice:
          input.response === 'CANCEL'
            ? computeCancellationNotice({
                start: appointment.start,
                cancelledAt: input.now,
                byKind: 'PATIENT_LINK',
                noticeHours: this.policy?.noticeHours ?? null,
              })
            : null,
      }),
    );
    if (input.response === 'CONFIRM') appointment.status = 'CONFIRMED';
    if (input.response === 'CANCEL') appointment.status = 'CANCELLED';
    if (input.response === 'CALL_ME')
      appointment.callbackRequestedAt = input.now;
    return Promise.resolve('OK');
  }
}
