import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import { loadPeriodLocationZones } from '../../../shared/locations/location-time-zone';
import {
  civilPeriodByZone,
  type ZonedPeriodBranch,
} from '../../../shared/time/civil-day';
import type { CivilPeriod } from '../domain/comparison-period';
import type { PeriodAggregates } from '../domain/kpi-definitions';
import {
  capacityMinutes,
  type Closure,
  type DayRange,
  type ProviderCapacity,
  type WeeklyRange,
} from '../domain/open-minutes';
import type {
  ComparisonLocation,
  LocationsComparisonRepository,
  PeriodAggregation,
  ProductionAttribution,
} from '../domain/ports/locations-comparison-repository.port';

interface AmountRow {
  locationId: string;
  currency: string;
  amount: Prisma.Decimal;
}

interface AppointmentRow {
  /** NULL = la fila del conjunto (GROUPING SETS). */
  locationId: string | null;
  completed: bigint;
  noShow: bigint;
  lateCancellations: bigint;
  minutes: Prisma.Decimal | null;
  patients: bigint;
}

interface CountRow {
  locationId: string;
  count: bigint;
}

interface ScheduleRow {
  providerId: string;
  locationId: string;
  weekday: number | null;
  startMinute: number | null;
  endMinute: number | null;
}

interface OverrideRow {
  providerId: string;
  locationId: string;
  date: string;
  startMinute: number | null;
  endMinute: number | null;
}

interface ClosureRow extends Closure {
  locationId: string;
}

interface ProviderBlockRow extends Closure {
  providerId: string;
  /** NULL = el profesional en todas las sedes. */
  locationId: string | null;
}

/**
 * ¿El horario `s` (fila de `provider_schedules`) es capacidad? Solo si su
 * profesional sigue en el equipo (membresía y usuario vivos), atiende
 * (DENTIST o ADMIN, `ATTENDING_ROLES`) y puede atender en ESA sede (DX-089:
 * ADMIN o sin sedes asignadas = todas; si no, una de las suyas). Es el mismo
 * roster que la pantalla de horarios: el horario de quien se desactivó o dejó
 * de atender allí sigue vivo en la tabla, pero nadie lo ve ni lo puede retirar.
 */
const attendingSchedule = Prisma.sql`EXISTS (
  SELECT 1
    FROM "clinic_memberships" m
    JOIN "users" u ON u."id" = m."userId" AND u."deletedAt" IS NULL
   WHERE m."tenantId" = s."tenantId"
     AND m."userId" = s."providerId"
     AND m."deletedAt" IS NULL
     AND m."role" IN ('DENTIST', 'ADMIN')
     AND (m."role" = 'ADMIN'
          OR NOT EXISTS (
            SELECT 1 FROM "membership_locations" ml
             WHERE ml."tenantId" = m."tenantId" AND ml."membershipId" = m."id")
          OR EXISTS (
            SELECT 1 FROM "membership_locations" ml
             WHERE ml."tenantId" = m."tenantId" AND ml."membershipId" = m."id"
               AND ml."locationId" = s."locationId"))
)`;

/** `sede|profesional`: clave de un horario de profesional en una sede. */
const key = (locationId: string, providerId: string) =>
  `${locationId}|${providerId}`;

/**
 * `(sede IN (…) AND instante en [inicio, fin))`, una rama por ZONA (DX-097):
 * cada sede corta sus días a la medianoche de su zona, y la consulta sigue
 * pudiendo usar el índice (tenantId, sede, instante). Sin sedes, FALSE.
 */
