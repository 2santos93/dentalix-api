import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import { loadLocationTimeZones } from '../../../shared/locations/location-time-zone';
import { DEFAULT_BUSINESS_HOURS_TIMEZONE } from '../../../shared/locations/default-business-hours';
import {
  civilPeriodByZone,
  type ZonedPeriodBranch,
} from '../../../shared/time/civil-day';
import type { CivilPeriod } from '../domain/comparison-period';
import type { PeriodAggregates } from '../domain/kpi-definitions';
import {
  openMinutes,
  type Closure,
  type WeeklyRange,
} from '../domain/open-minutes';
import type {
  ComparisonLocation,
  LocationsComparisonRepository,
  PeriodAggregation,
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
  locationId: string;
  weekday: number | null;
  startMinute: number | null;
  endMinute: number | null;
}

interface ClosureRow extends Closure {
  locationId: string;
}

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
    openMinutes: null,
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
 *  - citas atendidas, no-show, cancelaciones tardías (DX-279), minutos y
 *    pacientes distintos (por sede y del
 *    conjunto con GROUPING SETS); `appointments_tenant_location_start_idx`;
 *  - pacientes nuevos: citas COMPLETED del período sin otra COMPLETED anterior
 *    del paciente en la clínica; `appointments_tenant_patient_completed_idx`;
 *  - horario semanal vivo de cada sede y sus cierres (bloqueos de toda la sede
 *    que no admiten citas), para los minutos abiertos.
 */
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
      const zones = await loadLocationTimeZones(
        tx,
        tenantId,
        rows.map((r) => r.id),
      );
      return rows.map((r) => ({
        ...r,
        timeZone: zones.get(r.id) ?? DEFAULT_BUSINESS_HOURS_TIMEZONE,
      }));
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
                   FILTER (WHERE a."status" = 'COMPLETED') AS "minutes",
                 count(DISTINCT a."patientId")
                   FILTER (WHERE a."status" = 'COMPLETED') AS "patients"
            FROM "appointments" a
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

        // Una fila por tramo vivo; una sede con horario y sin tramos (cerrada
        // toda la semana) sale una vez con el tramo a NULL.
        const schedules = await tx.$queryRaw<ScheduleRow[]>`
          SELECT s."locationId", r."weekday", r."startMinute", r."endMinute"
            FROM "location_schedules" s
            LEFT JOIN "location_schedule_ranges" r
              ON r."tenantId" = s."tenantId" AND r."scheduleId" = s."id"
             AND r."deletedAt" IS NULL
           WHERE s."tenantId" = ${tenantId}::uuid
             AND s."deletedAt" IS NULL
             AND s."locationId" = ANY(${ids}::uuid[])`;

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
        const weekly = new Map<string, WeeklyRange[]>();
        for (const r of schedules) {
          const list = weekly.get(r.locationId) ?? [];
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
          weekly.set(r.locationId, list);
        }
        for (const location of locations) {
          const ranges = weekly.get(location.id);
          const a = byLocation.get(location.id);
          // Sin horario configurado: sin restricción, y sin ocupación.
          if (!ranges || !a) continue;
          a.openMinutes = openMinutes({
            from: period.from,
            to: period.to,
            timeZone: location.timeZone,
            ranges,
            closures: closures.filter((c) => c.locationId === location.id),
          });
        }
        return { byLocation, attendedPatients };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
