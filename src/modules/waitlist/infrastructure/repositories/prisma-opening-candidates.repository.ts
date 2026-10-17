import { Injectable } from '@nestjs/common';
import {
  Prisma,
  WaitlistStatus,
  type WaitlistOfferOutcome,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { MOVABLE_STATUSES } from '../../domain/opening-candidates';
import type {
  AppointmentCandidateRow,
  CandidatePatient,
  CreateWaitlistOfferRepoInput,
  EntryCandidateRow,
  OfferSummary,
  OfferTarget,
  OpeningCandidatesRepository,
  WaitlistOffer,
} from '../../domain/ports/opening-candidates-repository.port';

/**
 * Lo grueso de la consulta: el tope real de la respuesta es 50
 * (`rankOpeningCandidates`), pero la regla fina (profesional, mismo día,
 * quien liberó el hueco) se aplica después; este margen evita que el filtro
 * fino se quede sin filas sin leer la sede entera.
 */
const SOURCE_LIMIT = 500;

const PATIENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  contactChannel: true,
  reminderOptOutAt: true,
} as const satisfies Prisma.PatientSelect;

const TYPE_SELECT = {
  select: { id: true, name: true, durationMinutes: true, color: true },
} as const;

type OfferRow = Prisma.WaitlistOfferGetPayload<Record<string, never>>;

function mapOffer(row: OfferRow): WaitlistOffer {
  return {
    id: row.id,
    locationId: row.locationId,
    slotStart: row.slotStart,
    slotEnd: row.slotEnd,
    providerId: row.providerId,
    patientId: row.patientId,
    waitlistEntryId: row.waitlistEntryId,
    appointmentId: row.appointmentId,
    channel: row.channel,
    outcome: row.outcome,
    offerDay: row.offerDay.toISOString().slice(0, 10),
    createdById: row.createdById,
    outcomeById: row.outcomeById,
    outcomeAt: row.outcomeAt,
    createdAt: row.createdAt,
  };
}