function inPeriod(
  location: Prisma.Sql,
  instant: Prisma.Sql,
  branches: readonly ZonedPeriodBranch[],
): Prisma.Sql {
  if (branches.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`(${Prisma.join(
    branches.map(
      (b) =>
        Prisma.sql`(${location} = ANY(${b.locationIds}::uuid[]) AND ${instant} >= ${b.start} AND ${instant} < ${b.end})`,
    ),
    ' OR ',
  )})`;
}

function emptyAggregates(): PeriodAggregates & {
  production: Map<string, number>;
  collected: Map<string, number>;
} {
  return {
    production: new Map(),
    collected: new Map(),
    completed: 0,
    noShow: 0,
    lateCancellations: 0,
    attendedPatients: 0,
    newPatients: 0,
    completedMinutes: 0,
    capacityMinutes: null,
  };
}

/**
 * Sumas de «Comparar sedes» (DX-014). Cada fuente es UNA consulta agregada por
 * período (GROUP BY sede), con el tenant explícito además de la RLS, dentro de
 * una transacción REPEATABLE READ para que todas vean la misma foto:
 *  - producción: ítems DONE con `completedAt` (DX-050) en el período, por la
 *    sede donde se realizaron (`performedLocationId`) y la moneda del plan;
 *    índice `treatment_plan_items_tenant_performed_location_idx`;
 *  - cobrado: abonos no anulados por `paidAt`, sede y moneda;
 *    `payments_tenantId_locationId_paidAt_active_idx`;
 *  - citas atendidas, no-show, cancelaciones tardías (DX-279), minutos de
 *    las atendidas por profesionales con horario en la sede y pacientes
 *    distintos (por sede y del conjunto con GROUPING SETS);
 *    `appointments_tenant_location_start_idx`;
 *  - pacientes nuevos: citas COMPLETED del período sin otra COMPLETED anterior
 *    del paciente en la clínica; `appointments_tenant_patient_completed_idx`;
 *  - capacidad (BE-042): horario semanal vivo de cada profesional del equipo
 *    que atiende en cada sede (DX-233, DX-089; `attendingSchedule`), sus
 *    excepciones del período, sus bloqueos que no admiten citas (DX-122) y
 *    los cierres de toda la sede.
 */
/**
 * La primera de `locationIds` con algo que el informe compara (citas, abonos,
 * ítems realizados u horarios de profesionales), o null.
 */
async function firstComparedLocation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationIds: string[],
): Promise<string | null> {
  const [found] = await tx.$queryRaw<{ locationId: string }[]>`
    SELECT x."locationId" FROM (
      SELECT a."locationId" FROM "appointments" a
       WHERE a."tenantId" = ${tenantId}::uuid
         AND a."locationId" = ANY(${locationIds}::uuid[])
      UNION ALL
      SELECT pay."locationId" FROM "payments" pay
       WHERE pay."tenantId" = ${tenantId}::uuid
         AND pay."locationId" = ANY(${locationIds}::uuid[])
      UNION ALL
      SELECT i."performedLocationId" FROM "treatment_plan_items" i
       WHERE i."tenantId" = ${tenantId}::uuid
         AND i."performedLocationId" = ANY(${locationIds}::uuid[])
      UNION ALL
      SELECT s."locationId" FROM "provider_schedules" s
       WHERE s."tenantId" = ${tenantId}::uuid
         AND s."locationId" = ANY(${locationIds}::uuid[])
    ) x
    LIMIT 1`;
  return found?.locationId ?? null;
}

