import { Injectable } from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import {
  loadPeriodLocationZones,
  type LocationZones,
} from '../../../shared/locations/location-time-zone';
import { resolveReferenceLocation } from '../../../shared/locations/reference-location';
import {
  civilDateIn,
  civilPeriodByZone,
  civilRangeInZone,
  isValidTimeZone,
  type ZonedPeriodBranch,
} from '../../../shared/time/civil-day';
import type { CivilPeriod } from '../domain/comparison-period';
import {
  monthBounds,
  type ForecastAmountGroup,
  type ScheduledAmountGroup,
  type ScheduledAppointmentGroup,
} from '../domain/scheduled-production';
import type {
  ForecastAggregate,
  ForecastWindow,
  ScheduledAggregate,
  ScheduledProductionLocation,
  ScheduledProductionProfessional,
  ScheduledProductionRepository,
  ScheduledProductionScope,
  UnlinkedAppointmentRow,
} from '../domain/ports/scheduled-production-repository.port';
import { inPeriod, periodWindow, utcTimestamp } from './zoned-period-sql';

type Num = Prisma.Decimal | number | null;

const num = (value: Num): number =>
  value === null ? 0 : typeof value === 'number' ? value : value.toNumber();

interface ScheduledRow {
  kind: 'APPOINTMENTS' | 'AMOUNTS';
  day: string;
  professionalId: string;
  professionalName: string | null;
  locationId: string;
  currency: string | null;
  appointments: number;
  withoutItems: number;
  amount: Num;
  items: number;
  appointmentIds: string[] | null;
}

interface ForecastRow {
  day: string;
  locationId: string;
  currency: string;
  amount: Num;
  items: number;
}

interface UnlinkedSqlRow extends UnlinkedAppointmentRow {
  total: bigint;
}

/**
 * Las citas que cuentan (D1): vivas y ni canceladas ni inasistencias; también
 * las completadas y las vencidas sin cerrar. El paciente puede estar retirado.
 */
const ELIGIBLE = (alias: string) =>
  Prisma.raw(
    `${alias}."deletedAt" IS NULL AND ${alias}."status" NOT IN ('${AppointmentStatus.CANCELLED}', '${AppointmentStatus.NO_SHOW}')`,
  );

/**
 * El ítem `i` cuenta en la cita `a` (D1, sin doble conteo): ninguna OTRA cita
 * que cuenta con un vínculo vivo al mismo ítem empieza después (o a la misma
 * hora con un id mayor). Así cada ítem cae en UNA sola cita, la de inicio más
 * reciente, también fuera del período o del filtro: un ítem cuya cita vencida
 * no se cerró y que se reagendó cuenta en la nueva. Va por el índice
 * (tenantId, planItemId, appointmentId) de los vínculos y la PK de la cita.
 */
const COUNTS_HERE = (tenantId: Prisma.Sql) => Prisma.sql`NOT EXISTS (
  SELECT 1 FROM "appointment_plan_items" l2
    JOIN "appointments" a2
      ON a2."tenantId" = l2."tenantId" AND a2."id" = l2."appointmentId"
   WHERE l2."tenantId" = ${tenantId} AND l2."planItemId" = i."id"
     AND l2."deletedAt" IS NULL
     AND ${ELIGIBLE('a2')}
     AND (a2."start" > a."start" OR (a2."start" = a."start" AND a2."id" > a."id")))`;

/**
 * El paciente de la cita `a`, vivo o archivado (D1): las citas de un paciente
 * eliminado (o fusionado en otro) no cuentan ni se listan.
 */
const LIVE_PATIENT = Prisma.sql`
  JOIN "patients" pt
    ON pt."tenantId" = a."tenantId" AND pt."id" = a."patientId"
   AND pt."deletedAt" IS NULL`;

/** Los vínculos vivos de la cita `a` a ítems vivos de planes vivos. */
const LINKED_ITEMS = (tenantId: Prisma.Sql) => Prisma.sql`
  JOIN "appointment_plan_items" l
    ON l."tenantId" = ${tenantId} AND l."appointmentId" = a."id"
   AND l."deletedAt" IS NULL
  JOIN "treatment_plan_items" i
    ON i."tenantId" = ${tenantId} AND i."id" = l."planItemId"
   AND i."deletedAt" IS NULL
  JOIN "treatment_plans" p
    ON p."tenantId" = ${tenantId} AND p."id" = i."planId"
   AND p."deletedAt" IS NULL`;

