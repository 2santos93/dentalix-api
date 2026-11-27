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
import type { Closure, DayRange, WeeklyRange } from '../domain/open-minutes';
import type { OccupancyHoliday } from '../domain/chair-occupancy';
import {
  TIMING_THRESHOLDS,
  type BookedMinutes,
  type ProviderLocationCapacity,
  type TimingThresholds,
} from '../domain/timing';
import type {
  TimingAppointmentType,
  TimingData,
  TimingGroupRow,
  TimingGroupSet,
  TimingLocation,
  TimingProfessionalOption,
  TimingRepository,
  TimingScope,
} from '../domain/ports/timing-repository.port';
import { inPeriod, periodWindow, utcTimestamp } from './zoned-period-sql';
import { attendingSchedule } from './attending-schedule-sql';

/** Lo que necesitan las dos consultas de citas (exportadas para la carga). */
export interface TimingSqlParams {
  tenantId: string;
  branches: readonly ZonedPeriodBranch[];
  providerId?: string;
  thresholds?: TimingThresholds;
}

interface GroupSqlRow {
  grouping: number;
  providerId: string | null;
  appointmentTypeId: string | null;
  weekStart: string | null;
  completed: number;
  measured: number;
  withoutTimes: number;
  incoherent: number;
  waitAvg: number | null;
  waitP90: number | null;
  startDelayAvg: number | null;
  startDelayP90: number | null;
  durationAvg: number | null;
  durationP90: number | null;
  plannedAvg: number | null;
}

