import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { resolveLocationTimeZones } from '../../../shared/locations/location-time-zone';
import {
  PLAN_ITEMS_CLOSED_MESSAGE,
  planItemsEditable,
  reservedElsewhereMessage,
} from '../domain/plan-item-reservation';

/** Estado y hora de la cita, para decidir si admite cambiar sus ítems. */
export interface PlanItemsAppointmentState {
  status: AppointmentStatus;
  start: Date;
}

/**
 * Bloquea la cita (FOR UPDATE) y devuelve su estado y su hora: lo que mira la
 * regla de DX-271 sin carreras con otro cambio de estado.
 */
export async function lockAppointmentForPlanItems(
  tx: Prisma.TransactionClient,
  tenantId: string,
  appointmentId: string,
): Promise<PlanItemsAppointmentState | null> {
  const [row] = await tx.$queryRaw<PlanItemsAppointmentState[]>`
    SELECT status, start FROM appointments
     WHERE id=${appointmentId}::uuid AND "tenantId"=${tenantId}::uuid
       AND "deletedAt" IS NULL
       FOR UPDATE`;
  return row ?? null;
}

/**
 * Reemplaza los ítems del plan de la cita. `before` es la cita antes de este
 * mismo PATCH (si cambia de estado u hora en la misma transacción): basta con
 * que esté abierta antes o después (`planItemsEditable`). Sin `before`, la
 * cita tal como está ahora.
 */
export async function replaceAppointmentPlanItems(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientId: string,
  appointmentId: string,
  ids: string[],
  before?: PlanItemsAppointmentState,
) {
  const current = await lockAppointmentForPlanItems(
    tx,
    tenantId,
    appointmentId,
  );
  if (!current) throw new NotFoundException('Appointment not found');
  // DX-271 (BE-039): los de una cita cerrada o pasada no se cambian.
  if (!planItemsEditable(before ?? current, current, new Date()))
    throw new ConflictException(PLAN_ITEMS_CLOSED_MESSAGE);
  if (ids.length > 100 || new Set(ids).size !== ids.length)
    throw new BadRequestException('Indica hasta 100 ítems distintos.');
  const items = ids.length
    ? await tx.treatmentPlanItem.findMany({
        where: { id: { in: ids }, patientId, deletedAt: null },
        include: { plan: { select: { status: true } } },
      })
    : [];
  if (items.length !== ids.length)
    throw new NotFoundException(
      'Algún tratamiento no existe o no pertenece a este paciente.',
    );
  if (
    items.some((i) => i.status !== 'ACCEPTED' || i.plan.status !== 'ACCEPTED')
  )
    throw new ConflictException(
      'Solo se agenda tratamiento aceptado y pendiente de un plan aceptado.',
    );
  await tx.appointmentPlanItem.updateMany({
    where: { appointmentId, planItemId: { notIn: ids }, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  const linked = await tx.appointmentPlanItem.findMany({
    where: { appointmentId },
    select: { planItemId: true },
  });
  const existing = new Set(linked.map((l) => l.planItemId));
  for (const planItemId of [...ids].sort()) {
    if (existing.has(planItemId))
      await tx.appointmentPlanItem.update({
        where: {
          tenantId_appointmentId_planItemId: {
            tenantId,
            appointmentId,
            planItemId,
          },
        },
        data: { deletedAt: null },
      });
    else
      await tx.appointmentPlanItem.create({
        data: { tenantId, patientId, appointmentId, planItemId },
      });
  }
}
/**
 * ¿El error es el choque con `appointment_plan_items_active_key` (el ítem ya
 * está reservado en otra cita viva)? Prisma lo da como P2002 (ORM) o, cuando
 * salta dentro de un trigger, como error desconocido con el nombre del índice.
 */
export function isPlanItemConflict(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002') ||
    (error instanceof Prisma.PrismaClientUnknownRequestError &&
      error.message.includes('appointment_plan_items_active_key'))
  );
}

/**
 * DX-271 (BE-038): el 409 de reserva dice en qué cita está el ítem, con la
 * fecha en la zona de la sede de esa cita. Se busca DESPUÉS del rechazo, en
 * otra transacción: la reserva viva de alguno de `planItemIds` en otra cita
 * (la más próxima). Si ya no existe (se liberó a la vez), el mensaje general.
 */
export async function planItemConflictMessage(
  tx: Prisma.TransactionClient,
  tenantId: string,
  planItemIds: readonly string[],
  appointmentId?: string,
): Promise<string> {
  const holder =
    planItemIds.length === 0
      ? null
      : await tx.appointmentPlanItem.findFirst({
          where: {
            planItemId: { in: [...planItemIds] },
            active: true,
            ...(appointmentId ? { appointmentId: { not: appointmentId } } : {}),
          },
          orderBy: { appointment: { start: 'asc' } },
          select: {
            appointment: { select: { start: true, locationId: true } },
          },
        });
  if (!holder) return reservedElsewhereMessage(null, 'UTC');
  const zoneOf = await resolveLocationTimeZones(tx, tenantId, [
    holder.appointment.locationId,
  ]);
  return reservedElsewhereMessage(
    holder.appointment.start,
    zoneOf(holder.appointment.locationId),
  );
}