/** El día civil (AAAA-MM-DD) de una columna `timestamp` UTC en la zona `zone`. */
const civilDay = (column: Prisma.Sql, zone: Prisma.Sql) =>
  Prisma.sql`to_char(((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${zone})::date, 'YYYY-MM-DD')`;

/**
 * Lecturas de la «Producción agendada y previsión del mes» (DX-567), con el
 * tenant explícito además de la RLS, en UNA transacción REPEATABLE READ por
 * lectura. Las citas del período salen de (tenantId, locationId, start) por
 * zona (DX-097); sus ítems, de la PK de los vínculos. La BD suma por (día,
 * profesional, sede, moneda): la conversión con la tasa del día la hace la
 * aplicación.
 */
@Injectable()
export class PrismaScheduledProductionRepository implements ScheduledProductionRepository {
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
  ): Promise<ScheduledProductionLocation[]> {
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

  /**
   * Los miembros vivos que atienden alguna cita viva en esas sedes: un
   * EXISTS por miembro sobre (tenantId, providerId, start), que para en la
   * primera.
   */
  async listProfessionals(
    locationIds: readonly string[],
  ): Promise<ScheduledProductionProfessional[]> {
    const tenantId = this.requireTenantId();
    const ids = [...locationIds];
    if (ids.length === 0) return [];
    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<ScheduledProductionProfessional[]>`
        SELECT DISTINCT m."userId", u."fullName"
          FROM "clinic_memberships" m
          JOIN "users" u ON u."id" = m."userId"
         WHERE m."tenantId" = ${tenantId}::uuid
           AND m."deletedAt" IS NULL
           AND EXISTS (
             SELECT 1 FROM "appointments" a
              WHERE a."tenantId" = m."tenantId"
                AND a."providerId" = m."userId"
                AND a."deletedAt" IS NULL
                AND a."locationId" = ANY(${ids}::uuid[]))`,
    );
    return rows.sort((a, b) =>
      a.fullName.localeCompare(b.fullName, 'es', { sensitivity: 'base' }),
    );
  }

  /**
   * Las zonas de las sedes del alcance. Una sede sin zona y sin citas ni
   * realizados se ignora; con ellos, 409 (G1).
   */
  private zones(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationIds: readonly string[],
  ): Promise<LocationZones> {
    return loadPeriodLocationZones(tx, tenantId, locationIds, async (ids) => {
      const appointment = await tx.appointment.findFirst({
        where: { tenantId, locationId: { in: ids } },
        select: { locationId: true },
      });
      if (appointment) return appointment.locationId;
      const done = await tx.treatmentPlanItem.findFirst({
        where: { tenantId, performedLocationId: { in: ids } },
        select: { performedLocationId: true },
      });
      return done?.performedLocationId;
    });
  }

  /** Las citas que cuentan con inicio en las ramas (y del profesional). */
  private appointmentsIn(
    t: Prisma.Sql,
    branches: readonly ZonedPeriodBranch[],
    professionalId: string | undefined,
  ): Prisma.Sql {
    const window = periodWindow(branches);
    return Prisma.sql`
      SELECT a."id", a."start", a."locationId", a."providerId",
             ${civilDay(Prisma.sql`a."start"`, Prisma.sql`lo."timeZone"`)} AS "day"
        FROM "appointments" a
        JOIN "locations" lo ON lo."tenantId" = a."tenantId" AND lo."id" = a."locationId"
        ${LIVE_PATIENT}
       WHERE a."tenantId" = ${t}
         AND ${ELIGIBLE('a')}
         AND a."start" >= ${utcTimestamp(window.start)}
         AND a."start" < ${utcTimestamp(window.end)}
         AND ${inPeriod(Prisma.sql`a."locationId"`, Prisma.sql`a."start"`, branches)}
         ${professionalId !== undefined ? Prisma.sql`AND a."providerId" = ${professionalId}::uuid` : Prisma.empty}`;
  }

  async scheduled(
    period: CivilPeriod,
    scope: ScheduledProductionScope,
  ): Promise<ScheduledAggregate> {
    const tenantId = this.requireTenantId();
    const empty = (): ScheduledAggregate => ({
      amounts: [],
      appointments: [],
      names: new Map(),
      zones: new Map(),
    });
    if (scope.locationIds.length === 0) return empty();
    return this.prisma.runWithTenant(
      async (tx) => {
        const zones = await this.zones(tx, tenantId, scope.locationIds);
        const branches = civilPeriodByZone(
          period.from,
          period.to,
          zones.configured,
        );
        if (branches.length === 0) return empty();
        const t = Prisma.sql`${tenantId}::uuid`;
        // Por cita (citas y sin tratamiento) y por (cita, moneda) lo que
        // cuenta en ella; después, por (día, profesional, sede[, moneda]).
        const rows = await tx.$queryRaw<ScheduledRow[]>`
          WITH "appts" AS MATERIALIZED (
            ${this.appointmentsIn(t, branches, scope.professionalId)}
          ),
          "lines" AS MATERIALIZED (
            SELECT a."id" AS "appointmentId", p."currency",
                   (i."price" - i."discount") AS "amount",
                   (i."status" IN ('ACCEPTED', 'DONE') AND ${COUNTS_HERE(t)}) AS "counts"
              FROM "appts" a
              ${LINKED_ITEMS(t)}
          ),
          "linked" AS (SELECT DISTINCT "appointmentId" FROM "lines")
          SELECT s.*, u."fullName" AS "professionalName"
            FROM (
              SELECT 'APPOINTMENTS' AS "kind", a."day", a."providerId" AS "professionalId",
                     a."locationId", NULL::text AS "currency",
                     count(*)::int AS "appointments",
                     (count(*) FILTER (WHERE k."appointmentId" IS NULL))::int AS "withoutItems",
                     NULL::numeric AS "amount", 0 AS "items",
                     NULL::uuid[] AS "appointmentIds"
                FROM "appts" a
                LEFT JOIN "linked" k ON k."appointmentId" = a."id"
               GROUP BY a."day", a."providerId", a."locationId"
              UNION ALL
              SELECT 'AMOUNTS', a."day", a."providerId", a."locationId",
                     x."currency"::text, 0, 0, sum(x."amount"), count(*)::int,
                     -- Las citas solo hacen falta si hay que convertir: para
                     -- contar las que quedan sin tasa.
                     CASE WHEN x."currency" = ${scope.currency} THEN NULL
                          ELSE array_agg(DISTINCT a."id") END
                FROM "lines" x
                JOIN "appts" a ON a."id" = x."appointmentId"
               WHERE x."counts"
               GROUP BY a."day", a."providerId", a."locationId", x."currency"
            ) s
            LEFT JOIN "users" u ON u."id" = s."professionalId"`;
        const amounts: ScheduledAmountGroup[] = [];
        const appointments: ScheduledAppointmentGroup[] = [];
        const names = new Map<string, string>();
        for (const row of rows) {
          if (row.professionalName) {
            names.set(row.professionalId, row.professionalName);
          }
          if (row.kind === 'APPOINTMENTS') {
            appointments.push({
              day: row.day,
              professionalId: row.professionalId,
              locationId: row.locationId,
              appointments: row.appointments,
              withoutItems: row.withoutItems,
            });
          } else {
            amounts.push({
              day: row.day,
              professionalId: row.professionalId,
              locationId: row.locationId,
              currency: row.currency ?? '',
              amount: num(row.amount),
              items: row.items,
              appointmentIds: row.appointmentIds ?? [],
            });
          }
        }
        return {
          amounts,
          appointments,
          names,
          zones: new Map(zones.configured),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * Hoy y el mes en curso de cada zona del alcance, y la sede de referencia:
   * la elegida o, si no, la principal (R6; si no tiene zona válida, la primera
   * sede del alcance).
   */
  private async window(
    tx: Prisma.TransactionClient,
    tenantId: string,
    now: Date,
    zones: LocationZones,
    referenceLocationId: string | null,
  ): Promise<ForecastWindow> {
    const byZone = new Map<string, string[]>();
    for (const [locationId, timeZone] of zones.configured) {
      byZone.set(timeZone, [...(byZone.get(timeZone) ?? []), locationId]);
    }
    const windows = [...byZone.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([timeZone, locationIds]) => {
        const today = civilDateIn(now, timeZone);
        const { first, last } = monthBounds(today);
        return {
          timeZone,
          locationIds: [...locationIds].sort(),
          today,
          monthFirst: first,
          monthLast: last,
        };
      });
    let referenceZone: string;
    if (referenceLocationId !== null) {
      referenceZone = zones.zoneOf(referenceLocationId);
    } else {
      const principal = await tx.location.findFirst({
        where: { tenantId, deletedAt: null, isActive: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { timeZone: true },
      });
      if (principal?.timeZone && isValidTimeZone(principal.timeZone)) {
        referenceZone = principal.timeZone;
      } else if (windows.length > 0) {
        referenceZone = windows[0].timeZone;
      } else {
        // Sin principal ni sedes con zona: el 409 de la regla (R6).
        referenceZone = (await resolveReferenceLocation(tx, tenantId, null))
          .timeZone;
      }
    }
    return {
      zones: windows,
      reference: {
        timeZone: referenceZone,
        today: civilDateIn(now, referenceZone),
      },
    };
  }

  async forecast(
    now: Date,
    scope: ScheduledProductionScope,
    referenceLocationId: string | null,
  ): Promise<ForecastAggregate> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(
      async (tx) => {
        const zones =
          scope.locationIds.length > 0
            ? await this.zones(tx, tenantId, scope.locationIds)
            : await loadPeriodLocationZones(tx, tenantId, [], () =>
                Promise.resolve(null),
              );
        const window = await this.window(
          tx,
          tenantId,
          now,
          zones,
          referenceLocationId,
        );
        const t = Prisma.sql`${tenantId}::uuid`;
        const branches = (
          range: (w: ForecastWindow['zones'][number]) => [string, string],
        ): ZonedPeriodBranch[] =>
          window.zones.map((w) => {
            const [from, to] = range(w);
            return {
              timeZone: w.timeZone,
              locationIds: w.locationIds,
              ...civilRangeInZone(from, to, w.timeZone),
            };
          });
        // Producido: del día 1 a hoy (incluido). Pendiente: de hoy a fin de mes.
        const producedBranches = branches((w) => [w.monthFirst, w.today]);
        const pendingBranches = branches((w) => [w.today, w.monthLast]);
        const professional = (column: Prisma.Sql) =>
          scope.professionalId !== undefined
            ? Prisma.sql`AND ${column} = ${scope.professionalId}::uuid`
            : Prisma.empty;
        const doneItem = Prisma.sql`i."tenantId" = ${t}
             AND i."status" = 'DONE'
             AND i."deletedAt" IS NULL
             AND p."deletedAt" IS NULL
             ${professional(Prisma.sql`i."performedById"`)}`;

        let produced: ForecastRow[] = [];
        let pending: ForecastRow[] = [];
        if (producedBranches.length > 0) {
          const w = periodWindow(producedBranches);
          // Los DONE del mes salen del índice parcial (tenantId, completedAt)
          // de DX-014; el día, el de la realización en la zona de su sede.
          produced = await tx.$queryRaw<ForecastRow[]>`
            SELECT ${civilDay(Prisma.sql`i."completedAt"`, Prisma.sql`lo."timeZone"`)} AS "day",
                   i."performedLocationId" AS "locationId", p."currency"::text AS "currency",
                   sum(i."price" - i."discount") AS "amount", count(*)::int AS "items"
              FROM "treatment_plan_items" i
              JOIN "treatment_plans" p
                ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
              JOIN "locations" lo
                ON lo."tenantId" = i."tenantId" AND lo."id" = i."performedLocationId"
             WHERE ${doneItem}
               AND i."completedAt" >= ${utcTimestamp(w.start)}
               AND i."completedAt" < ${utcTimestamp(w.end)}
               AND ${inPeriod(Prisma.sql`i."performedLocationId"`, Prisma.sql`i."completedAt"`, producedBranches)}
             GROUP BY 1, 2, 3`;
          // Pendiente: los ACCEPTED (aún no hechos) que cuentan en citas de
          // hoy a fin de mes; lo DONE hoy ya está en lo producido.
          pending = await tx.$queryRaw<ForecastRow[]>`
            WITH "appts" AS MATERIALIZED (
              ${this.appointmentsIn(t, pendingBranches, scope.professionalId)}
            )
            SELECT a."day", a."locationId", p."currency"::text AS "currency",
                   sum(i."price" - i."discount") AS "amount", count(*)::int AS "items"
              FROM "appts" a
              ${LINKED_ITEMS(t)}
             WHERE i."status" = 'ACCEPTED'
               AND ${COUNTS_HERE(t)}
             GROUP BY 1, 2, 3`;
        }

        // Realizados sin atribuir (pre DX-050): sin fecha en las sedes que
        // se ven (o sin sede, si se ven todas) y, con fecha del mes, sin sede.
        const ids = [...scope.locationIds];
        const visible = scope.includeWithoutLocation
          ? Prisma.sql`(i."performedLocationId" IS NULL OR i."performedLocationId" = ANY(${ids}::uuid[]))`
          : Prisma.sql`i."performedLocationId" = ANY(${ids}::uuid[])`;
        const monthWindow =
          producedBranches.length > 0 ? periodWindow(producedBranches) : null;
        const withoutLocation =
          scope.includeWithoutLocation && monthWindow
            ? Prisma.sql`OR (i."performedLocationId" IS NULL
                   AND i."completedAt" >= ${utcTimestamp(monthWindow.start)}
                   AND i."completedAt" < ${utcTimestamp(monthWindow.end)})`
            : Prisma.empty;
        let unattributedDone = 0;
        if (ids.length > 0 || scope.includeWithoutLocation) {
          const [row] = await tx.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS "count"
              FROM "treatment_plan_items" i
              JOIN "treatment_plans" p
                ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
             WHERE ${doneItem}
               AND ((i."completedAt" IS NULL AND ${visible}) ${withoutLocation})`;
          unattributedDone = row?.count ?? 0;
        }
        const groups = (rows: ForecastRow[]): ForecastAmountGroup[] =>
          rows.map((r) => ({
            day: r.day,
            locationId: r.locationId,
            currency: r.currency,
            amount: num(r.amount),
            items: r.items,
          }));
        return {
          window,
          produced: groups(produced),
          pending: groups(pending),
          unattributedDone,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async listUnlinked(
    period: CivilPeriod,
    scope: ScheduledProductionScope,
    page: { skip: number; take: number },
  ): Promise<{ items: UnlinkedAppointmentRow[]; total: number }> {
    const tenantId = this.requireTenantId();
    if (scope.locationIds.length === 0) return { items: [], total: 0 };
    return this.prisma.runWithTenant(
      async (tx) => {
        const zones = await this.zones(tx, tenantId, scope.locationIds);
        const branches = civilPeriodByZone(
          period.from,
          period.to,
          zones.configured,
        );
        if (branches.length === 0) return { items: [], total: 0 };
        const t = Prisma.sql`${tenantId}::uuid`;
        const window = periodWindow(branches);
        const select = (paging: Prisma.Sql) => tx.$queryRaw<UnlinkedSqlRow[]>`
          SELECT a."id" AS "appointmentId", a."start", a."end", a."status",
                 pt."id" AS "patientId",
                 btrim(pt."firstName" || ' ' || pt."lastName") AS "patientName",
                 ty."name" AS "appointmentTypeName",
                 a."providerId" AS "professionalId", u."fullName" AS "professionalName",
                 a."locationId", lo."name" AS "locationName", lo."timeZone",
                 count(*) OVER () AS "total"
            FROM "appointments" a
            JOIN "locations" lo ON lo."tenantId" = a."tenantId" AND lo."id" = a."locationId"
            ${LIVE_PATIENT}
            LEFT JOIN "appointment_types" ty
              ON ty."tenantId" = a."tenantId" AND ty."id" = a."appointmentTypeId"
            LEFT JOIN "users" u ON u."id" = a."providerId"
           WHERE a."tenantId" = ${t}
             AND ${ELIGIBLE('a')}
             AND a."start" >= ${utcTimestamp(window.start)}
             AND a."start" < ${utcTimestamp(window.end)}
             AND ${inPeriod(Prisma.sql`a."locationId"`, Prisma.sql`a."start"`, branches)}
             ${scope.professionalId !== undefined ? Prisma.sql`AND a."providerId" = ${scope.professionalId}::uuid` : Prisma.empty}
             -- Sin ningún vínculo vivo a un ítem vivo de un plan vivo (D2):
             -- da igual el estado del ítem.
             AND NOT EXISTS (
               SELECT 1 FROM "appointment_plan_items" l
                 JOIN "treatment_plan_items" i
                   ON i."tenantId" = l."tenantId" AND i."id" = l."planItemId"
                  AND i."deletedAt" IS NULL
                 JOIN "treatment_plans" p
                   ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
                  AND p."deletedAt" IS NULL
                WHERE l."tenantId" = ${t} AND l."appointmentId" = a."id"
                  AND l."deletedAt" IS NULL)
           ORDER BY a."start", a."id"
           ${paging}`;
        const rows = await select(
          Prisma.sql`OFFSET ${page.skip} LIMIT ${page.take}`,
        );
        let total = rows.length > 0 ? Number(rows[0].total) : 0;
        if (rows.length === 0 && page.skip > 0) {
          // Página pasada del final: el total sale de la primera fila.
          const [first] = await select(Prisma.sql`LIMIT 1`);
          total = first ? Number(first.total) : 0;
        }
        return {
          total,
          items: rows.map((r) => ({
            appointmentId: r.appointmentId,
            start: r.start,
            end: r.end,
            status: r.status,
            patientId: r.patientId,
            patientName: r.patientName,
            appointmentTypeName: r.appointmentTypeName,
            professionalId: r.professionalId,
            professionalName: r.professionalName,
            locationId: r.locationId,
            locationName: r.locationName,
            timeZone: r.timeZone,
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
