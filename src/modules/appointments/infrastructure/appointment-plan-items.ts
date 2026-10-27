import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import type { PlanItemReservedElsewhere } from '../domain/entities/appointment.entity';
import { PATIENT_FLOW_MESSAGES } from '../domain/patient-flow';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { resolveLocationTimeZones } from '../../../shared/locations/location-time-zone';
import {
  isHourCycle,
  requireLocationFormat,
} from '../../../shared/locations/location-regional';
import {
  AllowedLocations,
  isLocationAllowed,
} from '../../../shared/tenancy/location-access';
import {
  planItemsClosedMessage,
  planItemsEditable,
  heldInClinicMessage,
  heldInClinicToday,
  PLAN_ITEM_CLAIM_NOT_IN_CLINIC_MESSAGE,
  PLAN_ITEM_CLAIM_NOT_LINKED_MESSAGE,
  PLAN_ITEM_RESERVED_OTHER_LOCATION_MESSAGE,
  reservationHolderView,
  reservedElsewhereMessage,
} from '../domain/plan-item-reservation';

/** El ítem ya no se agenda (alta de vínculos y «Traer a esta cita»). */
export const PLAN_ITEM_NOT_SCHEDULABLE_MESSAGE =
  'Solo se agenda tratamiento aceptado y pendiente de un plan aceptado.';

/**
 * DX-273 (revisión I2): tratamiento que sigue por hacer: vivo, aceptado y de
 * un plan aceptado. Lo exigen el alta de vínculos, «Traer a esta cita», la
 * recuperación de la reserva y el aviso.
 */
const SCHEDULABLE_PLAN_ITEM: Prisma.TreatmentPlanItemWhereInput = {
  deletedAt: null,
  status: 'ACCEPTED',
  plan: { status: 'ACCEPTED', deletedAt: null },
};

/** Estados que reservan (mismo predicado que `dx256_link_reservation`). */
const PRE_ARRIVAL_RESERVING = [
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.CONFIRMED,
] as const;
const IN_CLINIC_RESERVING = [
  AppointmentStatus.ARRIVED,
  AppointmentStatus.IN_CHAIR,
  AppointmentStatus.READY_FOR_CHECKOUT,
] as const;

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
    throw new ConflictException(
      planItemsClosedMessage(before ?? current, new Date()),
    );
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
    throw new ConflictException(PLAN_ITEM_NOT_SCHEDULABLE_MESSAGE);
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
 *
 * «Viva» con el mismo predicado que `dx256_link_reservation`: el flag
 * `active` solo no basta, porque una cita que venció sin que nadie la tocara
 * lo conserva en true (M2). Si la cita es de una sede que el usuario no tiene
 * permitida (DX-089), no se enseña su fecha (M3).
 */
export async function planItemConflictMessage(
  tx: Prisma.TransactionClient,
  tenantId: string,
  planItemIds: readonly string[],
  appointmentId?: string,
  allowedLocations: AllowedLocations = 'ALL',
): Promise<string> {
  const now = new Date();
  const holder =
    planItemIds.length === 0
      ? null
      : await tx.appointmentPlanItem.findFirst({
          where: {
            planItemId: { in: [...planItemIds] },
            active: true,
            deletedAt: null,
            ...(appointmentId ? { appointmentId: { not: appointmentId } } : {}),
            appointment: {
              deletedAt: null,
              OR: [
                {
                  status: { in: [...PRE_ARRIVAL_RESERVING] },
                  start: { gte: now },
                },
                { status: { in: [...IN_CLINIC_RESERVING] } },
              ],
            },
          },
          orderBy: { appointment: { start: 'asc' } },
          select: {
            appointment: {
              select: {
                start: true,
                locationId: true,
                location: { select: { locale: true, hourCycle: true } },
              },
            },
          },
        });
  if (!holder) return reservedElsewhereMessage(null);
  const { start, locationId, location } = holder.appointment;
  if (!isLocationAllowed(allowedLocations, locationId))
    return PLAN_ITEM_RESERVED_OTHER_LOCATION_MESSAGE;
  const zoneOf = await resolveLocationTimeZones(tx, tenantId, [locationId]);
  // El formato, en crudo: lo pide el mensaje al pintar (G1-B, I4).
  return reservedElsewhereMessage({
    start,
    timeZone: zoneOf(locationId),
    location: { id: locationId, ...location },
  });
}

/** Reserva viva (mismo predicado que `dx256_link_reservation`). */
function liveReservingAppointment(now: Date): Prisma.AppointmentWhereInput {
  return {
    deletedAt: null,
    OR: [
      { status: { in: [...PRE_ARRIVAL_RESERVING] }, start: { gte: now } },
      { status: { in: [...IN_CLINIC_RESERVING] } },
    ],
  };
}