interface BookedSqlRow {
  providerId: string;
  weekStart: string;
  booked: number;
  attended: number;
  noShow: number;
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

interface HolidayRow extends OccupancyHoliday {
  locationId: string;
}

/**
 * GROUPING(profesional, tipo, semana): el bit a 1 es la columna que NO
 * agrupa la fila.
 */
const SET_OF_GROUPING: Record<number, TimingGroupSet> = {
  3: 'PROFESSIONAL',
  5: 'TYPE',
  6: 'WEEK',
  7: 'TOTAL',
};

const byProvider = (providerId?: string) =>
  providerId !== undefined
    ? Prisma.sql`AND a."providerId" = ${providerId}::uuid`
    : Prisma.empty;

/** Las citas del período en esas sedes (índice tenant, sede, inicio). */
function periodFilter(params: TimingSqlParams): Prisma.Sql {
  const window = periodWindow(params.branches);
  return Prisma.sql`a."tenantId" = ${params.tenantId}::uuid
     AND a."deletedAt" IS NULL
     AND a."start" >= ${utcTimestamp(window.start)}
     AND a."start" < ${utcTimestamp(window.end)}
     AND ${inPeriod(Prisma.sql`a."locationId"`, Prisma.sql`a."start"`, params.branches)}
     ${byProvider(params.providerId)}`;
}

/**
 * El lunes de la semana del inicio en la zona de la sede, con un CASE por
 * rama de zona (la zona es constante en cada rama): sin JOIN a las sedes,
 * que convertía la pasada por el índice en un bucle por sede.
 */
function weekStart(branches: readonly ZonedPeriodBranch[]): Prisma.Sql {
  return Prisma.sql`(CASE ${Prisma.join(
    branches.map(
      (b) =>
        Prisma.sql`WHEN a."locationId" = ANY(${b.locationIds}::uuid[]) THEN date_trunc('week', timezone(${b.timeZone}, a."start" AT TIME ZONE 'UTC'))::date`,
    ),
    ' ',
  )} END)`;
}

/**
 * `work_mem` de la transacción del informe (`set_config` local: solo en ella): los
 * GROUPING SETS y `percentile_cont` ordenan las citas del período en
 * memoria (un año de una clínica grande, ~100.000 filas, pide ~15 MB; con
 * los 4 MB por defecto irían a disco). La prueba de carga lo usa igual.
 */
export const TIMING_WORK_MEM = '32MB';
export const TIMING_SESSION_SQL = Prisma.sql`SELECT set_config('work_mem', ${TIMING_WORK_MEM}, true)`;

/**
 * Tiempos de las citas ATENDIDAS del período, en UNA pasada por el índice
 * (tenantId, locationId, start) y agregados con GROUPING SETS: por
 * profesional, por tipo de cita, por semana y el total. Cada cita se
 * clasifica con la regla de `classifyTiming` (mismos umbrales):
 * 1 = sin tiempos, 2 = incoherente, 0 = medida. Medias y p90
 * (`percentile_cont`) solo de las medidas.
 */
export function timingGroupsSql(params: TimingSqlParams): Prisma.Sql {
  const t = params.thresholds ?? TIMING_THRESHOLDS;
  return Prisma.sql`
    WITH c AS (
      SELECT a."providerId" AS "providerId",
             a."appointmentTypeId" AS "appointmentTypeId",
             ${weekStart(params.branches)} AS "weekStart",
             a."arrivedAt" IS NULL OR a."seatedAt" IS NULL
               OR a."readyForCheckoutAt" IS NULL AS "missing",
             (extract(epoch FROM a."seatedAt" - greatest(a."arrivedAt", a."start")) / 60)::float8 AS "rawWait",
             (extract(epoch FROM a."seatedAt" - a."start") / 60)::float8 AS "delay",
             (extract(epoch FROM a."readyForCheckoutAt" - a."seatedAt") / 60)::float8 AS "duration",
             (extract(epoch FROM a."end" - a."start") / 60)::float8 AS "planned",
             a."seatedAt" < a."arrivedAt"
               OR a."readyForCheckoutAt" < a."seatedAt" AS "outOfOrder"
        FROM "appointments" a
       WHERE ${periodFilter(params)}
         AND a."status" = 'COMPLETED'
    ),
    k AS (
      SELECT c."providerId", c."appointmentTypeId", c."weekStart",
             c."planned", c."delay", c."duration",
             greatest(c."rawWait", 0) AS "wait",
             CASE
               WHEN c."missing" THEN 1
               WHEN c."outOfOrder"
                 OR c."rawWait" > ${t.maxWaitMinutes}
                 OR abs(c."delay") > ${t.maxStartGapMinutes}
                 OR c."duration" < ${t.minDurationMinutes}
                 OR c."duration" > ${t.maxDurationMinutes} THEN 2
               ELSE 0
             END AS "kind"
        FROM c
    )
    SELECT GROUPING(k."providerId", k."appointmentTypeId", k."weekStart")::int AS "grouping",
           k."providerId", k."appointmentTypeId",
           to_char(k."weekStart", 'YYYY-MM-DD') AS "weekStart",
           count(*)::int AS "completed",
           count(*) FILTER (WHERE k."kind" = 0)::int AS "measured",
           count(*) FILTER (WHERE k."kind" = 1)::int AS "withoutTimes",
           count(*) FILTER (WHERE k."kind" = 2)::int AS "incoherent",
           avg(k."wait") FILTER (WHERE k."kind" = 0) AS "waitAvg",
           percentile_cont(0.9) WITHIN GROUP (ORDER BY k."wait") FILTER (WHERE k."kind" = 0) AS "waitP90",
           avg(k."delay") FILTER (WHERE k."kind" = 0) AS "startDelayAvg",
           percentile_cont(0.9) WITHIN GROUP (ORDER BY k."delay") FILTER (WHERE k."kind" = 0) AS "startDelayP90",
           avg(k."duration") FILTER (WHERE k."kind" = 0) AS "durationAvg",
           percentile_cont(0.9) WITHIN GROUP (ORDER BY k."duration") FILTER (WHERE k."kind" = 0) AS "durationP90",
           avg(k."planned") FILTER (WHERE k."kind" = 0) AS "plannedAvg"
      FROM k
     GROUP BY GROUPING SETS ((k."providerId"), (k."appointmentTypeId"), (k."weekStart"), ())`;
}

/**
 * Minutos de agenda por profesional y semana (zona de la sede): citas vivas
 * no canceladas (citadas), las atendidas y las «No asistió», por su
 * duración programada. Misma pasada por (tenantId, locationId, start).
 */
export function bookedMinutesSql(params: TimingSqlParams): Prisma.Sql {
  return Prisma.sql`
    SELECT a."providerId",
           to_char(${weekStart(params.branches)}, 'YYYY-MM-DD') AS "weekStart",
           (sum(extract(epoch FROM a."end" - a."start")) / 60)::float8 AS "booked",
           (coalesce(sum(extract(epoch FROM a."end" - a."start"))
              FILTER (WHERE a."status" = 'COMPLETED'), 0) / 60)::float8 AS "attended",
           (coalesce(sum(extract(epoch FROM a."end" - a."start"))
              FILTER (WHERE a."status" = 'NO_SHOW'), 0) / 60)::float8 AS "noShow"
      FROM "appointments" a
     WHERE ${periodFilter(params)}
       AND a."status" <> 'CANCELLED'
     GROUP BY 1, 2`;
}

/** `sede|profesional`. */
const key = (locationId: string, providerId: string) =>
  `${locationId}|${providerId}`;

/**
 * «Tiempos» (DX-275). Con el tenant explícito además de la RLS y en UNA
 * transacción REPEATABLE READ (citas, horarios, bloqueos y festivos ven la
 * misma foto):
 *  - tiempos: `timingGroupsSql` (una pasada, GROUPING SETS);
 *  - agenda: `bookedMinutesSql`;
 *  - capacidad: horarios vivos de profesionales que atienden en la sede
 *    (`attendingSchedule`, el roster de «Comparar sedes»), sus excepciones
 *    del período (DX-233), sus bloqueos y los cierres de la sede que no
 *    admiten citas (DX-122) y los festivos de la sede (DX-316).
 * Sin pacientes: ni ids ni nombres salen de aquí.
 */
@Injectable()
export class PrismaTimingRepository implements TimingRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
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