@Injectable()
export class PrismaLocationsComparisonRepository implements LocationsComparisonRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async listLocations(
    allowed: AllowedLocations,
  ): Promise<ComparisonLocation[]> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.location.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(allowed === 'ALL' ? {} : { id: { in: [...allowed] } }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, isActive: true },
      });
      const zones = await loadPeriodLocationZones(
        tx,
        tenantId,
        rows.map((r) => r.id),
        (ids) => firstComparedLocation(tx, tenantId, ids),
      );
      // Una sede sin zona y sin actividad no entra en la comparación (G1).
      return rows
        .filter((r) => zones.configured.has(r.id))
        .map((r) => ({ ...r, timeZone: zones.zoneOf(r.id) }));
    });
  }

  async aggregate(
    period: CivilPeriod,
    locations: readonly ComparisonLocation[],
    currency?: string,
  ): Promise<PeriodAggregation> {
    const tenantId = this.requireTenantId();
    if (locations.length === 0) {
      return { byLocation: new Map(), attendedPatients: 0 };
    }
    const ids = locations.map((l) => l.id);
    const branches = civilPeriodByZone(
      period.from,
      period.to,
      new Map(locations.map((l) => [l.id, l.timeZone])),
    );
    const windowStart = new Date(
      Math.min(...branches.map((b) => b.start.getTime())),
    );
    const windowEnd = new Date(
      Math.max(...branches.map((b) => b.end.getTime())),
    );
    const planCurrency = currency
      ? Prisma.sql`AND p."currency" = ${currency}`
      : Prisma.empty;
    const paymentCurrency = currency
      ? Prisma.sql`AND pay."currency" = ${currency}`
      : Prisma.empty;

    return this.prisma.runWithTenant(
      async (tx) => {
        const production = await tx.$queryRaw<AmountRow[]>`
          SELECT i."performedLocationId" AS "locationId", p."currency",
                 sum(i."price" - i."discount") AS "amount"
            FROM "treatment_plan_items" i
            JOIN "treatment_plans" p
              ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
           WHERE i."tenantId" = ${tenantId}::uuid
             AND i."status" = 'DONE'
             AND i."deletedAt" IS NULL
             AND p."deletedAt" IS NULL
             AND i."performedLocationId" = ANY(${ids}::uuid[])
             AND i."completedAt" >= ${windowStart}
             AND i."completedAt" < ${windowEnd}
             AND ${inPeriod(Prisma.sql`i."performedLocationId"`, Prisma.sql`i."completedAt"`, branches)}
             ${planCurrency}
           GROUP BY 1, 2`;

        const collected = await tx.$queryRaw<AmountRow[]>`
          SELECT pay."locationId", pay."currency", sum(pay."amount") AS "amount"
            FROM "payments" pay
           WHERE pay."tenantId" = ${tenantId}::uuid
             AND pay."deletedAt" IS NULL
             AND ${inPeriod(Prisma.sql`pay."locationId"`, Prisma.sql`pay."paidAt"`, branches)}
             ${paymentCurrency}
           GROUP BY 1, 2`;

        const appointments = await tx.$queryRaw<AppointmentRow[]>`
          SELECT a."locationId",
                 count(*) FILTER (WHERE a."status" = 'COMPLETED') AS "completed",
                 count(*) FILTER (WHERE a."status" = 'NO_SHOW') AS "noShow",
                 count(*) FILTER (WHERE a."status" = 'CANCELLED') AS "lateCancellations",
                 sum(extract(epoch FROM a."end" - a."start") / 60)
                   FILTER (WHERE a."status" = 'COMPLETED' AND s."id" IS NOT NULL) AS "minutes",
                 count(DISTINCT a."patientId")
                   FILTER (WHERE a."status" = 'COMPLETED') AS "patients"
            FROM "appointments" a
            -- Como mucho un horario vivo por profesional y sede (único
            -- parcial provider_schedules_live_key): no duplica citas.
            -- Solo los horarios que son capacidad (mismo filtro abajo).
            LEFT JOIN "provider_schedules" s
              ON s."tenantId" = a."tenantId"
             AND s."providerId" = a."providerId"
             AND s."locationId" = a."locationId"
             AND s."deletedAt" IS NULL
             AND ${attendingSchedule}
           WHERE a."tenantId" = ${tenantId}::uuid
             AND a."deletedAt" IS NULL
             AND (a."status" IN ('COMPLETED', 'NO_SHOW')
                  OR (a."status" = 'CANCELLED' AND a."lateCancellation" IS TRUE))
             AND ${inPeriod(Prisma.sql`a."locationId"`, Prisma.sql`a."start"`, branches)}
           GROUP BY GROUPING SETS ((a."locationId"), ())`;

        const newPatients = await tx.$queryRaw<CountRow[]>`
          SELECT a."locationId", count(*) AS "count"
            FROM "appointments" a
           WHERE a."tenantId" = ${tenantId}::uuid
             AND a."deletedAt" IS NULL
             AND a."status" = 'COMPLETED'
             AND ${inPeriod(Prisma.sql`a."locationId"`, Prisma.sql`a."start"`, branches)}
             AND NOT EXISTS (
               SELECT 1
                 FROM "appointments" e
                WHERE e."tenantId" = a."tenantId"
                  AND e."patientId" = a."patientId"
                  AND e."status" = 'COMPLETED'
                  AND e."deletedAt" IS NULL
                  AND (e."start" < a."start" OR (e."start" = a."start" AND e."id" < a."id"))
             )
           GROUP BY 1`;

        // Una fila por tramo vivo de cada profesional en cada sede; un
        // horario sin tramos (no trabaja allí ningún día) sale una vez con el
        // tramo a NULL y no aporta capacidad.
        const schedules = await tx.$queryRaw<ScheduleRow[]>`
          SELECT s."providerId", s."locationId",
                 r."weekday", r."startMinute", r."endMinute"
            FROM "provider_schedules" s
            LEFT JOIN "provider_schedule_ranges" r
              ON r."tenantId" = s."tenantId" AND r."scheduleId" = s."id"
             AND r."providerId" = s."providerId" AND r."deletedAt" IS NULL
           WHERE s."tenantId" = ${tenantId}::uuid
             AND s."deletedAt" IS NULL
             AND s."locationId" = ANY(${ids}::uuid[])
             AND ${attendingSchedule}`;
        const providerIds = [...new Set(schedules.map((r) => r.providerId))];

        // Excepciones del período en esas sedes (DX-233); sin tramos = ese
        // día no trabaja allí.
        const overrides =
          providerIds.length === 0
            ? []
            : await tx.$queryRaw<OverrideRow[]>`
          SELECT o."providerId", o."locationId",
                 to_char(o."date", 'YYYY-MM-DD') AS "date",
                 r."startMinute", r."endMinute"
            FROM "provider_schedule_overrides" o
            LEFT JOIN "provider_schedule_override_ranges" r
              ON r."tenantId" = o."tenantId" AND r."overrideId" = o."id"
             AND r."deletedAt" IS NULL
           WHERE o."tenantId" = ${tenantId}::uuid
             AND o."deletedAt" IS NULL
             AND o."locationId" = ANY(${ids}::uuid[])
             AND o."providerId" = ANY(${providerIds}::uuid[])
             AND o."date" >= ${period.from}::date
             AND o."date" <= ${period.to}::date`;

        const closures = await tx.$queryRaw<ClosureRow[]>`
          SELECT b."locationId", b."start", b."end"
            FROM "schedule_blocks" b
           WHERE b."tenantId" = ${tenantId}::uuid
             AND b."deletedAt" IS NULL
             AND b."providerId" IS NULL
             AND b."allowsBooking" = false
             AND b."locationId" = ANY(${ids}::uuid[])
             AND b."end" > ${windowStart}
             AND b."start" < ${windowEnd}`;

        // Bloqueos de esos profesionales (en esa sede o en todas) que no
        // admiten citas: vacaciones, formación… (DX-122).
        const providerBlocks =
          providerIds.length === 0
            ? []
            : await tx.$queryRaw<ProviderBlockRow[]>`
          SELECT b."providerId", b."locationId", b."start", b."end"
            FROM "schedule_blocks" b
           WHERE b."tenantId" = ${tenantId}::uuid
             AND b."deletedAt" IS NULL
             AND b."providerId" = ANY(${providerIds}::uuid[])
             AND b."allowsBooking" = false
             AND (b."locationId" IS NULL OR b."locationId" = ANY(${ids}::uuid[]))
             AND b."end" > ${windowStart}
             AND b."start" < ${windowEnd}`;

        const byLocation = new Map(ids.map((id) => [id, emptyAggregates()]));
        for (const r of production) {
          byLocation
            .get(r.locationId)
            ?.production.set(r.currency, r.amount.toNumber());
        }
        for (const r of collected) {
          byLocation
            .get(r.locationId)
            ?.collected.set(r.currency, r.amount.toNumber());
        }
        let attendedPatients = 0;
        for (const r of appointments) {
          if (r.locationId === null) {
            attendedPatients = Number(r.patients);
            continue;
          }
          const a = byLocation.get(r.locationId);
          if (!a) continue;
          a.completed = Number(r.completed);
          a.noShow = Number(r.noShow);
          a.lateCancellations = Number(r.lateCancellations);
          a.completedMinutes = Math.round(r.minutes?.toNumber() ?? 0);
          a.attendedPatients = Number(r.patients);
        }
        for (const r of newPatients) {
          const a = byLocation.get(r.locationId);
          if (a) a.newPatients = Number(r.count);
        }
        // Horario de cada profesional en cada sede: tramos semanales y
        // excepciones por día.
        const weekly = new Map<string, WeeklyRange[]>();
        for (const r of schedules) {
          const k = key(r.locationId, r.providerId);
          const list = weekly.get(k) ?? [];
          if (
            r.weekday !== null &&
            r.startMinute !== null &&
            r.endMinute !== null
          ) {
            list.push({
              weekday: r.weekday,
              startMinute: r.startMinute,
              endMinute: r.endMinute,
            });
          }
          weekly.set(k, list);
        }
        const dayOverrides = new Map<string, Map<string, DayRange[]>>();
        for (const r of overrides) {
          const k = key(r.locationId, r.providerId);
          const byDay = dayOverrides.get(k) ?? new Map<string, DayRange[]>();
          const ranges = byDay.get(r.date) ?? [];
          if (r.startMinute !== null && r.endMinute !== null) {
            ranges.push({ startMinute: r.startMinute, endMinute: r.endMinute });
          }
          byDay.set(r.date, ranges);
          dayOverrides.set(k, byDay);
        }
        for (const location of locations) {
          const a = byLocation.get(location.id);
          if (!a) continue;
          const providers: ProviderCapacity[] = [];
          for (const [k, ranges] of weekly) {
            const [locationId, providerId] = k.split('|');
            if (locationId !== location.id) continue;
            providers.push({
              ranges,
              overrides: dayOverrides.get(k) ?? new Map(),
              blocks: providerBlocks.filter(
                (b) =>
                  b.providerId === providerId &&
                  (b.locationId === null || b.locationId === location.id),
              ),
            });
          }
          // Sin profesionales con horario en la sede: sin ocupación.
          a.capacityMinutes = capacityMinutes({
            from: period.from,
            to: period.to,
            timeZone: location.timeZone,
            providers,
            closures: closures.filter((c) => c.locationId === location.id),
          });
        }
        return { byLocation, attendedPatients };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * BE-045: el instante desde el que esta base registra la producción
   * atribuible (lo fija la migración de DX-305 con el fin de la de DX-050) y
   * si la clínica tiene realizados vivos sin sede o sin fecha («Sin
   * atribuir»), los que la producción no cuenta. El EXISTS para en el primero; `treatment_plan_items_tenant_done_completed_idx`
   * (parcial sobre DONE vivos, con la sede en el INCLUDE) lo sirve.
   */
  async productionAttribution(): Promise<ProductionAttribution> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const [row] = await tx.$queryRaw<
        { attributedSince: Date; hasUnattributed: boolean }[]
      >`
        SELECT public."dx_production_attributed_since"() AS "attributedSince",
               EXISTS (
                 SELECT 1
                   FROM "treatment_plan_items" i
                   JOIN "treatment_plans" p
                     ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
                  WHERE i."tenantId" = ${tenantId}::uuid
                    AND i."status" = 'DONE'
                    AND i."deletedAt" IS NULL
                    AND p."deletedAt" IS NULL
                    AND (i."completedAt" IS NULL OR i."performedLocationId" IS NULL)
               ) AS "hasUnattributed"`;
      return row;
    });
  }
}
