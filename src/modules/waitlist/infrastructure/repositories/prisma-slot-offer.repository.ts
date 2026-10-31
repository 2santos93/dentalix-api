import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { requireLocationTimeZone } from '../../../../shared/locations/location-time-zone';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import { overlapExclusionScope } from '../../../appointments/application/appointment-overlap-error';
import { MOVABLE_STATUSES } from '../../domain/opening-candidates';
import { markWaitlistEntryScheduled } from '../waitlist-transitions';
import {
  SLOT_OFFER_AUDIT_REASONS,
  publicSlotOfferState,
} from '../../domain/slot-offer-link';
import type {
  ClinicBrandingRow,
  PublicSlotOffer,
  SlotOfferRepository,
  SlotOfferResolution,
} from '../../domain/ports/slot-offer-repository.port';

const MINUTE = 60_000;

type Tx = Prisma.TransactionClient;

/** Conflicto que deshace la transacción del aceptar (el hueco ya no está). */
class SlotGoneError extends Error {}

function offerAuditEvent(
  offer: {
    id: string;
    tenantId: string;
    locationId: string;
    patientId: string;
  },
  reason: (typeof SLOT_OFFER_AUDIT_REASONS)[keyof typeof SLOT_OFFER_AUDIT_REASONS],
  /** `null`: el evento no es de quien hizo la petición (otra oferta, el barrido). */
  meta: AuditRequestMeta | null,
  byPatient: boolean,
): AuditEventDraft {
  return {
    tenantId: offer.tenantId,
    locationId: offer.locationId,
    actor: byPatient ? { kind: 'patient' } : { kind: 'system' },
    action: 'UPDATE',
    resourceType: 'WAITLIST_OFFER',
    resourceId: offer.id,
    patient: { kind: 'patient', id: offer.patientId },
    requestId: meta?.requestId ?? null,
    ip: meta?.ip ?? null,
    userAgent: meta?.userAgent ?? null,
    metadata: { origin: 'PUBLIC_LINK', reason },
  };
}

type Slot = { start: Date; end: Date; providerId: string };
const slotOf = (s: Slot) => ({
  start: s.start.toISOString(),
  end: s.end.toISOString(),
  providerId: s.providerId,
});

/**
 * La cita creada (CREATE) o adelantada (UPDATE, con la hora anterior y la
 * nueva) desde el enlace: el paciente, origen PUBLIC_LINK.
 */
function appointmentAuditEvent(
  offer: PublicSlotOffer,
  appointmentId: string,
  before: Slot | null,
  meta: AuditRequestMeta,
): AuditEventDraft {
  const after: Slot = {
    start: offer.slotStart,
    end: offer.appointmentEnd,
    providerId: offer.providerId,
  };
  return {
    tenantId: offer.tenantId,
    locationId: offer.locationId,
    actor: { kind: 'patient' },
    action: before ? 'UPDATE' : 'CREATE',
    resourceType: 'APPOINTMENT',
    resourceId: appointmentId,
    patient: { kind: 'appointment', id: appointmentId },
    requestId: meta.requestId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    metadata: {
      origin: 'PUBLIC_LINK',
      reason: SLOT_OFFER_AUDIT_REASONS.ACCEPTED,
      ...(before ? { move: { from: slotOf(before), to: slotOf(after) } } : {}),
    },
  };
}

/** Choca con una cita viva (no cancelada) en [start, end). */
function liveOverlap(start: Date, end: Date): Prisma.AppointmentWhereInput {
  return {
    deletedAt: null,
    status: { not: 'CANCELLED' },
    start: { lt: end },
    end: { gt: start },
  };
}