/** `YYYY-MM-DD` → la columna DATE (Prisma la lleva como medianoche UTC). */
function dateColumn(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

@Injectable()
export class PrismaOpeningCandidatesRepository implements OpeningCandidatesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  listOpenEntries(params: {
    locationId: string;
    maxDurationMinutes: number;
  }): Promise<EntryCandidateRow[]> {
    return this.prisma.runWithTenant(async (tx) => {
      // Lo sirve appointment_waitlist_tenant_location_status_idx.
      const rows = await tx.appointmentWaitlistEntry.findMany({
        where: {
          locationId: params.locationId,
          status: WaitlistStatus.OPEN,
          durationMinutes: { lte: params.maxDurationMinutes },
          patient: { deletedAt: null },
        },
        include: {
          patient: { select: PATIENT_SELECT },
          appointmentType: TYPE_SELECT,
          sourceAppointment: { select: { start: true, end: true } },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: SOURCE_LIMIT,
      });
      return rows.map((r) => ({
        id: r.id,
        locationId: r.locationId,
        providerId: r.providerId,
        durationMinutes: r.durationMinutes,
        priority: r.priority,
        status: r.status,
        createdAt: r.createdAt,
        sourceAppointment: r.sourceAppointment,
        patient: r.patient,
        appointmentType: r.appointmentType,
        preferredWindow: r.preferredWindow,
        note: r.note,
      }));
    });
  }

  listWantsEarlier(params: {
    locationId: string;
    from: Date;
    providerId: string | null;
  }): Promise<AppointmentCandidateRow[]> {
    return this.prisma.runWithTenant(async (tx) => {
      // Lo sirve el parcial appointments_tenant_location_wants_earlier_idx.
      const rows = await tx.appointment.findMany({
        where: {
          locationId: params.locationId,
          wantsEarlier: true,
          deletedAt: null,
          status: { in: [...MOVABLE_STATUSES] },
          start: { gte: params.from },
          ...(params.providerId ? { providerId: params.providerId } : {}),
          patient: { deletedAt: null },
        },
        include: {
          patient: { select: PATIENT_SELECT },
          appointmentType: TYPE_SELECT,
        },
        orderBy: [{ start: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: SOURCE_LIMIT,
      });
      return rows.map((r) => ({
        id: r.id,
        locationId: r.locationId,
        providerId: r.providerId,
        start: r.start,
        end: r.end,
        status: r.status,
        wantsEarlier: r.wantsEarlier,
        createdAt: r.createdAt,
        patient: r.patient,
        appointmentType: r.appointmentType,
        reason: r.reason,
      }));
    });
  }

  async offersSummary(params: {
    patientIds: string[];
    offerDay: string;
    locationId: string;
    slotStart: Date;
    slotEnd: Date;
  }): Promise<Map<string, OfferSummary>> {
    const out = new Map<string, OfferSummary>();
    if (params.patientIds.length === 0) return out;
    const [today, forSlot] = await this.prisma.runWithTenant((tx) =>
      Promise.all([
        // waitlist_offers_tenant_patient_day_idx
        tx.waitlistOffer.groupBy({
          by: ['patientId'],
          where: {
            patientId: { in: params.patientIds },
            offerDay: dateColumn(params.offerDay),
          },
          _count: { _all: true },
        }),
        // waitlist_offers_tenant_location_slot_idx
        tx.waitlistOffer.findMany({
          where: {
            patientId: { in: params.patientIds },
            locationId: params.locationId,
            slotStart: { lt: params.slotEnd },
            slotEnd: { gt: params.slotStart },
          },
          select: { patientId: true },
          distinct: ['patientId'],
        }),
      ]),
    );
    for (const row of today) {
      out.set(row.patientId, { today: row._count._all, forSlot: false });
    }
    for (const row of forSlot) {
      const current = out.get(row.patientId) ?? { today: 0, forSlot: false };
      out.set(row.patientId, { ...current, forSlot: true });
    }
    return out;
  }

  patientContact(patientId: string): Promise<CandidatePatient | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: PATIENT_SELECT,
      }),
    );
  }

  entryTarget(id: string): Promise<OfferTarget | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.appointmentWaitlistEntry.findFirst({
        where: { id },
        select: { patientId: true, locationId: true, status: true },
      });
      return row
        ? {
            patientId: row.patientId,
            locationId: row.locationId,
            active: row.status === WaitlistStatus.OPEN,
          }
        : null;
    });
  }

  appointmentTarget(id: string): Promise<OfferTarget | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.appointment.findFirst({
        where: { id, deletedAt: null },
        select: {
          patientId: true,
          locationId: true,
          status: true,
          wantsEarlier: true,
        },
      });
      return row
        ? {
            patientId: row.patientId,
            locationId: row.locationId,
            active: row.wantsEarlier && MOVABLE_STATUSES.includes(row.status),
          }
        : null;
    });
  }

  async createOffer(
    input: CreateWaitlistOfferRepoInput,
    cap: number,
  ): Promise<{ offer: WaitlistOffer; offersToday: number } | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Candado de la transacción por paciente: dos ofertas simultáneas al
      // mismo paciente se cuentan una detrás de otra, así el tope no se cuela.
      const lockKey = `waitlist_offer:${tenantId}:${input.patientId}`;
      await tx.$queryRaw`
        SELECT 1 AS locked
          FROM (SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))) l`;
      const offerDay = dateColumn(input.offerDay);
      const today = await tx.waitlistOffer.count({
        where: { patientId: input.patientId, offerDay },
      });
      if (today >= cap) return null;
      const resolved = input.outcome !== 'PENDING';
      const row = await tx.waitlistOffer.create({
        data: {
          tenantId,
          locationId: input.locationId,
          slotStart: input.slotStart,
          slotEnd: input.slotEnd,
          providerId: input.providerId,
          patientId: input.patientId,
          waitlistEntryId: input.waitlistEntryId,
          appointmentId: input.appointmentId,
          channel: input.channel,
          outcome: input.outcome,
          offerDay,
          createdById: input.createdById,
          outcomeById: resolved ? input.createdById : null,
          outcomeAt: resolved ? new Date() : null,
        },
      });
      return { offer: mapOffer(row), offersToday: today + 1 };
    });
  }

  findOffer(id: string): Promise<WaitlistOffer | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.waitlistOffer.findFirst({ where: { id } });
      return row ? mapOffer(row) : null;
    });
  }

  recordOutcome(
    id: string,
    outcome: Exclude<WaitlistOfferOutcome, 'PENDING'>,
    byId: string,
  ): Promise<WaitlistOffer | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // Condicional: solo una oferta que sigue pendiente (a prueba de carreras).
      const { count } = await tx.waitlistOffer.updateMany({
        where: { id, outcome: 'PENDING' },
        data: { outcome, outcomeById: byId, outcomeAt: new Date() },
      });
      if (count === 0) return null;
      return mapOffer(
        await tx.waitlistOffer.findFirstOrThrow({ where: { id } }),
      );
    });
  }
}
