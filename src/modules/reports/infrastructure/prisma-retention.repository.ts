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
  NEW_NO_RETURN_DAYS,
  type RetentionBounds,
  type RetentionSegment,
} from '../domain/retention';
import type {
  RetentionFactsGroup,
  RetentionLocation,
  RetentionLocationBounds,
  RetentionPatientRow,
  RetentionProfessionalOption,
  RetentionQuery,
  RetentionRepository,
} from '../domain/ports/retention-repository.port';
import { utcTimestamp } from './zoned-period-sql';

export interface RetentionSqlParams extends RetentionQuery {
  tenantId: string;
}

/** Los hechos de `f` que decide cada lista (las reglas de `domain/retention.ts`). */
const IS_NEW = Prisma.sql`(f."seenInPeriod" AND NOT f."seenBefore")`;
const SEGMENT_SQL: Record<RetentionSegment, Prisma.Sql> = {
  active_start: Prisma.sql`f."activeAtStart"`,
  new: IS_NEW,
  lost: Prisma.sql`(f."activeAtStart" AND NOT f."activeWindowAtEnd" AND NOT f."upcoming")`,
  active_end: Prisma.sql`(f."activeWindowAtEnd" OR (f."activeAtStart" AND f."upcoming"))`,
  reactivated: Prisma.sql`(f."seenInPeriod" AND f."seenBefore" AND NOT f."activeAtStart")`,
  new_no_return: Prisma.sql`(${IS_NEW} AND NOT f."returnedWithinDays" AND NOT f."upcoming")`,
};

/**
 * Cita futura agendada del paciente `patient`: el predicado del índice
 * parcial appointments_tenant_patient_upcoming_idx, literal (Postgres no lo
 * deduce del OR y sin él no usa el índice), como la lista de recall.
 */