  async listLocations(allowed: AllowedLocations): Promise<TimingLocation[]> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant((tx) =>
      tx.location.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(allowed === 'ALL' ? {} : { id: { in: [...allowed] } }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, isActive: true },
      }),
    );
  }

  async listProfessionals(
    locationIds: readonly string[],
  ): Promise<TimingProfessionalOption[]> {
    const tenantId = this.requireTenantId();
    const ids = [...locationIds];
    if (ids.length === 0) return [];
    // Por las membresías (también retiradas) con dos EXISTS que paran en la
    // primera fila: (tenantId, providerId, start) de las citas y los
    // horarios por profesional.
    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<TimingProfessionalOption[]>`
        SELECT DISTINCT m."userId", u."fullName"
          FROM "clinic_memberships" m
          JOIN "users" u ON u."id" = m."userId"
         WHERE m."tenantId" = ${tenantId}::uuid
           AND (EXISTS (
                  SELECT 1 FROM "appointments" a
                   WHERE a."tenantId" = m."tenantId"
                     AND a."providerId" = m."userId"
                     AND a."deletedAt" IS NULL
                     AND a."locationId" = ANY(${ids}::uuid[]))
                OR EXISTS (
                  SELECT 1 FROM "provider_schedules" s
                   WHERE s."tenantId" = m."tenantId"
                     AND s."providerId" = m."userId"
                     AND s."deletedAt" IS NULL
                     AND s."locationId" = ANY(${ids}::uuid[])))`,
    );
    const unique = new Map(rows.map((r) => [r.userId, r]));
    return [...unique.values()].sort((a, b) =>
      a.fullName.localeCompare(b.fullName, 'es', { sensitivity: 'base' }),
    );
  }

  async load(period: CivilPeriod, scope: TimingScope): Promise<TimingData> {
    const tenantId = this.requireTenantId();
    const empty: TimingData = {
      groups: [],
      booked: [],
      capacities: [],
      names: new Map(),
      types: new Map(),
    };
    if (scope.locationIds.length === 0) return empty;
    return this.prisma.runWithTenant(
      async (tx) => {
        // Una sede sin zona y sin citas se ignora; con citas, 409 (G1).
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
        if (branches.length === 0) return empty;
        const ids = scope.locationIds.filter((id) => zones.configured.has(id));
        const window = periodWindow(branches);
        const params: TimingSqlParams = {
          tenantId,
          branches,
          ...(scope.providerId !== undefined
            ? { providerId: scope.providerId }
            : {}),
        };

        await tx.$queryRaw(TIMING_SESSION_SQL);
        const groups = await tx.$queryRaw<GroupSqlRow[]>(
          timingGroupsSql(params),
        );
        const booked = await tx.$queryRaw<BookedSqlRow[]>(
          bookedMinutesSql(params),
        );

        // Una fila por tramo vivo de cada profesional en cada sede; un
        // horario sin tramos sale una vez con el tramo a NULL.
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
             ${scope.providerId !== undefined ? Prisma.sql`AND s."providerId" = ${scope.providerId}::uuid` : Prisma.empty}
             AND ${attendingSchedule}`;
        const providerIds = [...new Set(schedules.map((r) => r.providerId))];

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

        const closures =
          providerIds.length === 0
            ? []
            : await tx.$queryRaw<ClosureRow[]>`
          SELECT b."locationId", b."start", b."end"
            FROM "schedule_blocks" b
           WHERE b."tenantId" = ${tenantId}::uuid
             AND b."deletedAt" IS NULL
             AND b."providerId" IS NULL
             AND b."allowsBooking" = false
             AND b."locationId" = ANY(${ids}::uuid[])
             AND b."end" > ${utcTimestamp(window.start)}
             AND b."start" < ${utcTimestamp(window.end)}`;

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
             AND b."end" > ${utcTimestamp(window.start)}
             AND b."start" < ${utcTimestamp(window.end)}`;

        const holidays =
          providerIds.length === 0
            ? []
            : await tx.$queryRaw<HolidayRow[]>`
          SELECT h."locationId", to_char(h."date", 'YYYY-MM-DD') AS "date",
                 h."recurring"
            FROM "location_holidays" h
           WHERE h."tenantId" = ${tenantId}::uuid
             AND h."deletedAt" IS NULL
             AND h."locationId" = ANY(${ids}::uuid[])
             AND (h."recurring"
                  OR (h."date" >= ${period.from}::date
                      AND h."date" <= ${period.to}::date))`;

        const userIds = [
          ...new Set([
            ...groups.flatMap((g) => (g.providerId ? [g.providerId] : [])),
            ...booked.map((b) => b.providerId),
            ...providerIds,
          ]),
        ];
        const users =
          userIds.length === 0
            ? []
            : await tx.$queryRaw<{ id: string; fullName: string }[]>`
          SELECT u."id", u."fullName" FROM "users" u
           WHERE u."id" = ANY(${userIds}::uuid[])`;

        const typeIds = [
          ...new Set(
            groups.flatMap((g) =>
              g.appointmentTypeId ? [g.appointmentTypeId] : [],
            ),
          ),
        ];
        const types =
          typeIds.length === 0
            ? []
            : await tx.appointmentType.findMany({
                where: { tenantId, id: { in: typeIds } },
                select: { id: true, name: true, durationMinutes: true },
              });

        return {
          groups: groups.flatMap((g): TimingGroupRow[] => {
            const set = SET_OF_GROUPING[g.grouping];
            if (!set) return [];
            return [
              {
                set,
                providerId: set === 'PROFESSIONAL' ? g.providerId : null,
                appointmentTypeId: set === 'TYPE' ? g.appointmentTypeId : null,
                weekStart: set === 'WEEK' ? g.weekStart : null,
                completed: g.completed,
                measured: g.measured,
                withoutTimes: g.withoutTimes,
                incoherent: g.incoherent,
                waitAvg: g.waitAvg,
                waitP90: g.waitP90,
                startDelayAvg: g.startDelayAvg,
                startDelayP90: g.startDelayP90,
                durationAvg: g.durationAvg,
                durationP90: g.durationP90,
                plannedAvg: g.plannedAvg,
              },
            ];
          }),
          booked: booked.map((b): BookedMinutes => ({
            providerId: b.providerId,
            weekStart: b.weekStart,
            booked: b.booked,
            attended: b.attended,
            noShow: b.noShow,
          })),
          capacities: capacitiesOf(
            schedules,
            overrides,
            providerBlocks,
            closures,
            holidays,
            (id) => zones.zoneOf(id),
          ),
          names: new Map(users.map((u) => [u.id, u.fullName])),
          types: new Map(
            types.map((ty): [string, TimingAppointmentType] => [
              ty.id,
              { name: ty.name, durationMinutes: ty.durationMinutes },
            ]),
          ),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

/** Un elemento por horario (profesional × sede), con lo que lo recorta. */
function capacitiesOf(
  schedules: readonly ScheduleRow[],
  overrides: readonly OverrideRow[],
  providerBlocks: readonly ProviderBlockRow[],
  closures: readonly ClosureRow[],
  holidays: readonly HolidayRow[],
  zoneOf: (locationId: string) => string,
): ProviderLocationCapacity[] {
  const weekly = new Map<string, WeeklyRange[]>();
  for (const r of schedules) {
    const k = key(r.locationId, r.providerId);
    const list = weekly.get(k) ?? [];
    if (r.weekday !== null && r.startMinute !== null && r.endMinute !== null) {
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
  return [...weekly].map(([k, ranges]) => {
    const [locationId, providerId] = k.split('|');
    return {
      providerId,
      locationId,
      timeZone: zoneOf(locationId),
      ranges,
      overrides: dayOverrides.get(k) ?? new Map(),
      blocks: providerBlocks
        .filter(
          (b) =>
            b.providerId === providerId &&
            (b.locationId === null || b.locationId === locationId),
        )
        .map((b) => ({ start: b.start, end: b.end })),
      closures: closures
        .filter((c) => c.locationId === locationId)
        .map((c) => ({ start: c.start, end: c.end })),
      holidays: holidays
        .filter((h) => h.locationId === locationId)
        .map((h) => ({ date: h.date, recurring: h.recurring })),
    };
  });
}
