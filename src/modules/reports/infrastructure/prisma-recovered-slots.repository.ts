import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import {
  firstLocationWithRows,
  loadPeriodLocationZones,
} from '../../../shared/locations/location-time-zone';
import {
  civilPeriodByZone,
  type ZonedPeriodBranch,
} from '../../../shared/time/civil-day';
import type { CivilPeriod } from '../domain/comparison-period';
import {
  FREED_MIN_NOTICE_MINUTES,
  offerBucket,
  type AppointmentDayCount,
  type FillCandidate,
  type FreedSlot,
  type MoneyAmount,
  type OfferDayCount,
} from '../domain/recovered-slots';
import type {
  RecoveredSlotsData,
  RecoveredSlotsRepository,
  RecoveredSlotsScope,
} from '../domain/ports/recovered-slots-repository.port';
import { inPeriod, periodWindow, utcTimestamp } from './zoned-period-sql';

interface SlotRow {
  id: string;
  locationId: string;
  providerId: string;
  start: Date;
  end: Date;
  freedAt: Date;
  timeZone: string;
}

interface CandidateRow {
  slotId: string;
  appointmentId: string;
  locationId: string;
  providerId: string;
  start: Date;
  end: Date;
  arrivedAt: Date;
  byList: boolean;
}

interface ValueRow {
  appointmentId: string;
  currency: string;
  amount: Prisma.Decimal;
}

interface CountRow {
  providerId: string;
  day: string;
  scheduled: bigint;
  cancelled: bigint;
}

interface OfferRow {
  providerId: string;
  day: string;
  outcome: string;
  count: bigint;
}

/**
 * Una cita puede tardar como mucho esto: acota por abajo la búsqueda de citas
 * que se solapan con un hueco en el índice (tenantId, providerId, start).
 */
const MAX_APPOINTMENT_SPAN = Prisma.sql`interval '24 hours'`;

/** Un instante ISO del rastro de auditoría (`metadata.move`) como `timestamp` UTC. */
const movePath = (path: string) => Prisma.raw(`'{move,${path}}'::text[]`);
const moveInstant = (path: string) =>
  Prisma.sql`((e."metadata"#>>${movePath(path)})::timestamptz AT TIME ZONE 'UTC')`;

/** ¿El lado `side` (from/to) de un movimiento ocupa el hueco `f`? */
const moveInSlot = (side: 'from' | 'to') => Prisma.sql`(
  (e."metadata"#>>${movePath(`${side},providerId`)})::uuid = f."providerId"
  AND ${moveInstant(`${side},start`)} < f."end"
  AND ${moveInstant(`${side},end`)} > f."start")`;

/** Día civil de un instante (`timestamp` UTC) en la zona de la sede `l`. */
const localDay = (instant: Prisma.Sql) =>
  Prisma.sql`(((${instant}) AT TIME ZONE 'UTC') AT TIME ZONE l."timeZone")::date::text`;