/**
 * DX-273 (revisión DX-271, I2): por cita, sus tratamientos con vínculo vivo
 * pero sin reserva (`active` false) que reserva OTRA cita viva. Solo citas de
 * sedes permitidas (DX-089): las demás se omiten sin dejar rastro, salvo la
 * de hoy con el paciente en la clínica (DX-293), que sale con `heldInClinic`
 * y sin cita, hora ni sede (`reservationHolderView`).
 */
export async function findPlanItemsReservedElsewhere(
  tx: Prisma.TransactionClient,
  tenantId: string,
  appointmentIds: readonly string[],
  allowedLocations: AllowedLocations,
): Promise<Map<string, PlanItemReservedElsewhere[]>> {
  const out = new Map<string, PlanItemReservedElsewhere[]>();
  if (appointmentIds.length === 0) return out;
  const now = new Date();
  const own = await tx.appointmentPlanItem.findMany({
    where: {
      appointmentId: { in: [...appointmentIds] },
      deletedAt: null,
      active: false,
      appointment: { deletedAt: null },
      planItem: SCHEDULABLE_PLAN_ITEM,
    },
    select: { appointmentId: true, planItemId: true },
  });
  if (own.length === 0) return out;
  const holders = await tx.appointmentPlanItem.findMany({
    where: {
      planItemId: { in: [...new Set(own.map((l) => l.planItemId))] },
      active: true,
      deletedAt: null,
      appointment: liveReservingAppointment(now),
    },
    select: {
      planItemId: true,
      appointmentId: true,
      appointment: {
        select: {
          status: true,
          start: true,
          locationId: true,
          location: { select: { name: true, locale: true, hourCycle: true } },
        },
      },
      planItem: { select: { toothNumber: true, catalogItemId: true } },
    },
  });
  if (holders.length === 0) return out;
  const [catalog, zoneOf] = await Promise.all([
    tx.dentalCatalogItem.findMany({
      where: {
        id: { in: [...new Set(holders.map((h) => h.planItem.catalogItemId))] },
      },
      select: { id: true, labelEs: true },
    }),
    resolveLocationTimeZones(tx, tenantId, [
      ...new Set(holders.map((h) => h.appointment.locationId)),
    ]),
  ]);
  const labels = new Map(catalog.map((c) => [c.id, c.labelEs]));
  const byItem = new Map(holders.map((h) => [h.planItemId, h]));
  for (const link of own) {
    const holder = byItem.get(link.planItemId);
    if (!holder || holder.appointmentId === link.appointmentId) continue;
    const view = reservationHolderView(
      {
        appointmentId: holder.appointmentId,
        status: holder.appointment.status,
        start: holder.appointment.start,
        locationId: holder.appointment.locationId,
        locationName: holder.appointment.location.name,
        // En crudo (I4): sin formato o sin reloj, null; no se formatea aquí.
        locationLocale: holder.appointment.location.locale,
        locationHourCycle: isHourCycle(holder.appointment.location.hourCycle)
          ? holder.appointment.location.hourCycle
          : null,
      },
      {
        timeZone: zoneOf(holder.appointment.locationId),
        locationAllowed: isLocationAllowed(
          allowedLocations,
          holder.appointment.locationId,
        ),
        now,
      },
    );
    if (!view) continue;
    const list = out.get(link.appointmentId) ?? [];
    list.push({
      planItemId: link.planItemId,
      name: labels.get(holder.planItem.catalogItemId) ?? 'Tratamiento',
      toothNumber: holder.planItem.toothNumber,
      ...view,
    });
    out.set(link.appointmentId, list);
  }
  // Por fecha de la titular; las de sede no permitida (sin fecha), al final.
  const startOf = (r: PlanItemReservedElsewhere) =>
    r.start?.getTime() ?? Number.POSITIVE_INFINITY;
  for (const list of out.values())
    list.sort(
      (a, b) =>
        startOf(a) - startOf(b) || a.planItemId.localeCompare(b.planItemId),
    );
  return out;
}

/** La cita que pide el tratamiento y la que lo tiene, bloqueadas. */
interface LockedClaimAppointment {
  id: string;
  status: AppointmentStatus;
  locationId: string;
  patientId: string;
}

export interface ClaimPlanItemInput {
  tenantId: string;
  appointmentId: string;
  planItemId: string;
  allowedLocations: AllowedLocations;
  audit: AuditRequestContext;
}