@Injectable()
export class PrismaSlotOfferRepository implements SlotOfferRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  findByTokenHash(tokenHash: string): Promise<PublicSlotOffer | null> {
    // REPEATABLE READ: oferta, sede, pendiente y cita en la misma foto.
    return this.prisma.runWithTenant(
      async (tx) => {
        const row = await tx.waitlistOffer.findUnique({
          where: { tokenHash },
          include: {
            patient: { select: { firstName: true, deletedAt: true } },
            location: {
              select: {
                id: true,
                name: true,
                address: true,
                timeZone: true,
                locale: true,
                hourCycle: true,
              },
            },
            waitlistEntry: {
              select: {
                durationMinutes: true,
                appointmentType: { select: { id: true, active: true } },
              },
            },
            appointment: { select: { start: true, end: true } },
          },
        });
        if (!row) return null;
        // El profesional es un usuario global: su nombre, por la membresía
        // (RLS), así que solo aparece si es de esta clínica.
        const membership = await tx.clinicMembership.findFirst({
          where: { userId: row.providerId },
          orderBy: { createdAt: 'desc' },
          select: { user: { select: { fullName: true } } },
        });
        const durationMs = row.appointment
          ? row.appointment.end.getTime() - row.appointment.start.getTime()
          : row.waitlistEntry
            ? row.waitlistEntry.durationMinutes * MINUTE
            : row.slotEnd.getTime() - row.slotStart.getTime();
        const type = row.waitlistEntry?.appointmentType;
        return {
          id: row.id,
          tenantId: row.tenantId,
          locationId: row.locationId,
          providerId: row.providerId,
          patientId: row.patientId,
          waitlistEntryId: row.waitlistEntryId,
          appointmentId: row.appointmentId,
          outcome: row.outcome,
          expiresAt: row.expiresAt,
          patientArchived: row.patient.deletedAt !== null,
          createdAt: row.createdAt,
          slotStart: row.slotStart,
          appointmentEnd: new Date(row.slotStart.getTime() + durationMs),
          patientFirstName: row.patient.firstName,
          providerName: membership?.user.fullName ?? null,
          locationName: row.location.name,
          locationAddress: row.location.address,
          timeZone: requireLocationTimeZone(row.location),
          locale: row.location.locale,
          hourCycle: row.location.hourCycle,
          currentAppointmentStart: row.appointment?.start ?? null,
          appointmentTypeId: type?.active ? type.id : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  findClinicBranding(): Promise<ClinicBrandingRow | null> {
    // `tenants` no tiene RLS: se lee por el id ya resuelto desde el host.
    return this.prisma.tenant.findFirst({
      where: { id: this.requireTenantId(), deletedAt: null },
      select: { name: true, primaryColor: true, logoUrl: true },
    });
  }

  slotTaken(offer: PublicSlotOffer): Promise<boolean> {
    return this.prisma.runWithTenant((tx) => this.takenIn(tx, offer));
  }

  private async takenIn(tx: Tx, offer: PublicSlotOffer): Promise<boolean> {
    const window = liveOverlap(offer.slotStart, offer.appointmentEnd);
    const clash = await tx.appointment.findFirst({
      where: {
        ...window,
        OR: [{ providerId: offer.providerId }, { patientId: offer.patientId }],
        ...(offer.appointmentId ? { id: { not: offer.appointmentId } } : {}),
      },
      select: { id: true },
    });
    return clash !== null;
  }

  async accept(
    offer: PublicSlotOffer,
    now: Date,
    meta: AuditRequestMeta,
  ): Promise<SlotOfferResolution> {
    try {
      return await this.prisma.runWithTenant((tx) =>
        this.acceptIn(tx, offer, now, meta),
      );
    } catch (error) {
      // El EXCLUDE de la BD (23P01) es el respaldo de la carrera contra
      // recepción, que agenda sin pasar por el candado: el hueco ya no está.
      if (error instanceof SlotGoneError || overlapExclusionScope(error)) {
        return { state: 'UNAVAILABLE', appointmentId: null };
      }
      throw error;
    }
  }

  private async acceptIn(
    tx: Tx,
    offer: PublicSlotOffer,
    now: Date,
    meta: AuditRequestMeta,
  ): Promise<SlotOfferResolution> {
    const tenantId = offer.tenantId;
    // DX-461: primero el paciente (el orden de archivar: paciente, luego sus
    // ofertas). Si archivar está en curso, se espera a su COMMIT y se ve
    // archivado: nunca una cita SCHEDULED de un paciente archivado.
    if (!(await this.lockLivePatient(tx, offer.patientId))) {
      return { state: 'EXPIRED', appointmentId: null };
    }
    // El candado de las asignaciones del profesional (el de «Agendar aquí»,
    // DX-122): dos aceptaciones del mismo hueco van una detrás de otra.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(
      hashtext('dx_waitlist_assignment:' || ${tenantId}),
      hashtext(${offer.providerId})
    )`;
    const current = await this.lockOffer(tx, offer.id);
    if (!current) return { state: 'UNAVAILABLE', appointmentId: null };
    const state = publicSlotOfferState(current, now, false);
    if (state !== 'OPEN') {
      if (state === 'EXPIRED' && current.outcome === 'PENDING') {
        await this.resolve(tx, offer, 'EXPIRED', now, meta, false);
      }
      return { state, appointmentId: null };
    }
    // Hueco ocupado (con el candado, ya es firme): «ya se ocupó» solo si lo
    // ganó otra oferta con enlace DESPUÉS de crearse esta; una aceptación
    // vieja cuya cita se canceló no cuenta, porque entonces el hueco no
    // estaría ocupado. Si lo ocupó otra vía, «ya no está disponible».
    if (await this.takenIn(tx, offer)) {
      const winner = await tx.waitlistOffer.findFirst({
        where: {
          id: { not: offer.id },
          locationId: offer.locationId,
          providerId: offer.providerId,
          channel: { in: ['LINK_WA_ME', 'LINK_EMAIL'] },
          outcome: 'ACCEPTED',
          outcomeAt: { gte: offer.createdAt },
          slotStart: { lt: offer.appointmentEnd },
          slotEnd: { gt: offer.slotStart },
        },
        select: { id: true },
      });
      if (!winner) return { state: 'UNAVAILABLE', appointmentId: null };
      await this.resolve(tx, offer, 'TAKEN_BY_OTHER', now, null, false);
      return { state: 'TAKEN', appointmentId: null };
    }

    const before = offer.appointmentId
      ? await tx.appointment.findFirst({
          where: { id: offer.appointmentId, deletedAt: null },
          select: { start: true, end: true, providerId: true },
        })
      : null;
    const appointmentId = offer.appointmentId
      ? await this.moveAppointment(tx, offer)
      : await this.createAppointment(tx, offer);
    await writeAuditEvent(
      tx,
      appointmentAuditEvent(offer, appointmentId, before, meta),
    );

    await this.resolve(tx, offer, 'ACCEPTED', now, meta, true);
    // Las demás ofertas pendientes de este hueco (de cualquier canal) se
    // quedan sin él.
    const siblings = await tx.waitlistOffer.findMany({
      where: {
        id: { not: offer.id },
        providerId: offer.providerId,
        locationId: offer.locationId,
        outcome: 'PENDING',
        slotStart: { lt: offer.appointmentEnd },
        slotEnd: { gt: offer.slotStart },
      },
      select: { id: true, tenantId: true, locationId: true, patientId: true },
    });
    if (siblings.length > 0) {
      await tx.waitlistOffer.updateMany({
        where: { id: { in: siblings.map((s) => s.id) }, outcome: 'PENDING' },
        data: { outcome: 'TAKEN_BY_OTHER', outcomeAt: now },
      });
      for (const sibling of siblings) {
        await writeAuditEvent(
          tx,
          // Sin la IP ni el UA del que aceptó: el evento es de otra oferta.
          offerAuditEvent(
            sibling,
            SLOT_OFFER_AUDIT_REASONS.TAKEN_BY_OTHER,
            null,
            false,
          ),
        );
      }
    }
    return { state: 'ACCEPTED', appointmentId };
  }

  async decline(
    offer: PublicSlotOffer,
    now: Date,
    meta: AuditRequestMeta,
  ): Promise<SlotOfferResolution> {
    return this.prisma.runWithTenant(async (tx) => {
      if (!(await this.lockLivePatient(tx, offer.patientId))) {
        return { state: 'EXPIRED', appointmentId: null };
      }
      const current = await this.lockOffer(tx, offer.id);
      if (!current) return { state: 'UNAVAILABLE', appointmentId: null };
      const state = publicSlotOfferState(current, now, false);
      if (state === 'EXPIRED' && current.outcome === 'PENDING') {
        await this.resolve(tx, offer, 'EXPIRED', now, meta, false);
        return { state, appointmentId: null };
      }
      if (state !== 'OPEN') return { state, appointmentId: null };
      await this.resolve(tx, offer, 'DECLINED', now, meta, true);
      return { state: 'DECLINED', appointmentId: null };
    });
  }

  async tenantIds(): Promise<string[]> {
    // `tenants` no tiene RLS: el barrido recorre las clínicas vivas.
    const rows = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  expireDue(tenantId: string, now: Date, limit: number): Promise<number> {
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      // Lo sirve waitlist_offers_tenant_provider_slot_pending_idx (parcial
      // PENDING). El UPDATE es condicional: si una aceptación en curso la
      // resuelve antes, el barrido no la toca.
      const due = await tx.waitlistOffer.findMany({
        where: { outcome: 'PENDING', expiresAt: { lte: now } },
        select: { id: true, locationId: true, patientId: true },
        orderBy: { expiresAt: 'asc' },
        take: limit,
      });
      for (const row of due) {
        const { count } = await tx.waitlistOffer.updateMany({
          where: { id: row.id, outcome: 'PENDING' },
          data: { outcome: 'EXPIRED', outcomeAt: now },
        });
        if (count === 0) continue;
        await writeAuditEvent(
          tx,
          offerAuditEvent(
            { ...row, tenantId },
            SLOT_OFFER_AUDIT_REASONS.EXPIRED,
            null,
            false,
          ),
        );
      }
      return due.length;
    });
  }

  /**
   * DX-461: ¿sigue vivo el paciente? FOR SHARE choca con el FOR UPDATE de
   * archivar: o se responde antes de que archive, o después viéndolo
   * archivado. Varias respuestas del mismo paciente no se esperan entre sí.
   */
  private async lockLivePatient(tx: Tx, patientId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ deletedAt: Date | null }[]>`
      SELECT "deletedAt" FROM "patients"
       WHERE "id" = ${patientId}::uuid FOR SHARE`;
    return rows.length > 0 && rows[0].deletedAt === null;
  }

  /** Relee la oferta con la fila bloqueada (la verdad de la transacción). */
  private async lockOffer(
    tx: Tx,
    id: string,
  ): Promise<{
    outcome: PublicSlotOffer['outcome'];
    expiresAt: Date | null;
  } | null> {
    const rows = await tx.$queryRaw<
      { outcome: PublicSlotOffer['outcome']; expiresAt: Date | null }[]
    >`SELECT "outcome", "expiresAt" FROM "waitlist_offers"
       WHERE "id" = ${id}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  private async resolve(
    tx: Tx,
    offer: PublicSlotOffer,
    outcome: 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'TAKEN_BY_OTHER',
    now: Date,
    meta: AuditRequestMeta | null,
    byPatient: boolean,
  ): Promise<void> {
    const { count } = await tx.waitlistOffer.updateMany({
      where: { id: offer.id, outcome: 'PENDING' },
      data: { outcome, outcomeAt: now },
    });
    if (count === 0) return;
    await writeAuditEvent(
      tx,
      offerAuditEvent(
        offer,
        SLOT_OFFER_AUDIT_REASONS[outcome],
        meta,
        byPatient,
      ),
    );
  }

  /** Pendiente de la lista → cita SCHEDULED; la entrada pasa a SCHEDULED. */
  private async createAppointment(
    tx: Tx,
    offer: PublicSlotOffer,
  ): Promise<string> {
    const created = await tx.appointment.create({
      data: {
        tenantId: offer.tenantId,
        locationId: offer.locationId,
        patientId: offer.patientId,
        providerId: offer.providerId,
        start: offer.slotStart,
        end: offer.appointmentEnd,
        appointmentTypeId: offer.appointmentTypeId,
        createdById: null,
      },
      select: { id: true },
    });
    if (
      offer.waitlistEntryId &&
      !(await markWaitlistEntryScheduled(
        tx,
        offer.waitlistEntryId,
        created.id,
        null,
      ))
    ) {
      // La entrada ya no está abierta (la agendaron o descartaron): deshace.
      throw new SlotGoneError();
    }
    return created.id;
  }

  /**
   * Cita «Adelantar si hay hueco» → al hueco, sin la marca, como el
   * «Asignar» de DX-210: su hora original queda libre. Condicionado a que
   * siga marcada y agendada/confirmada; los enlaces de confirmación sin
   * responder dejan de valer (hablaban de la hora vieja).
   */
  private async moveAppointment(
    tx: Tx,
    offer: PublicSlotOffer,
  ): Promise<string> {
    const id = offer.appointmentId!;
    const { count } = await tx.appointment.updateMany({
      where: {
        id,
        deletedAt: null,
        wantsEarlier: true,
        status: { in: [...MOVABLE_STATUSES] },
        start: { gt: offer.slotStart },
      },
      data: {
        start: offer.slotStart,
        end: offer.appointmentEnd,
        providerId: offer.providerId,
        wantsEarlier: false,
        confirmationSentAt: null,
        callbackRequestedAt: null,
      },
    });
    if (count === 0) throw new SlotGoneError();
    await tx.appointmentConfirmation.updateMany({
      where: { appointmentId: id, revokedAt: null, respondedAt: null },
      data: { revokedAt: new Date() },
    });
    return id;
  }
}