@Injectable()
export class PrismaRecoveredSlotsRepository implements RecoveredSlotsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async listLocationIds(allowed: AllowedLocations): Promise<string[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.location.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(allowed === 'ALL' ? {} : { id: { in: [...allowed] } }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      }),
    );
    return rows.map((r) => r.id);
  }

  async locationInClinic(locationId: string): Promise<boolean> {
    const tenantId = this.requireTenantId();
    const found = await this.prisma.runWithTenant((tx) =>
      tx.location.findFirst({
        where: { tenantId, id: locationId, deletedAt: null },
        select: { id: true },
      }),
    );
    return found !== null;
  }

  async load(
    period: CivilPeriod,
    scope: RecoveredSlotsScope,
  ): Promise<RecoveredSlotsData> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(
      async (tx) => {
        const zones = await loadPeriodLocationZones(
          tx,
          tenantId,
          scope.locationIds,
          firstLocationWithRows(tx.appointment, tenantId),
        );
        const branches = civilPeriodByZone(
          period.from,
          period.to,
          zones.configured,
        );
        if (branches.length === 0) {
          return {
            slots: [],
            candidates: [],
            values: new Map(),
            counts: [],
            offers: [],
            providers: [],
          };
        }
        const slots = await this.slots(tx, tenantId, branches, scope);
        const candidates =
          slots.length === 0
            ? []
            : await this.candidates(tx, tenantId, branches, scope);
        const [values, counts, offers] = await Promise.all([
          this.values(tx, tenantId, [
            ...new Set(candidates.map((c) => c.appointmentId)),
          ]),
          this.counts(tx, tenantId, branches, scope),
          this.offers(tx, tenantId, branches, scope),
        ]);
        const providerIds = [
          ...new Set([
            ...slots.map((s) => s.providerId),
            ...counts.map((c) => c.providerId),
            ...offers.map((o) => o.providerId),
          ]),
        ];
        const providers =
          providerIds.length === 0
            ? []
            : await tx.$queryRaw<
                { providerId: string; providerName: string }[]
              >`
              SELECT u."id" AS "providerId", u."fullName" AS "providerName"
                FROM "users" u
               WHERE u."id" = ANY(${providerIds}::uuid[])`;
        return { slots, candidates, values, counts, offers, providers };
      },
      // Todas las lecturas ven la MISMA foto: los huecos, sus rellenos y los
      // conteos cuadran entre sí.
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * Las citas vivas de las sedes y el período (inicio en días civiles de la
   * zona de cada sede), y opcionalmente de un profesional. `a` es la cita.
   */
  private appointmentsInPeriod(
    tenantId: string,
    branches: readonly ZonedPeriodBranch[],
    scope: RecoveredSlotsScope,
  ): Prisma.Sql {
    const window = periodWindow(branches);
    return Prisma.sql`a."tenantId" = ${tenantId}::uuid
       AND a."deletedAt" IS NULL
       AND a."start" >= ${utcTimestamp(window.start)}
       AND a."start" < ${utcTimestamp(window.end)}
       AND ${inPeriod(Prisma.sql`a."locationId"`, Prisma.sql`a."start"`, branches)}
       ${scope.providerId !== undefined ? Prisma.sql`AND a."providerId" = ${scope.providerId}::uuid` : Prisma.empty}`;
  }

  /** Huecos liberados: cancelación o inasistencia con ≥ 1 h de aviso. */
  private freedSql(
    tenantId: string,
    branches: readonly ZonedPeriodBranch[],
    scope: RecoveredSlotsScope,
  ): Prisma.Sql {
    const notice = Prisma.sql`make_interval(mins => ${FREED_MIN_NOTICE_MINUTES}::int)`;
    return Prisma.sql`
      SELECT a."id", a."tenantId", a."locationId", a."providerId", a."start", a."end",
             CASE WHEN a."status" = 'CANCELLED' THEN a."cancelledAt"
                  ELSE a."noShowMarkedAt" END AS "freedAt"
        FROM "appointments" a
       WHERE ${this.appointmentsInPeriod(tenantId, branches, scope)}
         AND ((a."status" = 'CANCELLED' AND a."cancelledAt" IS NOT NULL
               AND a."cancelledAt" <= a."start" - ${notice})
           OR (a."status" = 'NO_SHOW' AND a."noShowMarkedAt" IS NOT NULL
               AND a."noShowMarkedAt" <= a."start" - ${notice}))`;
  }

  private async slots(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branches: readonly ZonedPeriodBranch[],
    scope: RecoveredSlotsScope,
  ): Promise<FreedSlot[]> {
    const rows = await tx.$queryRaw<SlotRow[]>`
      SELECT f."id", f."locationId", f."providerId", f."start", f."end",
             f."freedAt", l."timeZone"
        FROM (${this.freedSql(tenantId, branches, scope)}) f
        JOIN "locations" l ON l."tenantId" = f."tenantId" AND l."id" = f."locationId"`;
    return rows;
  }

  /**
   * Cada par hueco ↔ cita viva no cancelada del mismo profesional y sede que
   * se solapa con él, con cuándo LLEGÓ la cita a su hora: su creación o, si
   * se creó antes de liberarse el hueco, el último movimiento (rastro de
   * auditoría, DX-121/DX-435) que la metió en el hueco después de liberarse y
   * antes de que terminara. Y si nació de la lista: de un pendiente
   * (`resolvedAppointmentId`, DX-122) o de una oferta ACEPTADA de ese hueco
   * (DX-210/DX-435).
   */
  private async candidates(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branches: readonly ZonedPeriodBranch[],
    scope: RecoveredSlotsScope,
  ): Promise<FillCandidate[]> {
    const rows = await tx.$queryRaw<CandidateRow[]>`
      WITH f AS (${this.freedSql(tenantId, branches, scope)})
      SELECT f."id" AS "slotId", c."id" AS "appointmentId", c."locationId",
             c."providerId", c."start", c."end",
             GREATEST(c."createdAt", m."movedAt") AS "arrivedAt",
             (EXISTS (
                SELECT 1 FROM "appointment_waitlist" w
                 WHERE w."tenantId" = c."tenantId"
                   AND w."resolvedAppointmentId" = c."id")
              OR EXISTS (
                SELECT 1 FROM "waitlist_offers" o
                 WHERE o."tenantId" = c."tenantId"
                   AND o."appointmentId" = c."id"
                   AND o."outcome" = 'ACCEPTED'
                   AND o."providerId" = f."providerId"
                   AND o."slotStart" < f."end"
                   AND o."slotEnd" > f."start")
              -- DX-436-bis: «Asignar» desde «Ocupar este hueco» (una cita
              -- «quiere antes» movida al hueco por PATCH /appointments/:id/opening).
              OR COALESCE(m."viaOpening", FALSE)) AS "byList"
        FROM f
        JOIN "appointments" c
          ON c."tenantId" = f."tenantId"
         AND c."providerId" = f."providerId"
         AND c."start" < f."end"
         AND c."start" > f."start" - ${MAX_APPOINTMENT_SPAN}
         AND c."end" > f."start"
         AND c."locationId" = f."locationId"
         AND c."id" <> f."id"
         AND c."deletedAt" IS NULL
         AND c."status" <> 'CANCELLED'
        LEFT JOIN LATERAL (
          SELECT max(e."occurredAt") AS "movedAt",
                 bool_or(e."metadata"#>>'{move,via}' = 'OPENING') AS "viaOpening"
            FROM "audit_events" e
           WHERE c."createdAt" <= f."freedAt"
             AND e."tenantId" = f."tenantId"
             AND e."resourceType" = 'APPOINTMENT'
             AND e."occurredAt" > f."freedAt"
             AND e."occurredAt" < f."end"
             AND e."resourceId" = c."id"
             AND e."metadata" ? 'move'
             AND ${moveInSlot('to')}
             AND NOT ${moveInSlot('from')}
        ) m ON TRUE`;
    return rows;
  }

  /** Valor de cada cita: ítems del plan ligados (vivos, de planes vivos). */
  private async values(
    tx: Prisma.TransactionClient,
    tenantId: string,
    appointmentIds: string[],
  ): Promise<Map<string, MoneyAmount[]>> {
    const out = new Map<string, MoneyAmount[]>();
    if (appointmentIds.length === 0) return out;
    const rows = await tx.$queryRaw<ValueRow[]>`
      SELECT link."appointmentId", p."currency",
             sum(i."price" - i."discount") AS "amount"
        FROM "appointment_plan_items" link
        JOIN "treatment_plan_items" i
          ON i."tenantId" = link."tenantId" AND i."id" = link."planItemId"
        JOIN "treatment_plans" p
          ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
       WHERE link."tenantId" = ${tenantId}::uuid
         AND link."appointmentId" = ANY(${appointmentIds}::uuid[])
         AND link."deletedAt" IS NULL
         AND i."deletedAt" IS NULL
         AND p."deletedAt" IS NULL
       GROUP BY 1, 2`;
    for (const r of rows) {
      const list = out.get(r.appointmentId) ?? [];
      list.push({ currency: r.currency, amount: r.amount.toNumber() });
      out.set(r.appointmentId, list);
    }
    return out;
  }

  /** Citas agendadas y canceladas por profesional y día civil de la sede. */
  private async counts(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branches: readonly ZonedPeriodBranch[],
    scope: RecoveredSlotsScope,
  ): Promise<AppointmentDayCount[]> {
    const rows = await tx.$queryRaw<CountRow[]>`
      SELECT a."providerId", ${localDay(Prisma.sql`a."start"`)} AS "day",
             count(*) AS "scheduled",
             count(*) FILTER (WHERE a."status" = 'CANCELLED') AS "cancelled"
        FROM "appointments" a
        JOIN "locations" l ON l."tenantId" = a."tenantId" AND l."id" = a."locationId"
       WHERE ${this.appointmentsInPeriod(tenantId, branches, scope)}
       GROUP BY 1, 2`;
    return rows.map((r) => ({
      providerId: r.providerId,
      day: r.day,
      scheduled: Number(r.scheduled),
      cancelled: Number(r.cancelled),
    }));
  }

  /**
   * Ofertas de los huecos del período (por el inicio del hueco ofrecido, en
   * la zona de su sede), por profesional, día y desenlace.
   */
  private async offers(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branches: readonly ZonedPeriodBranch[],
    scope: RecoveredSlotsScope,
  ): Promise<OfferDayCount[]> {
    const window = periodWindow(branches);
    const rows = await tx.$queryRaw<OfferRow[]>`
      SELECT o."providerId", ${localDay(Prisma.sql`o."slotStart"`)} AS "day",
             o."outcome"::text AS "outcome", count(*) AS "count"
        FROM "waitlist_offers" o
        JOIN "locations" l ON l."tenantId" = o."tenantId" AND l."id" = o."locationId"
       WHERE o."tenantId" = ${tenantId}::uuid
         AND o."slotStart" >= ${utcTimestamp(window.start)}
         AND o."slotStart" < ${utcTimestamp(window.end)}
         AND ${inPeriod(Prisma.sql`o."locationId"`, Prisma.sql`o."slotStart"`, branches)}
         ${scope.providerId !== undefined ? Prisma.sql`AND o."providerId" = ${scope.providerId}::uuid` : Prisma.empty}
       GROUP BY 1, 2, 3`;
    // Varios desenlaces caen en el mismo grupo («sin respuesta»): se suman.
    const merged = new Map<string, OfferDayCount>();
    for (const r of rows) {
      const outcome = offerBucket(r.outcome);
      const key = `${r.providerId}|${r.day}|${outcome}`;
      const prev = merged.get(key);
      merged.set(key, {
        providerId: r.providerId,
        day: r.day,
        outcome,
        count: (prev?.count ?? 0) + Number(r.count),
      });
    }
    return [...merged.values()];
  }
}
