import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import { loadPeriodLocationZones } from '../../../shared/locations/location-time-zone';
import { resolveReferenceLocation } from '../../../shared/locations/reference-location';
import {
  civilPeriodByZone,
  civilRangeInZone,
  type InstantRange,
  type ZonedPeriodBranch,
} from '../../../shared/time/civil-day';
import type { CivilPeriod } from '../domain/comparison-period';
import {
  EMPTY_QUOTE_FUNNEL_SUMS,
  QUOTE_FUNNEL_REJECTION_REASONS,
  type QuoteFunnelPresentationOutcome,
  type QuoteFunnelRejectionReason,
  type QuoteFunnelSums,
  type RejectionReasonSums,
} from '../domain/quote-funnel';
import type {
  QuoteFunnelAggregate,
  QuoteFunnelDetailFilter,
  QuoteFunnelLocation,
  QuoteFunnelPresentationRow,
  QuoteFunnelProfessional,
  QuoteFunnelProfessionalSums,
  QuoteFunnelRepository,
  QuoteFunnelScope,
} from '../domain/ports/quote-funnel-repository.port';
import { inPeriod, utcTimestamp } from './zoned-period-sql';

type Num = Prisma.Decimal | number | null;

interface AggregateRow {
  kind: 'TOTAL' | 'PROFESSIONAL' | 'REASON';
  professionalId: string | null;
  professionalName: string | null;
  rejectionReason: string | null;
  presented: number;
  presentedAmount: Num;
  accepted: number;
  acceptedAmount: Num;
  scheduled: number;
  scheduledAmount: Num;
  done: number;
  doneAmount: Num;
  collected: number;
  collectedAmount: Num;
  pending: number;
  pendingAmount: Num;
  rejected: number;
  rejectedAmount: Num;
  cancelled: number;
  cancelledAmount: Num;
  withoutRate: number;
  medianSeconds: number | null;
}

interface DetailRow {
  groupId: string;
  planIds: string[];
  firstPlanId: string;
  patientId: string | null;
  patientName: string | null;
  presentedAt: Date;
  locationId: string | null;
  locationName: string | null;
  professionalId: string | null;
  professionalName: string | null;
  optionCount: number;
  withRate: boolean;
  presentedAmount: Num;
  acceptedAmount: Num;
  scheduledAmount: Num;
  doneAmount: Num;
  collectedAmount: Num;
  outcome: QuoteFunnelPresentationOutcome;
  rejectionReason: string | null;
  total: bigint;
}

const num = (value: Num): number =>
  value === null ? 0 : typeof value === 'number' ? value : value.toNumber();

const isReason = (value: string | null): value is QuoteFunnelRejectionReason =>
  (QUOTE_FUNNEL_REJECTION_REASONS as readonly (string | null)[]).includes(
    value,
  );

/**
 * Sin JIT en la transacción de la lectura: el coste ESTIMADO de las CTE (sus
 * filas se estiman a ciegas) pasa de `jit_above_cost` y Postgres compila la
 * consulta: ~1 s de compilación para ~0,3 s de ejecución con 20 000 planes
 * (medido en el int de DX-558). `SET LOCAL`: solo esta transacción.
 */