function upcomingExists(
  tenantId: string,
  patient: Prisma.Sql,
  now: Date,
): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "appointments" u
     WHERE u."tenantId" = ${tenantId}::uuid
       AND u."patientId" = ${patient}
       AND u."deletedAt" IS NULL
       AND u."status" IN ('SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')
       AND (
         (u."status" IN ('SCHEDULED', 'CONFIRMED') AND u."start" > ${utcTimestamp(now)})
         OR u."status" IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')
       ))`;
}

/** Las sedes con los mismos cortes (las de una misma zona), juntas. */
function boundsByZone(
  bounds: readonly RetentionLocationBounds[],
): { locationIds: string[]; bounds: RetentionBounds }[] {
  const byKey = new Map<
    string,
    { locationIds: string[]; bounds: RetentionBounds }
  >();
  for (const b of bounds) {
    const key = [b.periodStart, b.periodEnd, b.startCutoff, b.endCutoff]
      .map((d) => d.toISOString())
      .join('|');
    const zone = byKey.get(key) ?? { locationIds: [], bounds: b };
    zone.locationIds.push(b.locationId);
    byKey.set(key, zone);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, zone]) => ({ ...zone, locationIds: zone.locationIds.sort() }));
}

/**
 * DX-260 · Los hechos de retención de cada paciente, en CTEs (`f` al final),
 * sin consultas por fila salvo dos sondas por índice acotadas a quien las
 * necesita:
 *  1. `p`: UNA pasada por las citas atendidas vivas hasta el último instante
 *     del período, en el orden del índice parcial
 *     appointments_tenant_patient_completed_provider_idx (DX-260: el de
 *     DX-145 con el profesional en el INCLUDE): solo índice y sin ordenar.
 *     Por paciente, la sede y el profesional de la última, la primera visita
 *     y los cortes por los que pasó. Solo quien tiene alguna en la ventana
 *     más antigua (el resto no entra en ninguna cifra).
 *  2. `s`: los atribuidos a las sedes (y profesional) pedidos, vivos y sin
 *     historia suprimida (DX-039).
 *  3. `f`: la cita futura agendada solo para quien puede perderse o es
 *     nuevo (appointments_tenant_patient_upcoming_idx) y la vuelta en 90
 *     días solo para los nuevos (el índice de atendidas).
 */
export function retentionFactsCtes(p: RetentionSqlParams): Prisma.Sql {
  const zones = boundsByZone(p.bounds);
  const maxEnd = new Date(
    Math.max(...p.bounds.map((x) => x.periodEnd.getTime())),
  );
  /*
   * El corte de la sede de cada cita, sin JOIN: un hash join no conserva el
   * orden del índice y Postgres ordenaría las ~500k citas (en disco) antes
   * del GROUP BY. Con una sola zona (lo normal) es una constante; con
   * varias, un CASE simple por sede: igualdades de uuid, baratas aunque
   * Postgres las repita en cada agregado al aplanar la subconsulta `c` (un
   * `= ANY($n)` deshace el array en cada comparación y duplicaba el tiempo).
   * Una sede que no está (sin zona, nunca con citas: 409 al cargar) da NULL
   * y su cita no entra.
   */
  const cut = (field: keyof RetentionBounds) =>
    zones.length === 1
      ? utcTimestamp(zones[0].bounds[field])
      : Prisma.sql`(CASE a."locationId" ${Prisma.join(
          p.bounds.map(
            (b) =>
              Prisma.sql`WHEN ${b.locationId}::uuid THEN ${utcTimestamp(b[field])}`,
          ),
          ' ',
        )} END)`;
  const lapsed = Prisma.sql`(s."activeAtStart" AND NOT s."activeWindowAtEnd")`;
  const isNew = Prisma.sql`(s."seenInPeriod" AND NOT s."seenBefore")`;
  return Prisma.sql`
    WITH p AS MATERIALIZED (
      SELECT c."patientId",
             (array_agg(c."locationId" ORDER BY c."start" DESC, c."id" DESC))[1] AS "locationId",
             (array_agg(c."providerId" ORDER BY c."start" DESC, c."id" DESC))[1] AS "providerId",
             min(c."start") AS "firstAt",
             max(c."start") AS "lastAt",
             bool_or(c."start" < c."startAt") AS "seenBefore",
             bool_or(c."start" >= c."startAt") AS "seenInPeriod",
             bool_or(c."start" >= c."startCut" AND c."start" < c."startAt") AS "activeAtStart",
             bool_or(c."start" >= c."endCut") AS "activeWindowAtEnd"
        FROM (
          SELECT a."patientId", a."start", a."id", a."locationId", a."providerId",
                 ${cut('periodStart')} AS "startAt",
                 ${cut('periodEnd')} AS "endAt",
                 ${cut('startCutoff')} AS "startCut",
                 ${cut('endCutoff')} AS "endCut"
            FROM "appointments" a
           WHERE a."tenantId" = ${p.tenantId}::uuid
             AND a."status" = 'COMPLETED'
             AND a."deletedAt" IS NULL
             AND a."start" < ${utcTimestamp(maxEnd)}
           -- El orden del índice, explícito: sin él la subconsulta lo da por
           -- inútil y el GROUP BY de fuera volvería a ordenar.
           ORDER BY a."patientId", a."start" DESC, a."id" DESC
        ) c
       WHERE c."start" < c."endAt"
       GROUP BY c."patientId"
      HAVING bool_or(c."start" >= c."startCut")
    ),
    s AS MATERIALIZED (
      SELECT p.*
        FROM p
        JOIN "patients" pa
          ON pa."tenantId" = ${p.tenantId}::uuid AND pa."id" = p."patientId"
       WHERE p."locationId" = ANY(${[...p.locationIds]}::uuid[])
         ${p.providerId !== undefined ? Prisma.sql`AND p."providerId" = ${p.providerId}::uuid` : Prisma.empty}
         AND pa."deletedAt" IS NULL
         AND pa."partially_suppressed_at" IS NULL
    ),
    f AS MATERIALIZED (
      SELECT s.*,
             CASE WHEN ${lapsed} OR ${isNew}
                  THEN ${upcomingExists(p.tenantId, Prisma.sql`s."patientId"`, p.now)}
                  ELSE false END AS "upcoming",
             CASE WHEN ${isNew}
                  THEN EXISTS (
                    SELECT 1 FROM "appointments" r
                     WHERE r."tenantId" = ${p.tenantId}::uuid
                       AND r."patientId" = s."patientId"
                       AND r."status" = 'COMPLETED'
                       AND r."deletedAt" IS NULL
                       AND r."start" > s."firstAt"
                       AND r."start" <= s."firstAt" + make_interval(days => ${NEW_NO_RETURN_DAYS}::int))
                  ELSE false END AS "returnedWithinDays"
        FROM s
    )`;
}

/** Cuántos pacientes por sede, profesional y combinación de hechos. */
export function retentionGroupsSql(p: RetentionSqlParams): Prisma.Sql {
  return Prisma.sql`${retentionFactsCtes(p)},
    g AS (
      SELECT f."locationId", f."providerId",
             f."activeAtStart", f."activeWindowAtEnd", f."seenBefore",
             f."seenInPeriod", f."upcoming", f."returnedWithinDays",
             count(*)::int AS "count"
        FROM f
       GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
    )
    SELECT g.*, lo."name" AS "locationName", u."fullName" AS "providerName"
      FROM g
      JOIN "locations" lo
        ON lo."tenantId" = ${p.tenantId}::uuid AND lo."id" = g."locationId"
      LEFT JOIN "users" u ON u."id" = g."providerId"`;
}

export interface RetentionPatientsSqlParams extends RetentionSqlParams {
  segment: RetentionSegment;
  skip: number;
  take: number;
}

/**
 * Una página de una lista con el total (de la misma evaluación de `f`); una
 * página vacía devuelve una fila con el total y el resto a NULL. Orden: la
 * última visita más reciente primero, después el apellido y el id.
 */
export function retentionPatientsSql(
  p: RetentionPatientsSqlParams,
): Prisma.Sql {
  const order = (alias: Prisma.Sql) =>
    Prisma.sql`${alias}."lastAt" DESC, ${alias}."lastName" ASC, ${alias}."patientId" ASC`;
  return Prisma.sql`${retentionFactsCtes(p)},
    d AS MATERIALIZED (
      SELECT f."patientId", f."locationId", f."providerId", f."firstAt", f."lastAt",
             pa."firstName", pa."lastName", pa."phone",
             (pa."reminderOptOutAt" IS NOT NULL) AS "reminderOptedOut"
        FROM f
        JOIN "patients" pa
          ON pa."tenantId" = ${p.tenantId}::uuid AND pa."id" = f."patientId"
       WHERE ${SEGMENT_SQL[p.segment]}
    ),
    page AS (
      SELECT d.* FROM d
       ORDER BY ${order(Prisma.raw('d'))}
       OFFSET ${p.skip} LIMIT ${p.take}
    )
    SELECT t."total",
           pg."patientId",
           btrim(pg."firstName" || ' ' || pg."lastName") AS "patientName",
           pg."phone",
           lo."defaultPhoneRegion" AS "phoneRegion",
           pg."reminderOptedOut",
           pg."firstAt" AS "firstVisitAt",
           pg."lastAt" AS "lastVisitAt",
           pg."locationId",
           lo."name" AS "locationName",
           pg."providerId",
           u."fullName" AS "providerName",
           CASE WHEN pg."patientId" IS NULL THEN NULL
                ELSE ${upcomingExists(p.tenantId, Prisma.sql`pg."patientId"`, p.now)} END
             AS "hasUpcomingAppointment"
      FROM (SELECT count(*)::int AS "total" FROM d) t
      LEFT JOIN page pg ON true
      LEFT JOIN "locations" lo
        ON lo."tenantId" = ${p.tenantId}::uuid AND lo."id" = pg."locationId"
      LEFT JOIN "users" u ON u."id" = pg."providerId"
     ORDER BY ${order(Prisma.raw('pg'))}`;
}

interface GroupSqlRow {
  locationId: string;
  providerId: string;
  locationName: string;
  providerName: string | null;
  activeAtStart: boolean;
  activeWindowAtEnd: boolean;
  seenBefore: boolean;
  seenInPeriod: boolean;
  upcoming: boolean;
  returnedWithinDays: boolean;
  count: number;
}

type PatientSqlRow = { total: number } & (
  RetentionPatientRow | { [K in keyof RetentionPatientRow]: null }
);

/**
 * «Retención» (DX-260) sobre Prisma, con el tenant explícito además de la
 * RLS. Cada lectura es UNA sentencia (las CTEs de `retentionFactsCtes`).
 */
@Injectable()
export class PrismaRetentionRepository implements RetentionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async listLocations(allowed: AllowedLocations): Promise<RetentionLocation[]> {
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

  async listProfessionals(
    locationIds: readonly string[],
  ): Promise<RetentionProfessionalOption[]> {
    const tenantId = this.requireTenantId();
    const ids = [...locationIds];
    if (ids.length === 0) return [];
    // Por las membresías (también retiradas) con un EXISTS que para en la
    // primera cita atendida: (tenantId, providerId, start) de las citas.
    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<RetentionProfessionalOption[]>`
        SELECT DISTINCT m."userId", u."fullName"
          FROM "clinic_memberships" m
          JOIN "users" u ON u."id" = m."userId"
         WHERE m."tenantId" = ${tenantId}::uuid
           AND EXISTS (
                 SELECT 1 FROM "appointments" a
                  WHERE a."tenantId" = m."tenantId"
                    AND a."providerId" = m."userId"
                    AND a."status" = 'COMPLETED'
                    AND a."deletedAt" IS NULL
                    AND a."locationId" = ANY(${ids}::uuid[]))`,
    );
    return [...new Map(rows.map((r) => [r.userId, r])).values()].sort((a, b) =>
      a.fullName.localeCompare(b.fullName, 'es', { sensitivity: 'base' }),
    );
  }

  async locationZones(): Promise<ReadonlyMap<string, string>> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const zones = await loadPeriodLocationZones(
        tx,
        tenantId,
        undefined,
        firstLocationWithRows(tx.appointment, tenantId),
      );
      return zones.configured;
    });
  }

  async factGroups(query: RetentionQuery): Promise<RetentionFactsGroup[]> {
    const tenantId = this.requireTenantId();
    if (!hasScope(query)) return [];
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.$queryRaw<GroupSqlRow[]>(retentionGroupsSql({ ...query, tenantId })),
    );
    return rows.map((r) => ({
      locationId: r.locationId,
      locationName: r.locationName,
      providerId: r.providerId,
      providerName: r.providerName,
      facts: {
        activeAtStart: r.activeAtStart,
        activeWindowAtEnd: r.activeWindowAtEnd,
        seenBefore: r.seenBefore,
        seenInPeriod: r.seenInPeriod,
        upcoming: r.upcoming,
        returnedWithinDays: r.returnedWithinDays,
      },
      count: Number(r.count),
    }));
  }

  async listPatients(
    query: RetentionQuery,
    segment: RetentionSegment,
    page: { skip: number; take: number },
  ): Promise<{ items: RetentionPatientRow[]; total: number }> {
    const tenantId = this.requireTenantId();
    if (!hasScope(query)) return { items: [], total: 0 };
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.$queryRaw<PatientSqlRow[]>(
        retentionPatientsSql({ ...query, tenantId, segment, ...page }),
      ),
    );
    const total = rows.length > 0 ? Number(rows[0].total) : 0;
    const items: RetentionPatientRow[] = [];
    for (const r of rows) {
      if (r.patientId === null) continue;
      items.push({
        patientId: r.patientId,
        patientName: r.patientName,
        phone: r.phone,
        phoneRegion: r.phoneRegion,
        reminderOptedOut: r.reminderOptedOut,
        firstVisitAt: r.firstVisitAt,
        lastVisitAt: r.lastVisitAt,
        locationId: r.locationId,
        locationName: r.locationName,
        providerId: r.providerId,
        providerName: r.providerName,
        hasUpcomingAppointment: r.hasUpcomingAppointment === true,
      });
    }
    return { items, total };
  }
}

/** Sin sedes en las que atribuir o sin cortes, no hay nada que leer. */
function hasScope(query: {
  locationIds: readonly string[];
  bounds: readonly RetentionLocationBounds[];
}): boolean {
  return query.locationIds.length > 0 && query.bounds.length > 0;
}
