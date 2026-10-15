import { Injectable } from '@nestjs/common';
import {
  AppointmentConfirmationResponse,
  AppointmentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  AppointmentConfirmationRepository,
  ConfirmationLookup,
  IssueConfirmationInput,
  RespondConfirmationInput,
  RespondOutcome,
} from '../../domain/ports/appointment-confirmation-repository.port';
import {
  AppointmentConfirmation,
  ClinicBranding,
  ConfirmationAppointment,
} from '../../domain/entities/appointment-confirmation.entity';

/** Solo lo que el flujo necesita: nada clínico (ni motivo ni notas). */
const APPOINTMENT_SELECT = {
  id: true,
  start: true,
  end: true,
  status: true,
  providerId: true,
  patient: { select: { firstName: true, phone: true, countryCode: true } },
  location: { select: { name: true, address: true } },
} as const satisfies Prisma.AppointmentSelect;

type SelectedAppointment = Prisma.AppointmentGetPayload<{
  select: typeof APPOINTMENT_SELECT;
}>;

const CONFIRMATION_SELECT = {
  id: true,
  appointmentId: true,
  expiresAt: true,
  appointmentStart: true,
  appointmentStatus: true,
  respondedAt: true,
  response: true,
  revokedAt: true,
} as const satisfies Prisma.AppointmentConfirmationSelect;

/** Qué le hace a la cita cada respuesta del paciente. */
function appointmentPatchFor(
  response: AppointmentConfirmationResponse,
  now: Date,
): Prisma.AppointmentUpdateManyMutationInput {
  switch (response) {
    case AppointmentConfirmationResponse.CONFIRM:
      return { status: AppointmentStatus.CONFIRMED };
    case AppointmentConfirmationResponse.CANCEL:
      return { status: AppointmentStatus.CANCELLED };
    case AppointmentConfirmationResponse.CALL_ME:
      return { callbackRequestedAt: now };
  }
}

/** Fuerza el ROLLBACK de `respond` cuando la cita cambió bajo nuestros pies. */
class StaleAppointmentError extends Error {}

@Injectable()
export class PrismaAppointmentConfirmationRepository implements AppointmentConfirmationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Mismo motivo que en PrismaAppointmentRepository: un INSERT necesita el tenantId explícito. */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  private async toAppointment(
    tx: Prisma.TransactionClient,
    a: SelectedAppointment,
  ): Promise<ConfirmationAppointment> {
    // El profesional es un usuario global; su nombre se lee a través de la
    // membresía, que tiene RLS, así que solo aparece si es de esta clínica.
    // Sin filtrar `deletedAt`: si dejó la clínica, la cita sigue siendo suya.
    const membership = await tx.clinicMembership.findFirst({
      where: { userId: a.providerId },
      orderBy: { createdAt: 'desc' },
      select: { user: { select: { fullName: true } } },
    });
    return {
      id: a.id,
      start: a.start,
      end: a.end,
      status: a.status,
      patientFirstName: a.patient.firstName,
      patientPhone: a.patient.phone,
      patientCountryCode: a.patient.countryCode,
      providerName: membership?.user.fullName ?? null,
      locationName: a.location.name,
      locationAddress: a.location.address,
    };
  }

  async findAppointment(
    appointmentId: string,
  ): Promise<ConfirmationAppointment | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId, deletedAt: null },
        select: APPOINTMENT_SELECT,
      });
      return appointment ? this.toAppointment(tx, appointment) : null;
    });
  }

  async issue(input: IssueConfirmationInput): Promise<void> {
    const tenantId = this.requireTenantId();
    await this.prisma.runWithTenant(async (tx) => {
      // "Reenviar" = sustituir: solo el último enlace de la cita es válido.
      await tx.appointmentConfirmation.updateMany({
        where: {
          appointmentId: input.appointmentId,
          respondedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: input.now },
      });
      await tx.appointmentConfirmation.create({
        data: {
          tenantId,
          appointmentId: input.appointmentId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          appointmentStart: input.appointmentStart,
          appointmentStatus: input.appointmentStatus,
          createdById: input.createdById,
        },
      });
      // Un nuevo enlace reemplaza a cualquier "pide llamada" anterior: la
      // conversación vuelve a empezar desde este mensaje.
      await tx.appointment.update({
        where: { id: input.appointmentId },
        data: { confirmationSentAt: input.now, callbackRequestedAt: null },
      });
    });
  }

  async findByTokenHash(tokenHash: string): Promise<ConfirmationLookup | null> {
    // REPEATABLE READ: enlace y cita se leen en dos sentencias y TIENEN que
    // verse en la misma foto. En READ COMMITTED, si otra respuesta hace COMMIT
    // entre las dos lecturas se ve el enlace aún sin responder pero la cita ya
    // CONFIRMED/CANCELLED → "la cita cambió" → 410, cuando lo correcto es
    // "ya respondido" (409). Era el fallo intermitente de "dos clics
    // simultáneos". Solo lee, así que RR no puede fallar por serialización.
    return this.prisma.runWithTenant(
      async (tx) => {
        const confirmation = await tx.appointmentConfirmation.findUnique({
          where: { tokenHash },
          select: CONFIRMATION_SELECT,
        });
        if (!confirmation) return null;
        const appointment = await tx.appointment.findFirst({
          where: { id: confirmation.appointmentId, deletedAt: null },
          select: APPOINTMENT_SELECT,
        });
        return {
          confirmation: confirmation satisfies AppointmentConfirmation,
          appointment: appointment
            ? await this.toAppointment(tx, appointment)
            : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async findClinicBranding(): Promise<ClinicBranding | null> {
    // `tenants` no tiene RLS (igual que PrismaTenantBrandingRepository): se lee
    // por el id ya resuelto desde el host.
    const tenantId = this.requireTenantId();
    return this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { name: true, primaryColor: true, logoUrl: true },
    });
  }

  async respond(input: RespondConfirmationInput): Promise<RespondOutcome> {
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        // Un solo uso, a prueba de carreras: el UPDATE condicional "reclama" el
        // enlace. Si dos clics llegan a la vez, el segundo espera al COMMIT del
        // primero, re-evalúa el WHERE (ya con respondedAt) y no toca nada.
        const claimed = await tx.appointmentConfirmation.updateMany({
          where: {
            id: input.confirmationId,
            respondedAt: null,
            revokedAt: null,
          },
          data: { respondedAt: input.now, response: input.response },
        });
        if (claimed.count === 0) return 'ALREADY_USED';

        // La cita solo se toca si sigue como al emitir el enlace; si no, se
        // revierte también el "reclamo" de arriba.
        const updated = await tx.appointment.updateMany({
          where: {
            id: input.appointmentId,
            deletedAt: null,
            start: input.expectedStart,
            status: input.expectedStatus,
          },
          data: appointmentPatchFor(input.response, input.now),
        });
        if (updated.count === 0) throw new StaleAppointmentError();
        return 'OK';
      });
    } catch (error) {
      if (error instanceof StaleAppointmentError) return 'STALE';
      throw error;
    }
  }
}