async function withoutJit(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SET LOCAL jit = off`;
}

/** El período ya cortado por zonas, y la zona de cada sede de una fila. */
interface ResolvedPeriod {
  branches: ZonedPeriodBranch[];
  /** Presentaciones SIN sede: el día civil de la sede principal (R6). */
  fallback: (InstantRange & { timeZone: string }) | null;
  zoneOf: (locationId: string | null) => string;
}

function sumsOf(row: AggregateRow): QuoteFunnelSums {
  return {
    presented: row.presented,
    presentedAmount: num(row.presentedAmount),
    accepted: row.accepted,
    acceptedAmount: num(row.acceptedAmount),
    scheduled: row.scheduled,
    scheduledAmount: num(row.scheduledAmount),
    done: row.done,
    doneAmount: num(row.doneAmount),
    collected: row.collected,
    collectedAmount: num(row.collectedAmount),
    pending: row.pending,
    pendingAmount: num(row.pendingAmount),
    rejected: row.rejected,
    rejectedAmount: num(row.rejectedAmount),
    cancelled: row.cancelled,
    cancelledAmount: num(row.cancelledAmount),
    withoutRate: row.withoutRate,
    medianSecondsToAccept: row.medianSeconds,
  };
}

/**
 * Lecturas del «Embudo de presupuestos» (DX-558), con el tenant explícito
 * además de la RLS, en UNA transacción REPEATABLE READ y UNA consulta por
 * lectura. Las CTE de `funnel()` dejan una fila por PRESENTACIÓN:
 *
 *  1. `cand`: planes raíz (`splitFromPlanId` nulo) vivos con `presentedAt`
 *     en la ventana del período: el índice parcial
 *     `treatment_plans_tenant_presented_idx` (DX-558).
 *  2. `roots`: los planes raíz presentados de esos grupos de opciones
 *     (`coalesce(optionGroupId, id)`, DX-040), también los presentados fuera
 *     de la ventana: deciden la fecha de la presentación.
 *  3. `firsts` / `groups`: la primera presentación del grupo (la fecha, la
 *     sede y quién lo elaboró) y solo los grupos cuya primera presentación cae
 *     en el período (día civil de su sede, DX-097) y en el alcance.
 *  4. `chain`: cada opción con sus pendientes de aceptación parcial (DX-417),
 *     recursivo por `splitFromPlanId`.
 *  5. `items`: los ítems vivos de la cadena con su importe (precio −
 *     descuento) en la moneda del catálogo: tal cual si el plan está en ella;
 *     con la tasa congelada en el ítem (catálogo → plan, DX-513-ter, invertida)
 *     si no; NULL si no hay tasa. Se agregan POR ÍTEM (citas, imputaciones)
 *     antes de juntarlos: ni las citas ni los abonos duplican importes.
 *  6. `funnel`: por grupo, lo presentado (la opción de mayor total), lo
 *     aceptado, agendado, realizado y cobrado, el desenlace y el motivo.
 */
@Injectable()
export class PrismaQuoteFunnelRepository implements QuoteFunnelRepository {
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
  ): Promise<QuoteFunnelLocation[]> {
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
   * Los miembros vivos que elaboraron algún presupuesto presentado en esas
   * sedes: un EXISTS por miembro sobre el índice parcial de presentaciones,
   * que para en el primero.
   */
  async listProfessionals(
    locationIds: readonly string[],
    includeWithoutLocation: boolean,
  ): Promise<QuoteFunnelProfessional[]> {
    const tenantId = this.requireTenantId();
    const ids = [...locationIds];
    if (ids.length === 0 && !includeWithoutLocation) return [];
    const where = includeWithoutLocation
      ? Prisma.sql`(p."presentedLocationId" IS NULL OR p."presentedLocationId" = ANY(${ids}::uuid[]))`
      : Prisma.sql`p."presentedLocationId" = ANY(${ids}::uuid[])`;
    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<QuoteFunnelProfessional[]>`
        SELECT DISTINCT m."userId", u."fullName"
          FROM "clinic_memberships" m
          JOIN "users" u ON u."id" = m."userId"
         WHERE m."tenantId" = ${tenantId}::uuid
           AND m."deletedAt" IS NULL
           AND EXISTS (
             SELECT 1 FROM "treatment_plans" p
              WHERE p."tenantId" = m."tenantId"
                AND p."createdById" = m."userId"
                AND p."deletedAt" IS NULL
                AND p."splitFromPlanId" IS NULL
                AND p."presentedAt" IS NOT NULL
                AND ${where})`,
    );
    return rows.sort((a, b) =>
      a.fullName.localeCompare(b.fullName, 'es', { sensitivity: 'base' }),
    );
  }

  /**
   * Las ramas por zona de las sedes del alcance (una sede sin zona y sin
   * presentaciones se ignora; con ellas, 409 G1) y, si entran las
   * presentaciones sin sede y hay alguna, el día de la sede principal (R6).
   */
  private async period(
    tx: Prisma.TransactionClient,
    tenantId: string,
    period: CivilPeriod,
    scope: QuoteFunnelScope,
  ): Promise<ResolvedPeriod> {
    const zones = await loadPeriodLocationZones(
      tx,
      tenantId,
      scope.locationIds,
      async (ids) =>
        (
          await tx.treatmentPlan.findFirst({
            // El predicado del índice: un plan borrado, un pendiente o uno
            // sin presentar no hacen de una sede sin zona un 409 perpetuo.
            where: {
              tenantId,
              presentedLocationId: { in: ids },
              deletedAt: null,
              splitFromPlanId: null,
              presentedAt: { not: null },
            },
            select: { presentedLocationId: true },
          })
        )?.presentedLocationId,
    );
    const branches = civilPeriodByZone(
      period.from,
      period.to,
      zones.configured,
    );
    let fallback: ResolvedPeriod['fallback'] = null;
    if (scope.includeWithoutLocation) {
      const [withoutLocation] = await tx.$queryRaw<{ found: number }[]>`
        SELECT 1 AS "found" FROM "treatment_plans" p
         WHERE p."tenantId" = ${tenantId}::uuid
           AND p."deletedAt" IS NULL
           AND p."splitFromPlanId" IS NULL
           AND p."presentedAt" IS NOT NULL
           AND p."presentedLocationId" IS NULL
         LIMIT 1`;
      if (withoutLocation) {
        const principal = await resolveReferenceLocation(tx, tenantId, null);
        fallback = {
          timeZone: principal.timeZone,
          ...civilRangeInZone(period.from, period.to, principal.timeZone),
        };
      }
    }
    return {
      branches,
      fallback,
      zoneOf: (locationId) =>
        locationId === null
          ? (fallback?.timeZone ?? 'UTC')
          : zones.zoneOf(locationId),
    };
  }

  /** Las CTE que dejan una fila por presentación en `"funnel"`. */
  private funnel(
    tenantId: string,
    resolved: ResolvedPeriod,
    scope: QuoteFunnelScope,
  ): Prisma.Sql {
    const t = Prisma.sql`${tenantId}::uuid`;
    const ranges: InstantRange[] = [
      ...resolved.branches,
      ...(resolved.fallback ? [resolved.fallback] : []),
    ];
    const window = {
      start: new Date(Math.min(...ranges.map((r) => r.start.getTime()))),
      end: new Date(Math.max(...ranges.map((r) => r.end.getTime()))),
    };
    const located = inPeriod(
      Prisma.sql`g."presentedLocationId"`,
      Prisma.sql`g."presentedAt"`,
      resolved.branches,
    );
    const inScope = resolved.fallback
      ? Prisma.sql`(${located} OR (g."presentedLocationId" IS NULL
             AND g."presentedAt" >= ${utcTimestamp(resolved.fallback.start)}
             AND g."presentedAt" < ${utcTimestamp(resolved.fallback.end)}))`
      : located;
    // Filtros de los candidatos: un SUPERCONJUNTO de los grupos del alcance
    // (la primera presentación del grupo es un candidato: está en la
    // ventana, en una sede del alcance y la elaboró quien se filtra). Lo
    // exacto se decide al final, por grupo.
    const ids = resolved.branches.flatMap((b) => b.locationIds);
    const candidateLocation = resolved.fallback
      ? Prisma.sql`(p."presentedLocationId" IS NULL OR p."presentedLocationId" = ANY(${ids}::uuid[]))`
      : Prisma.sql`p."presentedLocationId" = ANY(${ids}::uuid[])`;
    const byProfessional = (column: Prisma.Sql) =>
      scope.professionalId !== undefined
        ? Prisma.sql`AND ${column} = ${scope.professionalId}::uuid`
        : Prisma.empty;
    const currency = scope.currency;
    // Importe de una cantidad del ítem en la moneda del catálogo; NULL = sin
    // tasa. La tasa es catálogo → plan; se invierte: × from ÷ to.
    const toCatalog = (amount: Prisma.Sql) =>
      currency === null
        ? Prisma.sql`NULL::numeric`
        : Prisma.sql`(CASE
            WHEN ch."currency" = ${currency} THEN ${amount}
            WHEN i."catalogCurrency" = ${currency}
             AND i."referenceRateFrom" IS NOT NULL
             AND i."referenceRateTo" > 0
              THEN ${amount} * i."referenceRateFrom" / i."referenceRateTo"
          END)`;
    // «Aceptado» = se aceptó alguna vez (DX-558): `acceptedAt` lo escribe
    // toda aceptación (`acceptPlanInTx` y, si falta, el trigger
    // dx256_plan_visits_guard; DX-256 lo rellenó en los ACCEPTED/COMPLETED
    // anteriores) y cancelar no lo borra, así que un aceptado y luego
    // cancelado sigue contando; los pasos siguientes enseñan la caída.
    const accepted = Prisma.sql`(ch."acceptedAt" IS NOT NULL AND NOT ch."planDeleted")`;
    const firstOf = (column: string) =>
      Prisma.raw(
        `(array_agg(o."${column}" ORDER BY o."rootPresentedAt", o."rootId") FILTER (WHERE o."rootPresented"))[1]`,
      );
    return Prisma.sql`
      "cand" AS (
        SELECT p."id", p."optionGroupId", p."patientId", p."status",
               p."currency", p."acceptedAt", p."presentedAt",
               p."presentedLocationId", p."createdById", p."rejectedAt",
               p."rejectionReason"
          FROM "treatment_plans" p
         WHERE p."tenantId" = ${t}
           AND p."deletedAt" IS NULL
           AND p."splitFromPlanId" IS NULL
           AND p."presentedAt" >= ${utcTimestamp(window.start)}
           AND p."presentedAt" < ${utcTimestamp(window.end)}
           AND ${candidateLocation}
           ${byProfessional(Prisma.sql`p."createdById"`)}
      ),
      "roots" AS (
        SELECT c.*, c."id" AS "g" FROM "cand" c WHERE c."optionGroupId" IS NULL
        UNION ALL
        -- Todas las opciones raíz vivas del grupo, también las que nunca se
        -- presentaron (una alternativa en borrador aceptada sin presentar,
        -- DRAFT → ACCEPTED): cuentan desde «aceptado»; fecha, sede, autor,
        -- nº de opciones y lo presentado son solo de las presentadas.
        SELECT p."id", p."optionGroupId", p."patientId", p."status",
               p."currency", p."acceptedAt", p."presentedAt",
               p."presentedLocationId", p."createdById", p."rejectedAt",
               p."rejectionReason", p."optionGroupId" AS "g"
          FROM (SELECT DISTINCT c."optionGroupId" FROM "cand" c
                 WHERE c."optionGroupId" IS NOT NULL) og
          -- Un grupo que abrió un PENDIENTE de una aceptación parcial (sus
          -- alternativas, DX-040 sobre DX-417) no es una presentación: es
          -- parte de la cadena del presupuesto original.
          JOIN "treatment_plans" op
            ON op."tenantId" = ${t} AND op."id" = og."optionGroupId"
           AND op."splitFromPlanId" IS NULL
          JOIN "treatment_plans" p
            ON p."tenantId" = ${t} AND p."optionGroupId" = og."optionGroupId"
         WHERE p."deletedAt" IS NULL
           AND p."splitFromPlanId" IS NULL
      ),
      "chain" AS (
        SELECT r."g", r."id" AS "rootId", r."id" AS "planId", r."status",
               r."currency", r."acceptedAt", FALSE AS "planDeleted",
               FALSE AS "viaSplit", FALSE AS "alternative", r."patientId",
               r."presentedAt" IS NOT NULL AS "rootPresented",
               r."status" AS "rootStatus", r."presentedAt" AS "rootPresentedAt",
               r."presentedLocationId" AS "rootLocationId",
               r."createdById" AS "rootCreatedById",
               r."rejectedAt" AS "rootRejectedAt",
               r."rejectionReason" AS "rootReason"
          FROM "roots" r
        UNION ALL
        SELECT c."g", c."rootId", p."id", p."status", p."currency",
               p."acceptedAt", p."deletedAt" IS NOT NULL, TRUE, FALSE,
               c."patientId",
               c."rootPresented", c."rootStatus",
               c."rootPresentedAt", c."rootLocationId", c."rootCreatedById",
               c."rootRejectedAt", c."rootReason"
          FROM "chain" c
          -- Los pendientes de una aceptación parcial (DX-417), también los
          -- BORRADOS: la cadena los atraviesa (sus descendientes vivos
          -- siguen contando) pero no suma lo suyo.
          JOIN "treatment_plans" p
            ON p."tenantId" = ${t} AND p."splitFromPlanId" = c."planId"
      ),
      -- Las alternativas de un pendiente (DX-040 sobre DX-417) y sus propios
      -- pendientes: parte de la presentación original, pero solo desde
      -- «aceptado» (no suman a lo presentado ni son raíz).
      "altChain" AS (
        SELECT c."g", c."rootId", a."id" AS "planId", a."status",
               a."currency", a."acceptedAt",
               a."deletedAt" IS NOT NULL AS "planDeleted", FALSE AS "viaSplit",
               TRUE AS "alternative", c."patientId", c."rootPresented",
               c."rootStatus", c."rootPresentedAt", c."rootLocationId",
               c."rootCreatedById", c."rootRejectedAt", c."rootReason"
          FROM "chain" c
          -- Por el índice (tenantId, optionGroupId) de cada pendiente (la
          -- barrera OFFSET 0, como con los ítems: sin ella se lee la tabla).
          CROSS JOIN LATERAL (
            SELECT x.* FROM "treatment_plans" x
             WHERE x."tenantId" = ${t} AND x."optionGroupId" = c."planId"
               AND x."id" <> c."planId" AND x."splitFromPlanId" IS NULL
            OFFSET 0
          ) a
         WHERE c."viaSplit"
        UNION ALL
        SELECT c."g", c."rootId", p."id", p."status", p."currency",
               p."acceptedAt", p."deletedAt" IS NOT NULL, TRUE, TRUE,
               c."patientId", c."rootPresented", c."rootStatus",
               c."rootPresentedAt", c."rootLocationId", c."rootCreatedById",
               c."rootRejectedAt", c."rootReason"
          FROM "altChain" c
          JOIN "treatment_plans" p
            ON p."tenantId" = ${t} AND p."splitFromPlanId" = c."planId"
      ),
      "fullChain" AS (
        SELECT * FROM "chain" UNION ALL SELECT * FROM "altChain"
      ),
      -- Una fila por plan de la cadena con lo de sus ítems ya sumado (DX-558-bis):
      -- antes se abría una fila por ítem (42 000 con 20 000 planes) y se
      -- ordenaba entera, a disco, para agruparla por opción. Los ítems de CADA
      -- plan van por el índice parcial de ítems vivos (tenantId, planId): las
      -- filas de una CTE se estiman a ciegas y, sin la barrera del LATERAL, el
      -- planificador prefiere leer todos los ítems de la clínica (crece con la
      -- historia). El agregado sin GROUP BY deja una fila también en un plan
      -- sin ítems (o borrado), con sumas NULL y, tras el coalesce, FALSE.
      "lines" AS (
        SELECT ch.*, ${accepted} AS "planAccepted", it.*
          FROM "fullChain" ch
          CROSS JOIN LATERAL (
            SELECT sum(x."amount") AS "amount",
                   coalesce(bool_or(x."amount" IS NULL), FALSE) AS "missingRate",
                   coalesce(bool_or(x."scheduled"), FALSE) AS "scheduled",
                   sum(x."amount") FILTER (WHERE x."scheduled") AS "scheduledAmount",
                   coalesce(bool_or(x."status" = 'DONE'), FALSE) AS "anyDone",
                   sum(x."amount") FILTER (WHERE x."status" = 'DONE') AS "doneAmount",
                   coalesce(bool_or(x."inPlan" > 0), FALSE) AS "anyCollected",
                   sum(x."allocated") AS "allocated"
              FROM (
                SELECT i."id", i."status",
                       ${toCatalog(Prisma.sql`(i."price" - i."discount")`)} AS "amount",
                       al."inPlan",
                       ${toCatalog(Prisma.sql`al."inPlan"`)} AS "allocated",
                       (${accepted}
                        AND (i."status" = 'DONE' OR EXISTS (
                          SELECT 1 FROM "appointment_plan_items" l
                            JOIN "appointments" a
                              ON a."tenantId" = l."tenantId" AND a."id" = l."appointmentId"
                           WHERE l."tenantId" = ${t} AND l."planItemId" = i."id"
                             AND l."deletedAt" IS NULL AND a."deletedAt" IS NULL)))
                         AS "scheduled"
                  FROM "treatment_plan_items" i
                  -- Lo imputado a cada ítem, solo en los planes aceptados (los
                  -- únicos que cuentan como cobrados).
                  LEFT JOIN LATERAL (
                    SELECT sum(pa."amount") AS "inPlan"
                      FROM "payment_allocations" pa
                     WHERE ${accepted}
                       AND pa."tenantId" = ${t} AND pa."treatmentPlanItemId" = i."id"
                  ) al ON TRUE
                 WHERE NOT ch."planDeleted"
                   AND i."tenantId" = ${t} AND i."planId" = ch."planId"
                   AND i."deletedAt" IS NULL
                -- Barrera: sin ella el planificador repite la subconsulta de
                -- «agendado» en cada agregado que la lee.
                OFFSET 0
              ) x
          ) it
      ),
      "byOption" AS (
        SELECT l."g", l."rootId", l."patientId", l."rootPresented",
               l."rootStatus", l."rootPresentedAt", l."rootLocationId",
               l."rootCreatedById", l."rootRejectedAt", l."rootReason",
               -- Lo presentado de la opción: su cadena sin las alternativas
               -- de un pendiente.
               coalesce(sum(l."amount") FILTER (WHERE NOT l."alternative"), 0) AS "total",
               bool_or(l."missingRate" AND NOT l."alternative") AS "missingRate",
               bool_or(l."missingRate" AND l."planAccepted") AS "missingAcceptedRate",
               bool_or(l."planAccepted") AS "accepted",
               min(l."acceptedAt") FILTER (WHERE l."planAccepted") AS "acceptedAt",
               sum(l."amount") FILTER (WHERE l."planAccepted") AS "acceptedAmount",
               bool_or(l."scheduled") AS "scheduled",
               sum(l."scheduledAmount") AS "scheduledAmount",
               bool_or(l."planAccepted" AND l."anyDone") AS "done",
               sum(l."doneAmount") FILTER (WHERE l."planAccepted") AS "doneAmount",
               bool_or(l."planAccepted" AND l."anyCollected") AS "collected",
               sum(l."allocated") FILTER (WHERE l."planAccepted") AS "collectedAmount"
          FROM "lines" l
         GROUP BY l."g", l."rootId", l."patientId", l."rootPresented",
                  l."rootStatus", l."rootPresentedAt", l."rootLocationId",
                  l."rootCreatedById", l."rootRejectedAt", l."rootReason"
      ),
      "byGroup" AS (
        SELECT o."g",
               ${firstOf('rootId')} AS "firstPlanId",
               ${firstOf('patientId')} AS "patientId",
               min(o."rootPresentedAt") AS "presentedAt",
               ${firstOf('rootLocationId')} AS "presentedLocationId",
               ${firstOf('rootCreatedById')} AS "createdById",
               (count(*) FILTER (WHERE o."rootPresented"))::int AS "optionCount",
               -- Sin tasa: lo que cuenta de cada opción (todo lo presentado;
               -- de una no presentada, solo lo aceptado).
               (${currency !== null}::boolean
                 AND NOT bool_or(coalesce(CASE WHEN o."rootPresented"
                   THEN o."missingRate" OR o."missingAcceptedRate"
                   ELSE o."missingAcceptedRate" END, FALSE))) AS "withRate",
               max(o."total") FILTER (WHERE o."rootPresented") AS "presentedAmount",
               bool_or(o."accepted") AS "accepted",
               min(o."acceptedAt") AS "acceptedAt",
               coalesce(sum(o."acceptedAmount"), 0) AS "acceptedAmount",
               bool_or(o."scheduled") AS "scheduled",
               coalesce(sum(o."scheduledAmount"), 0) AS "scheduledAmount",
               bool_or(o."done") AS "done",
               coalesce(sum(o."doneAmount"), 0) AS "doneAmount",
               bool_or(o."collected") AS "collected",
               coalesce(sum(o."collectedAmount"), 0) AS "collectedAmount",
               bool_or(o."rootPresented" AND o."rootStatus" = 'PRESENTED') AS "pending",
               bool_or(o."rootPresented" AND o."rootStatus" = 'REJECTED'
                 AND o."rootReason" IS DISTINCT FROM 'OTHER_OPTION_ACCEPTED')
                 AS "rejected",
               (array_agg(o."rootReason"::text
                  ORDER BY o."rootRejectedAt" DESC NULLS LAST, o."rootId")
                  FILTER (WHERE o."rootPresented" AND o."rootStatus" = 'REJECTED'
                    AND o."rootReason" IS DISTINCT FROM 'OTHER_OPTION_ACCEPTED'))[1]
                 AS "lastReason"
          FROM "byOption" o
         GROUP BY o."g"
      ),
      "funnel" AS (
        SELECT g."g", g."firstPlanId", g."patientId", g."presentedAt",
               g."presentedLocationId", g."optionCount", g."withRate",
               g."presentedAmount", g."accepted", g."acceptedAmount",
               g."accepted" AND g."scheduled" AS "scheduled",
               g."scheduledAmount",
               g."accepted" AND g."done" AS "done", g."doneAmount",
               g."accepted" AND g."collected" AS "collected",
               g."collectedAmount",
               CASE WHEN g."accepted" THEN 'ACCEPTED'
                    WHEN g."pending" THEN 'PENDING'
                    WHEN g."rejected" THEN 'REJECTED'
                    ELSE 'CANCELLED' END AS "outcome",
               CASE WHEN NOT g."accepted" AND NOT g."pending" AND g."rejected"
                    THEN g."lastReason" END AS "rejectionReason",
               EXTRACT(EPOCH FROM (g."acceptedAt" - g."presentedAt"))::float8
                 AS "secondsToAccept",
               CASE WHEN EXISTS (
                 SELECT 1 FROM "clinic_memberships" m
                  WHERE m."tenantId" = ${t} AND m."userId" = g."createdById"
                    AND m."deletedAt" IS NULL)
               THEN g."createdById" END AS "professionalId"
          FROM "byGroup" g
         WHERE ${inScope}
           ${byProfessional(Prisma.sql`g."createdById"`)}
      )`;
  }

  async aggregate(
    period: CivilPeriod,
    scope: QuoteFunnelScope,
  ): Promise<QuoteFunnelAggregate> {
    const tenantId = this.requireTenantId();
    const empty: QuoteFunnelAggregate = {
      total: EMPTY_QUOTE_FUNNEL_SUMS,
      byProfessional: [],
      rejectionReasons: [],
    };
    if (scope.locationIds.length === 0 && !scope.includeWithoutLocation) {
      return empty;
    }
    return this.prisma.runWithTenant(
      async (tx) => {
        const resolved = await this.period(tx, tenantId, period, scope);
        if (resolved.branches.length === 0 && !resolved.fallback) return empty;
        await withoutJit(tx);
        const money = (field: string, when: string) =>
          Prisma.raw(
            `coalesce(sum(f."${field}") FILTER (WHERE f."withRate" AND ${when}), 0)`,
          );
        const rows = await tx.$queryRaw<AggregateRow[]>`
          WITH RECURSIVE ${this.funnel(tenantId, resolved, scope)}
          SELECT s.*, u."fullName" AS "professionalName"
            FROM (
              SELECT CASE WHEN GROUPING(f."professionalId") = 0 THEN 'PROFESSIONAL'
                          WHEN GROUPING(f."rejectionReason") = 0 THEN 'REASON'
                          ELSE 'TOTAL' END AS "kind",
                     f."professionalId", f."rejectionReason",
                     count(*)::int AS "presented",
                     ${money('presentedAmount', 'TRUE')} AS "presentedAmount",
                     count(*) FILTER (WHERE f."accepted")::int AS "accepted",
                     ${money('acceptedAmount', 'f."accepted"')} AS "acceptedAmount",
                     count(*) FILTER (WHERE f."scheduled")::int AS "scheduled",
                     ${money('scheduledAmount', 'f."scheduled"')} AS "scheduledAmount",
                     count(*) FILTER (WHERE f."done")::int AS "done",
                     ${money('doneAmount', 'f."done"')} AS "doneAmount",
                     count(*) FILTER (WHERE f."collected")::int AS "collected",
                     ${money('collectedAmount', 'f."collected"')} AS "collectedAmount",
                     count(*) FILTER (WHERE f."outcome" = 'PENDING')::int AS "pending",
                     ${money('presentedAmount', `f."outcome" = 'PENDING'`)} AS "pendingAmount",
                     count(*) FILTER (WHERE f."outcome" = 'REJECTED')::int AS "rejected",
                     ${money('presentedAmount', `f."outcome" = 'REJECTED'`)} AS "rejectedAmount",
                     count(*) FILTER (WHERE f."outcome" = 'CANCELLED')::int AS "cancelled",
                     ${money('presentedAmount', `f."outcome" = 'CANCELLED'`)} AS "cancelledAmount",
                     count(*) FILTER (WHERE NOT f."withRate")::int AS "withoutRate",
                     (percentile_cont(0.5) WITHIN GROUP (ORDER BY f."secondsToAccept")
                        FILTER (WHERE f."accepted"))::float8 AS "medianSeconds"
                FROM "funnel" f
               GROUP BY GROUPING SETS ((f."professionalId"), (f."rejectionReason"), ())
            ) s
            LEFT JOIN "users" u ON u."id" = s."professionalId"`;
        const total = rows.find((r) => r.kind === 'TOTAL');
        const byProfessional: QuoteFunnelProfessionalSums[] = rows
          .filter((r) => r.kind === 'PROFESSIONAL')
          .map((r) => ({
            ...sumsOf(r),
            professionalId: r.professionalId,
            professionalName: r.professionalId ? r.professionalName : null,
          }));
        const rejectionReasons: RejectionReasonSums[] = rows.flatMap((r) =>
          r.kind === 'REASON' && isReason(r.rejectionReason)
            ? [
                {
                  reason: r.rejectionReason,
                  count: r.presented,
                  amount: num(r.presentedAmount),
                },
              ]
            : [],
        );
        return {
          total: total ? sumsOf(total) : EMPTY_QUOTE_FUNNEL_SUMS,
          byProfessional,
          rejectionReasons,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async listPresentations(
    period: CivilPeriod,
    scope: QuoteFunnelScope,
    filter: QuoteFunnelDetailFilter,
    page: { skip: number; take: number },
  ): Promise<{ items: QuoteFunnelPresentationRow[]; total: number }> {
    const tenantId = this.requireTenantId();
    if (scope.locationIds.length === 0 && !scope.includeWithoutLocation) {
      return { items: [], total: 0 };
    }
    return this.prisma.runWithTenant(
      async (tx) => {
        const resolved = await this.period(tx, tenantId, period, scope);
        if (resolved.branches.length === 0 && !resolved.fallback) {
          return { items: [], total: 0 };
        }
        await withoutJit(tx);
        const byStep: Record<QuoteFunnelDetailFilter['step'], Prisma.Sql> = {
          PRESENTED: Prisma.sql`TRUE`,
          ACCEPTED: Prisma.sql`f."accepted"`,
          SCHEDULED: Prisma.sql`f."scheduled"`,
          DONE: Prisma.sql`f."done"`,
          COLLECTED: Prisma.sql`f."collected"`,
          PENDING: Prisma.sql`f."outcome" = 'PENDING'`,
          REJECTED: Prisma.sql`f."outcome" = 'REJECTED'`,
          CANCELLED: Prisma.sql`f."outcome" = 'CANCELLED'`,
        };
        const reason =
          filter.reason !== undefined
            ? Prisma.sql`AND f."rejectionReason" = ${filter.reason}`
            : Prisma.empty;
        const funnel = this.funnel(tenantId, resolved, scope);
        const select = (paging: Prisma.Sql) => tx.$queryRaw<DetailRow[]>`
          WITH RECURSIVE ${funnel}
          SELECT f.*,
                 -- Los planes de la presentación, solo de la página.
                 (SELECT array_agg(DISTINCT ch."planId")
                    FROM "fullChain" ch
                   WHERE ch."g" = f."groupId" AND NOT ch."planDeleted") AS "planIds",
                 -- Un paciente eliminado no se nombra ni se enlaza.
                 pt."id" AS "patientId",
                 btrim(pt."firstName" || ' ' || pt."lastName") AS "patientName",
                 l."name" AS "locationName", u."fullName" AS "professionalName"
            FROM (
              SELECT f."g" AS "groupId", f."firstPlanId",
                     f."patientId" AS "funnelPatientId", f."presentedAt",
                     f."presentedLocationId" AS "locationId",
                     f."professionalId", f."optionCount", f."withRate",
                     f."presentedAmount", f."acceptedAmount",
                     f."scheduledAmount", f."doneAmount", f."collectedAmount",
                     f."outcome", f."rejectionReason",
                     count(*) OVER () AS "total"
                FROM "funnel" f
               WHERE ${byStep[filter.step]} ${reason}
               ORDER BY f."presentedAt" DESC, f."g"
               ${paging}
            ) f
            LEFT JOIN "patients" pt
              ON pt."tenantId" = ${tenantId}::uuid AND pt."id" = f."funnelPatientId"
             AND pt."deletedAt" IS NULL
            LEFT JOIN "locations" l
              ON l."tenantId" = ${tenantId}::uuid AND l."id" = f."locationId"
            LEFT JOIN "users" u ON u."id" = f."professionalId"
           ORDER BY f."presentedAt" DESC, f."groupId"`;
        const rows = await select(
          Prisma.sql`OFFSET ${page.skip} LIMIT ${page.take}`,
        );
        let total = rows.length > 0 ? Number(rows[0].total) : 0;
        if (rows.length === 0 && page.skip > 0) {
          // Página pasada del final: el total sale de la primera fila.
          const [first] = await select(Prisma.sql`LIMIT 1`);
          total = first ? Number(first.total) : 0;
        }
        const amount = (row: DetailRow, value: Num) =>
          row.withRate ? num(value) : null;
        return {
          total,
          items: rows.map((r) => ({
            groupId: r.groupId,
            planIds: r.planIds,
            firstPlanId: r.firstPlanId,
            patientId: r.patientId,
            patientName: r.patientId ? r.patientName : null,
            presentedAt: r.presentedAt,
            locationId: r.locationId,
            locationName: r.locationName,
            timeZone: resolved.zoneOf(r.locationId),
            professionalId: r.professionalId,
            professionalName: r.professionalId ? r.professionalName : null,
            optionCount: r.optionCount,
            presentedAmount: amount(r, r.presentedAmount),
            acceptedAmount: amount(r, r.acceptedAmount),
            scheduledAmount: amount(r, r.scheduledAmount),
            doneAmount: amount(r, r.doneAmount),
            collectedAmount: amount(r, r.collectedAmount),
            outcome: r.outcome,
            rejectionReason: isReason(r.rejectionReason)
              ? r.rejectionReason
              : null,
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
