import { Prisma } from '@prisma/client';
import { resolveLocationTimeZones } from '../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../shared/time/civil-day';
import { minimumVisitDate } from '../domain/plan-visits';

/**
 * Mínimo de una visita del plan en un momento dado (DX-273). Misma regla que
 * `GET /treatment-plans/:id/visits` (DX-256): la última cita COMPLETED de la
 * visita anterior más el intervalo, en la zona de la sede del plan.
 * `minimumDay` = null si no hay mínimo clínico (ninguna cita de la visita
 * anterior completada, o intervalo 0).
 */
export interface VisitMinimumSnapshot {
  planId: string;
  visit: number;
  minimumDay: string | null;
  /** La cita completada que fija el mínimo (la última), o null. */
  anchorAppointmentId: string | null;
}

/**
 * Los mínimos de las visitas SIGUIENTES a las de los ítems vinculados a la
 * cita: lo que cambia si la cita deja de estar completada. Se llama dos veces
 * en la misma transacción (antes y después del cambio de estado).
 */
export async function nextVisitMinimums(
  tx: Prisma.TransactionClient,
  tenantId: string,
  appointmentId: string,
  fallbackLocationId: string,
  now: Date,
): Promise<VisitMinimumSnapshot[]> {
  const linked = await tx.appointmentPlanItem.findMany({
    where: { appointmentId, deletedAt: null, planItem: { deletedAt: null } },
    select: { planItem: { select: { planId: true, visit: true } } },
  });
  if (linked.length === 0) return [];
  const plans = await tx.treatmentPlan.findMany({
    where: {
      id: { in: [...new Set(linked.map((l) => l.planItem.planId))] },
      deletedAt: null,
    },
    select: {
      id: true,
      acceptedLocationId: true,
      presentedLocationId: true,
      visitIntervals: true,
      items: { where: { deletedAt: null }, select: { visit: true } },
    },
  });
  const locationOf = (plan: (typeof plans)[number]) =>
    plan.acceptedLocationId ?? plan.presentedLocationId ?? fallbackLocationId;
  const zoneOf = await resolveLocationTimeZones(tx, tenantId, [
    ...new Set(plans.map(locationOf)),
  ]);
  const pairs = [
    ...new Map(
      linked.map((l) => [`${l.planItem.planId}:${l.planItem.visit}`, l]),
    ).values(),
  ]
    .map((l) => ({ planId: l.planItem.planId, visit: l.planItem.visit + 1 }))
    .sort((a, b) => a.planId.localeCompare(b.planId) || a.visit - b.visit);

  const out: VisitMinimumSnapshot[] = [];
  for (const { planId, visit } of pairs) {
    const plan = plans.find((p) => p.id === planId);
    if (!plan || !plan.items.some((i) => i.visit === visit)) continue;
    const interval =
      (plan.visitIntervals as Record<string, number>)[String(visit)] ?? 0;
    const anchor = await tx.appointmentPlanItem.findFirst({
      where: {
        deletedAt: null,
        planItem: { planId, visit: visit - 1, deletedAt: null },
        appointment: { status: 'COMPLETED', deletedAt: null },
      },
      orderBy: [{ appointment: { end: 'desc' } }, { appointmentId: 'asc' }],
      select: { appointment: { select: { id: true, end: true } } },
    });
    const timeZone = zoneOf(locationOf(plan));
    out.push({
      planId,
      visit,
      minimumDay:
        anchor && interval
          ? civilDateIn(
              minimumVisitDate(anchor.appointment.end, interval, now, timeZone),
              timeZone,
            )
          : null,
      anchorAppointmentId: anchor?.appointment.id ?? null,
    });
  }
  return out;
}