/**
 * DX-273 «Traer a esta cita», dentro de `tx`: la cita (con el paciente en la
 * clínica) pasa a reservar `planItemId`, que ya es suyo (vínculo vivo pero
 * sin reserva); la cita que lo reservaba retira su vínculo. Las dos filas de
 * `appointments` se bloquean en orden de id (sin interbloqueos entre dos
 * «Traer» cruzados) y todo se revalida con ellas bloqueadas. Un
 * `audit_event` APPOINTMENT_PLAN_ITEMS en cada cita, en la misma transacción.
 * Si ya lo reserva, no cambia nada. Devuelve la cita de la que vino (o null).
 *
 * DX-288: atómico entre citas distintas. Después de las citas se bloquea la
 * fila del ítem (FOR NO KEY UPDATE: no estorba a las FK que la miran), así
 * que dos «Traer» del mismo tratamiento se ponen en fila aunque no
 * compartan ninguna cita. Y no se trae desde una cita de hoy (día civil de
 * su sede) con el paciente en la clínica: la que llega después de la
 * primera (a la vez o no) recibe 409 en vez de quitársela. Una cita
 * olvidada en la clínica de otro día no lo impide.
 */
export async function claimPlanItemInTx(
  tx: Prisma.TransactionClient,
  input: ClaimPlanItemInput,
): Promise<{ fromAppointmentId: string | null }> {
  const { tenantId, appointmentId, planItemId } = input;
  const holderOf = () =>
    tx.appointmentPlanItem.findFirst({
      where: {
        planItemId,
        active: true,
        deletedAt: null,
        appointmentId: { not: appointmentId },
        appointment: liveReservingAppointment(new Date()),
      },
      select: {
        appointmentId: true,
        appointment: {
          select: {
            status: true,
            start: true,
            locationId: true,
            location: {
              select: { name: true, locale: true, hourCycle: true },
            },
          },
        },
      },
    });
  const seen = await holderOf();
  const ids = [appointmentId, ...(seen ? [seen.appointmentId] : [])].sort();
  const locked = await tx.$queryRaw<LockedClaimAppointment[]>`
    SELECT id, status, "locationId", "patientId" FROM appointments
     WHERE "tenantId"=${tenantId}::uuid AND "deletedAt" IS NULL
       AND id = ANY(${ids}::uuid[])
     ORDER BY id
       FOR UPDATE`;
  const target = locked.find((a) => a.id === appointmentId);
  if (!target) throw new NotFoundException('Cita no encontrada');
  if (
    !(IN_CLINIC_RESERVING as readonly AppointmentStatus[]).includes(
      target.status,
    )
  )
    throw new ConflictException(PLAN_ITEM_CLAIM_NOT_IN_CLINIC_MESSAGE);
  const own = await tx.appointmentPlanItem.findFirst({
    where: { appointmentId, planItemId, deletedAt: null },
    select: { active: true },
  });
  if (!own) throw new NotFoundException(PLAN_ITEM_CLAIM_NOT_LINKED_MESSAGE);
  if (own.active) return { fromAppointmentId: null };
  await tx.$queryRaw`
    SELECT 1 FROM treatment_plan_items
     WHERE id=${planItemId}::uuid AND "tenantId"=${tenantId}::uuid
       FOR NO KEY UPDATE`;
  // Revisión I2 (y DX-288 B1): con las citas y el ítem bloqueados, el
  // tratamiento sigue por hacer.
  const schedulable = await tx.treatmentPlanItem.count({
    where: { id: planItemId, ...SCHEDULABLE_PLAN_ITEM },
  });
  if (schedulable === 0)
    throw new ConflictException(PLAN_ITEM_NOT_SCHEDULABLE_MESSAGE);

  const holder = await holderOf();
  // DX-288 (revisión M1): la titular en la clínica de HOY (zona de su sede)
  // no lo suelta; una olvidada de otro día, sí. El 409 dice cuál solo si su
  // sede está permitida (DX-089).
  const held = holder?.appointment;
  const zoneOf = held
    ? await resolveLocationTimeZones(tx, tenantId, [held.locationId])
    : null;
  const heldToday =
    held && zoneOf
      ? heldInClinicToday(held, zoneOf(held.locationId), new Date())
      : false;
  // G1-B (I4): el formato de su sede se pide aquí, al pintar el 409; la
  // decisión de arriba solo usa la zona.
  const heldConflict = () =>
    new ConflictException(
      heldInClinicMessage(
        held &&
          zoneOf &&
          isLocationAllowed(input.allowedLocations, held.locationId)
          ? {
              start: held.start,
              timeZone: zoneOf(held.locationId),
              locationName: held.location.name,
              fmt: requireLocationFormat({
                id: held.locationId,
                ...held.location,
              }),
            }
          : null,
      ),
    );
  if ((holder?.appointmentId ?? null) !== (seen?.appointmentId ?? null))
    throw heldToday
      ? heldConflict()
      : new ConflictException(PATIENT_FLOW_MESSAGES.stale);
  const from = holder
    ? locked.find((a) => a.id === holder.appointmentId)!
    : null;
  if (from && !isLocationAllowed(input.allowedLocations, from.locationId))
    throw new ForbiddenException(PLAN_ITEM_RESERVED_OTHER_LOCATION_MESSAGE);
  if (heldToday) throw heldConflict();

  if (from)
    await tx.appointmentPlanItem.update({
      where: {
        tenantId_appointmentId_planItemId: {
          tenantId,
          appointmentId: from.id,
          planItemId,
        },
      },
      data: { deletedAt: new Date() },
    });
  // Reescribir el vínculo hace que `dx256_link_reservation` recalcule
  // `active` con el estado real de la cita (en la clínica → reserva).
  const claimed = await tx.appointmentPlanItem.update({
    where: {
      tenantId_appointmentId_planItemId: {
        tenantId,
        appointmentId,
        planItemId,
      },
    },
    data: { deletedAt: null },
    select: { active: true },
  });
  if (!claimed.active) throw new ConflictException(PATIENT_FLOW_MESSAGES.stale);

  const params = {
    planItemId,
    ...(from ? { fromAppointmentId: from.id } : {}),
    toAppointmentId: appointmentId,
  };
  for (const appointment of from ? [target, from] : [target]) {
    await writeAuditEvent(tx, {
      tenantId,
      // Cada evento en la sede de SU cita (revisión M2).
      locationId: appointment.locationId,
      actor: {
        kind: 'user',
        userId: input.audit.actor.userId,
        role: input.audit.actor.role,
      },
      action: 'UPDATE',
      resourceType: 'APPOINTMENT',
      resourceId: appointment.id,
      patient: { kind: 'patient', id: appointment.patientId },
      requestId: input.audit.requestId,
      ip: input.audit.ip,
      userAgent: input.audit.userAgent,
      metadata: {
        reason: 'APPOINTMENT_PLAN_ITEMS',
        changedFields: ['planItemIds'],
        params,
      },
    });
  }
  return { fromAppointmentId: from?.id ?? null };
}

