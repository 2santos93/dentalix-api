import { Injectable, NotFoundException } from '@nestjs/common';
import type { AppointmentStatus } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { addCivilMonths } from '../../../recall/domain/recall-rules';
import { RESERVED_APPOINTMENT_STATUSES } from '../../../treatment-plans/domain/plan-visits';

/** Lo que recepción comprueba al despedir al paciente; nada clínico. */
export const CHECKOUT_ITEMS = [
  'NEXT_VISIT',
  'PAYMENT',
  'PHONE',
  'EMAIL',
] as const;
export type CheckoutItem = (typeof CHECKOUT_ITEMS)[number];

export interface CheckoutChecklist {
  appointmentId: string;
  patientId: string;
  /** Próxima cita o, si no hay, el recall activo más cercano. */
  nextAppointmentStart: Date | null;
  recallDueOn: string | null;
  hasPhone: boolean;
  hasEmail: boolean;
  /** Dio de baja los recordatorios: tener el dato no basta para escribirle. */
  remindersOptedOut: boolean;
}

/**
 * DX-202: la lista de la salida del paciente. Solo lee: cerrar la visita con
 * algo pendiente está permitido (queda en la auditoría). El saldo lo añade el
 * controlador con `PatientBalanceFlags`, según el rol.
 */
@Injectable()
export class GetCheckoutChecklistUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    appointmentId: string,
    now = new Date(),
  ): Promise<CheckoutChecklist> {
    return this.prisma.runWithTenant(async (tx) => {
      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId, deletedAt: null },
        select: {
          id: true,
          locationId: true,
          patient: {
            select: {
              id: true,
              phone: true,
              email: true,
              reminderOptOutAt: true,
            },
          },
        },
      });
      if (!appointment) throw new NotFoundException('Cita no encontrada');
      this.tenantContext.assertLocationAllowed(appointment.locationId);
      const { patient } = appointment;
      const next = await tx.appointment.findFirst({
        where: {
          patientId: patient.id,
          deletedAt: null,
          id: { not: appointment.id },
          start: { gt: now },
          status: { in: RESERVED_APPOINTMENT_STATUSES as AppointmentStatus[] },
        },
        orderBy: { start: 'asc' },
        select: { start: true },
      });
      const recalls = await tx.patientRecall.findMany({
        where: { patientId: patient.id, active: true },
        select: { lastDoneAt: true, intervalMonths: true },
      });
      const dues = recalls
        .map((r) =>
          addCivilMonths(
            r.lastDoneAt.toISOString().slice(0, 10),
            r.intervalMonths,
          ),
        )
        .sort();
      return {
        appointmentId: appointment.id,
        patientId: patient.id,
        nextAppointmentStart: next?.start ?? null,
        recallDueOn: dues[0] ?? null,
        hasPhone: Boolean(patient.phone?.trim()),
        hasEmail: Boolean(patient.email?.trim()),
        remindersOptedOut: patient.reminderOptOutAt !== null,
      };
    });
  }
}