/**
 * DX-273 (revisión I1): `fromAppointmentId` dejó de reservar estos
 * tratamientos (se canceló, se marcó no-show o se le quitaron). Si una cita
 * con el paciente en la clínica los tiene sin reserva (la reserva se quedó en
 * la otra al marcar «Llegó»), la más temprana la recupera en esta misma
 * transacción: reescribir su vínculo hace que `dx256_link_reservation`
 * recalcule `active`. Solo tratamiento por hacer y si nadie más lo reserva.
 * Un `audit_event` PLAN_ITEM_RESERVATION_RECOVERED en la cita que lo recupera
 * (en la sede de esa cita). Devuelve los ítems recuperados.
 */
export async function recoverReservationsInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  fromAppointmentId: string,
  planItemIds: readonly string[],
  audit: AuditRequestContext | undefined,
): Promise<string[]> {
  const recovered: string[] = [];
  for (const planItemId of [...planItemIds].sort()) {
    const holders = await tx.appointmentPlanItem.count({
      where: { planItemId, active: true, deletedAt: null },
    });
    if (holders > 0) continue;
    const candidate = await tx.appointmentPlanItem.findFirst({
      where: {
        planItemId,
        active: false,
        deletedAt: null,
        appointmentId: { not: fromAppointmentId },
        appointment: {
          deletedAt: null,
          status: { in: [...IN_CLINIC_RESERVING] },
        },
        planItem: SCHEDULABLE_PLAN_ITEM,
      },
      orderBy: [{ appointment: { start: 'asc' } }, { appointmentId: 'asc' }],
      select: {
        appointmentId: true,
        patientId: true,
        appointment: { select: { locationId: true } },
      },
    });
    if (!candidate) continue;
    const { active } = await tx.appointmentPlanItem.update({
      where: {
        tenantId_appointmentId_planItemId: {
          tenantId,
          appointmentId: candidate.appointmentId,
          planItemId,
        },
      },
      data: { deletedAt: null },
      select: { active: true },
    });
    if (!active) continue;
    recovered.push(planItemId);
    if (!audit) continue;
    await writeAuditEvent(tx, {
      tenantId,
      locationId: candidate.appointment.locationId,
      actor: {
        kind: 'user',
        userId: audit.actor.userId,
        role: audit.actor.role,
      },
      action: 'UPDATE',
      resourceType: 'APPOINTMENT',
      resourceId: candidate.appointmentId,
      patient: { kind: 'patient', id: candidate.patientId },
      requestId: audit.requestId,
      ip: audit.ip,
      userAgent: audit.userAgent,
      metadata: {
        reason: 'PLAN_ITEM_RESERVATION_RECOVERED',
        params: {
          planItemId,
          fromAppointmentId,
          toAppointmentId: candidate.appointmentId,
        },
      },
    });
  }
  return recovered;
}
