import { Injectable } from '@nestjs/common';
import { Prisma, type OrthoCase } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../shared/time/civil-day';
import { ADDENDA_ORDER } from '../../clinical-entries/infrastructure/repositories/prisma-clinical-entry-addendum.repository';
import type {
  OrthoAlignerSeriesView,
  OrthoBalanceFlag,
  OrthoCaseRecord,
  OrthoCaseView,
  OrthoFee,
  OrthoFollowUpRow,
  OrthoSettings,
  OrthoVisitView,
} from '../domain/entities';
import type {
  AcceptOrthoFeeInput,
  AcceptOrthoFeeOutcome,
  AddAlignerDeliveryInput,
  AddAlignerDeliveryOutcome,
  CreateAlignerSeriesInput,
  CreateOrthoCaseRepoInput,
  OrthoAccountFacts,
  OrthoFeeCurrencySource,
  InsertOrthoVisitInput,
  OrthoFollowUpQuery,
  OrthoRepository,
  OrthoStatusChangeRepoInput,
  UpdateOrthoCaseRepoInput,
} from '../domain/ports/ortho-repository.port';
import {
  ORTHO_OVERDUE_GRACE_DAYS,
  acceptsVisits,
  caseProgress,
  isOverdue,
  type OrthoWire,
} from '../domain/ortho-rules';
import { fromCents } from '../../../shared/money/money';
import type { OrthoFeeSplit } from '../domain/ortho-billing';
import {
  acceptFeeIn,
  accountFactsIn,
  addAlignerDeliveryIn,
  alignerSeriesViews,
  overdueFlagsIn,
  realizeRetentionIn,
  realizeVisitChargeIn,
} from './prisma-ortho-billing';

/** Un `@db.Date` llega como medianoche UTC: su día civil es el de UTC. */
const day = (value: Date): string => value.toISOString().slice(0, 10);
const dayOrNull = (value: Date | null): string | null =>
  value ? day(value) : null;
/** Día civil `YYYY-MM-DD` → el `Date` que Prisma guarda en una columna DATE. */
const dateOf = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const dateOrNull = (value: string | null): Date | null =>
  value ? dateOf(value) : null;

function feeOf(row: OrthoCase): OrthoFee | null {
  if (
    row.feeCurrency === null ||
    row.feeTotal === null ||
    row.feeInitial === null ||
    row.feePerVisit === null ||
    row.feeVisitCount === null ||
    row.feeRetention === null
  ) {
    return null;
  }
  return {
    currency: row.feeCurrency,
    total: row.feeTotal.toNumber(),
    initial: row.feeInitial.toNumber(),
    perVisit: row.feePerVisit.toNumber(),
    visitCount: row.feeVisitCount,
    retention: row.feeRetention.toNumber(),
    updatedAt: row.feeUpdatedAt,
    updatedById: row.feeUpdatedById,
    acceptedAt: row.feeAcceptedAt,
    acceptedById: row.feeAcceptedById,
    paymentPlanId: row.feePaymentPlanId,
  };
}

function mapCase(row: OrthoCase): OrthoCaseRecord {
  return {
    id: row.id,
    patientId: row.patientId,
    locationId: row.locationId,
    providerId: row.providerId,
    treatmentPlanId: row.treatmentPlanId,
    technique: row.technique,
    startDate: day(row.startDate),
    estimatedMonths: row.estimatedMonths,
    plannedVisits: row.plannedVisits,
    visitIntervalDays: row.visitIntervalDays,
    status: row.status,
    statusReason: row.statusReason,
    statusChangedAt: row.statusChangedAt,
    statusChangedById: row.statusChangedById,
    bondedOn: dayOrNull(row.bondedOn),
    debondedOn: dayOrNull(row.debondedOn),
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    fee: feeOf(row),
  };
}

function wireOf(
  material: OrthoWire['material'] | null,
  gauge: string | null,
): OrthoWire | null {
  return material && gauge ? { material, gauge } : null;
}

/**
 * Nombres de miembros de la clínica: el usuario es global y su nombre se lee
 * por la membresía, que tiene RLS (solo los que son o fueron de esta clínica).
 */
async function memberNames(
  tx: Prisma.TransactionClient,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();
  const rows = await tx.clinicMembership.findMany({
    where: { userId: { in: unique } },
    select: { userId: true, user: { select: { fullName: true } } },
  });
  return new Map(rows.map((r) => [r.userId, r.user.fullName]));
}

/**
 * Violación del único parcial «un caso activo por paciente». Prisma no conoce
 * el índice (parcial, solo en SQL) y lo informa como P2002 sin campos; los
 * demás únicos de la tabla son por id (uuid nuevo), así que un P2002 en el
 * alta es este.
 */
function isOneActiveViolation(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002') ||
    (error instanceof Error &&
      error.message.includes('ortho_cases_one_active_key'))
  );
}

const VISIT_INCLUDE = {
  entry: {
    select: {
      notes: true,
      appointmentId: true,
      addenda: { orderBy: ADDENDA_ORDER },
    },
  },
} as const;

type VisitRow = Prisma.OrthoVisitGetPayload<{ include: typeof VISIT_INCLUDE }>;

function mapVisit(
  row: VisitRow,
  visitNumber: number,
  names: Map<string, string>,
): OrthoVisitView {
  return {
    id: row.id,
    caseId: row.caseId,
    clinicalEntryId: row.clinicalEntryId,
    visitNumber,
    visitDate: day(row.visitDate),
    appointmentId: row.entry.appointmentId,
    upperWire: wireOf(row.upperWireMaterial, row.upperWireGauge),
    lowerWire: wireOf(row.lowerWireMaterial, row.lowerWireGauge),
    elasticsType: row.elasticsType,
    elasticsWear: row.elasticsWear,
    applianceChanges: row.applianceChanges,
    incidents: row.incidents,
    hygieneIndex: row.hygieneIndex,
    nextVisitProposedOn: dayOrNull(row.nextVisitProposedOn),
    notes: row.entry.notes,
    authorId: row.authorId,
    authorName: names.get(row.authorId) ?? null,
    createdAt: row.createdAt,
    addenda: row.entry.addenda.map((a) => ({
      id: a.id,
      reason: a.reason,
      text: a.text,
      authorId: a.authorId,
      authorName: names.get(a.authorId) ?? null,
      createdAt: a.createdAt,
    })),
  };
}

interface FollowUpSqlRow {
  total: number;
  caseId: string | null;
  patientId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  phoneE164: string | null;
  locationId: string;
  locationName: string;
  providerId: string;
  providerName: string | null;
  technique: OrthoFollowUpRow['technique'];
  startDate: Date;
  visitIntervalDays: number;
  visitsDone: number;
  plannedVisits: number;
  lastVisitDate: Date | null;
  daysSince: number;
  nextAppointmentAt: Date | null;
  noShowCount: number;
}

/** Estados de una cita futura o en curso (como la lista de recall, DX-015). */
const LIVE_STATUSES = Prisma.sql`('SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')`;

/**
 * DX-190: la lista de seguimiento en UNA consulta. «Hoy» es el día civil de la
 * sede de cada caso (DX-110); los controles, la próxima cita y los no-show
 * salen de subconsultas LATERAL por índice, sin una ida y vuelta por caso.
 */
export function orthoFollowUpSql(
  p: OrthoFollowUpQuery & { tenantId: string; locationIds?: string[] },
): Prisma.Sql {
  const offset = (p.page - 1) * p.pageSize;
  const grace = ORTHO_OVERDUE_GRACE_DAYS;
  const filter =
    p.filter === 'OVERDUE'
      ? Prisma.sql`AND d."daysSince" > d."visitIntervalDays" + ${grace}`
      : p.filter === 'NO_NEXT_APPOINTMENT'
        ? Prisma.sql`AND d."nextAppointmentAt" IS NULL`
        : Prisma.empty;
  const order = (a: Prisma.Sql) => Prisma.sql`
    (${a}."daysSince" > ${a}."visitIntervalDays" + ${grace}) DESC,
    ${a}."daysSince" - ${a}."visitIntervalDays" DESC,
    ${a}."lastName" ASC, ${a}."firstName" ASC, ${a}."caseId" ASC`;
  return Prisma.sql`
    WITH locs AS MATERIALIZED (
      SELECT l."id", l."name", x."zone",
             (${p.now}::timestamptz AT TIME ZONE x."zone")::date AS "today"
        FROM "locations" l
        CROSS JOIN LATERAL (SELECT coalesce(l."timeZone", 'UTC') AS "zone") x
       WHERE l."tenantId" = ${p.tenantId}::uuid
         ${p.locationIds ? Prisma.sql`AND l."id" = ANY(${p.locationIds}::uuid[])` : Prisma.empty}
         ${p.locationId ? Prisma.sql`AND l."id" = ${p.locationId}::uuid` : Prisma.empty}
    ),
    c AS MATERIALIZED (
      SELECT oc."id", oc."patientId", oc."locationId", oc."providerId",
             oc."technique", oc."startDate", oc."visitIntervalDays",
             oc."plannedVisits", lo."name" AS "locationName", lo."zone", lo."today"
        FROM "ortho_cases" oc
        JOIN locs lo ON lo."id" = oc."locationId"
       WHERE oc."tenantId" = ${p.tenantId}::uuid
         AND oc."status" = 'ACTIVE'
         ${p.providerId ? Prisma.sql`AND oc."providerId" = ${p.providerId}::uuid` : Prisma.empty}
    ),
    d AS MATERIALIZED (
      SELECT c."id" AS "caseId", c."patientId", c."locationId", c."locationName",
             c."providerId", c."technique", c."startDate", c."visitIntervalDays",
             c."plannedVisits", pa."firstName", pa."lastName", pa."phone",
             pa."phoneE164",
             vs."n" AS "visitsDone", vs."last" AS "lastVisitDate",
             greatest(0, c."today" - coalesce(vs."last", c."startDate"))::int AS "daysSince",
             na."next" AS "nextAppointmentAt",
             ns."n" AS "noShowCount"
        FROM c
        JOIN "patients" pa
          ON pa."tenantId" = ${p.tenantId}::uuid AND pa."id" = c."patientId"
         AND pa."deletedAt" IS NULL
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS "n", max(ov."visitDate") AS "last"
            FROM "ortho_visits" ov
           WHERE ov."tenantId" = ${p.tenantId}::uuid
             AND ov."patientId" = c."patientId" AND ov."caseId" = c."id"
        ) vs
        CROSS JOIN LATERAL (
          SELECT min(a."start") AS "next"
            FROM "appointments" a
           WHERE a."tenantId" = ${p.tenantId}::uuid
             AND a."patientId" = c."patientId"
             AND a."deletedAt" IS NULL
             AND a."status" IN ${LIVE_STATUSES}
             AND (
               (a."status" IN ('SCHEDULED', 'CONFIRMED') AND a."start" > ${p.now})
               OR a."status" IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')
             )
        ) na
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS "n"
            FROM "appointments" a
           WHERE a."tenantId" = ${p.tenantId}::uuid
             AND a."patientId" = c."patientId"
             AND a."deletedAt" IS NULL
             AND a."status" = 'NO_SHOW'
             -- Desde el primer instante del día de inicio en la zona de la sede.
             AND a."start" >= ((c."startDate"::timestamp AT TIME ZONE c."zone") AT TIME ZONE 'UTC')
        ) ns
    ),
    f AS MATERIALIZED (
      SELECT d.* FROM d WHERE true ${filter}
    ),
    page AS (
      SELECT f.* FROM f
       ORDER BY ${order(Prisma.raw('f'))}
       LIMIT ${p.pageSize} OFFSET ${offset}
    )
    SELECT t."total", pg.*, u."fullName" AS "providerName"
      FROM (SELECT count(*)::int AS "total" FROM f) t
      LEFT JOIN page pg ON true
      LEFT JOIN "clinic_memberships" m
        ON m."tenantId" = ${p.tenantId}::uuid AND m."userId" = pg."providerId"
      LEFT JOIN "users" u ON u."id" = m."userId"
     ORDER BY ${order(Prisma.raw('pg'))}`;
}

@Injectable()
export class PrismaOrthoRepository implements OrthoRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const id = this.tenantContext.getTenantId();
    if (!id) throw new Error('No tenant in context');
    return id;
  }

  // -- Ajustes (tabla global `tenants`, sin RLS: siempre por el id del contexto)

  async getSettings(): Promise<OrthoSettings> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: {
        orthodonticsEnabled: true,
        orthoWireGauges: true,
        orthoOverdueDays: true,
      },
    });
    return {
      enabled: tenant.orthodonticsEnabled,
      wireGauges: tenant.orthoWireGauges,
      overdueDays: tenant.orthoOverdueDays,
    };
  }

  async setSettings(
    next: OrthoSettings,
  ): Promise<{ before: OrthoSettings; after: OrthoSettings }> {
    const id = this.tenantId();
    // Fila bloqueada: dos ADMIN a la vez no se pisan el «antes» de la auditoría.
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<
        { enabled: boolean; gauges: string[]; overdueDays: number }[]
      >`SELECT "orthodonticsEnabled" AS enabled, "orthoWireGauges" AS gauges,
               "orthoOverdueDays"::int AS "overdueDays"
          FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const after = await tx.tenant.update({
        where: { id },
        data: {
          orthodonticsEnabled: next.enabled,
          orthoWireGauges: next.wireGauges,
          orthoOverdueDays: next.overdueDays,
        },
        select: {
          orthodonticsEnabled: true,
          orthoWireGauges: true,
          orthoOverdueDays: true,
        },
      });
      return {
        before: {
          enabled: locked.enabled,
          wireGauges: locked.gauges,
          overdueDays: locked.overdueDays,
        },
        after: {
          enabled: after.orthodonticsEnabled,
          wireGauges: after.orthoWireGauges,
          overdueDays: after.orthoOverdueDays,
        },
      };
    });
  }

  // -- Contexto

  today(now: Date, locationId?: string): Promise<string> {
    return this.prisma.runWithTenant(async (tx) => {
      const id = locationId ?? (await this.tenantContext.writeLocationId(tx));
      const location = await tx.location.findFirstOrThrow({
        where: { id },
        select: { id: true, timeZone: true },
      });
      return civilDateIn(now, requireLocationTimeZone(location));
    });
  }

  writeLocationId(): Promise<string> {
    return this.prisma.runWithTenant((tx) =>
      this.tenantContext.writeLocationId(tx),
    );
  }

  async locationExists(locationId: string): Promise<boolean> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.location.findFirst({
        where: { id: locationId, deletedAt: null, isActive: true },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  async memberRole(userId: string): Promise<string | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.clinicMembership.findFirst({
        where: { userId, deletedAt: null },
        select: { role: true },
      }),
    );
    return row?.role ?? null;
  }

  async planOfPatient(patientId: string, planId: string): Promise<boolean> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.treatmentPlan.findFirst({
        where: { id: planId, patientId, deletedAt: null },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  // -- Casos

  async findCase(
    patientId: string,
    caseId: string,
  ): Promise<OrthoCaseRecord | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.orthoCase.findFirst({ where: { id: caseId, patientId } }),
    );
    return row ? mapCase(row) : null;
  }

  listCases(patientId: string, now: Date): Promise<OrthoCaseView[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.orthoCase.findMany({
        where: { patientId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          location: { select: { id: true, name: true, timeZone: true } },
        },
      });
      if (rows.length === 0) return [];
      // Los controles de TODOS los casos del paciente en una lectura (pocos
      // por caso), del más reciente al más antiguo.
      const visits = await tx.orthoVisit.findMany({
        where: { patientId, caseId: { in: rows.map((r) => r.id) } },
        orderBy: [{ visitDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: {
          caseId: true,
          visitDate: true,
          upperWireMaterial: true,
          upperWireGauge: true,
          lowerWireMaterial: true,
          lowerWireGauge: true,
          nextVisitProposedOn: true,
        },
      });
      const names = await memberNames(
        tx,
        rows.flatMap((r) => [r.providerId, r.statusChangedById]),
      );
      return rows.map((row) => {
        const record = mapCase(row);
        const own = visits.filter((v) => v.caseId === row.id);
        const last = own[0] ?? null;
        const upper = own.find((v) => v.upperWireMaterial && v.upperWireGauge);
        const lower = own.find((v) => v.lowerWireMaterial && v.lowerWireGauge);
        const today = civilDateIn(now, requireLocationTimeZone(row.location));
        const lastVisitDate = last ? day(last.visitDate) : null;
        return {
          ...record,
          locationName: row.location.name,
          providerName: names.get(row.providerId) ?? null,
          statusChangedByName: row.statusChangedById
            ? (names.get(row.statusChangedById) ?? null)
            : null,
          progress: caseProgress(record, own.length, today),
          currentUpperWire: upper
            ? wireOf(upper.upperWireMaterial, upper.upperWireGauge)
            : null,
          currentLowerWire: lower
            ? wireOf(lower.lowerWireMaterial, lower.lowerWireGauge)
            : null,
          lastVisitDate,
          nextVisitProposedOn: last
            ? dayOrNull(last.nextVisitProposedOn)
            : null,
          overdue:
            record.status === 'ACTIVE' &&
            isOverdue(
              lastVisitDate,
              record.startDate,
              record.visitIntervalDays,
              today,
            ),
        };
      });
    });
  }

  async createCase(
    input: CreateOrthoCaseRepoInput,
  ): Promise<OrthoCaseRecord | null> {
    const tenantId = this.tenantId();
    try {
      const row = await this.prisma.runWithTenant((tx) =>
        tx.orthoCase.create({
          data: {
            tenantId,
            patientId: input.patientId,
            locationId: input.locationId,
            providerId: input.providerId,
            treatmentPlanId: input.treatmentPlanId,
            technique: input.technique,
            startDate: dateOf(input.startDate),
            estimatedMonths: input.estimatedMonths,
            plannedVisits: input.plannedVisits,
            visitIntervalDays: input.visitIntervalDays,
            bondedOn: dateOrNull(input.bondedOn),
            debondedOn: dateOrNull(input.debondedOn),
            createdById: input.createdById,
          },
        }),
      );
      return mapCase(row);
    } catch (error) {
      // El único parcial decide entre dos altas a la vez: la segunda, 409.
      if (isOneActiveViolation(error)) return null;
      throw error;
    }
  }

  async updateCase(
    caseId: string,
    input: UpdateOrthoCaseRepoInput,
  ): Promise<OrthoCaseRecord> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.orthoCase.update({
        where: { id: caseId },
        data: {
          technique: input.plan.technique,
          startDate: dateOf(input.plan.startDate),
          estimatedMonths: input.plan.estimatedMonths,
          plannedVisits: input.plan.plannedVisits,
          visitIntervalDays: input.plan.visitIntervalDays,
          bondedOn: dateOrNull(input.plan.bondedOn),
          debondedOn: dateOrNull(input.plan.debondedOn),
          providerId: input.providerId,
          treatmentPlanId: input.treatmentPlanId,
        },
      }),
    );
    return mapCase(row);
  }

  async changeStatus(
    caseId: string,
    input: OrthoStatusChangeRepoInput,
  ): Promise<OrthoCaseRecord | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // Condicional al estado leído: dos cambios a la vez no se pisan.
      const { count } = await tx.orthoCase.updateMany({
        where: { id: caseId, status: input.from },
        data: {
          status: input.to,
          statusReason: input.reason,
          statusChangedAt: new Date(),
          statusChangedById: input.actorId,
        },
      });
      if (count === 0) return null;
      const row = await tx.orthoCase.findUniqueOrThrow({
        where: { id: caseId },
      });
      // DX-285: el retiro se realiza al pasar a retención o finalizar.
      if (input.to === 'RETENTION' || input.to === 'FINISHED') {
        await realizeRetentionIn(tx, this.tenantId(), {
          caseId,
          authorId: input.actorId,
          locationId: row.locationId,
        });
      }
      return mapCase(row);
    });
  }

  // -- Controles

  listVisits(patientId: string, caseId: string): Promise<OrthoVisitView[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.orthoVisit.findMany({
        where: { patientId, caseId },
        orderBy: [{ visitDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        include: VISIT_INCLUDE,
      });
      const names = await memberNames(
        tx,
        rows.flatMap((r) => [
          r.authorId,
          ...r.entry.addenda.map((a) => a.authorId),
        ]),
      );
      // Número de control por orden cronológico; la lista sale al revés.
      return rows.map((row, i) => mapVisit(row, i + 1, names)).reverse();
    });
  }

  async insertVisit(
    tx: Prisma.TransactionClient,
    input: InsertOrthoVisitInput,
  ): Promise<{ id: string } | null> {
    const tenantId = this.tenantId();
    // El caso, bloqueado: un cierre a la vez espera y este control ve el
    // estado final (no entra en un caso que se acaba de finalizar).
    const [locked] = await tx.$queryRaw<{ status: OrthoCase['status'] }[]>`
      SELECT "status" FROM "ortho_cases"
       WHERE "tenantId" = ${tenantId}::uuid AND "patientId" = ${input.patientId}::uuid
         AND "id" = ${input.caseId}::uuid
         FOR UPDATE`;
    if (!locked || !acceptsVisits(locked.status)) return null;
    const row = await tx.orthoVisit.create({
      data: {
        tenantId,
        patientId: input.patientId,
        caseId: input.caseId,
        clinicalEntryId: input.clinicalEntryId,
        visitDate: dateOf(input.visitDate),
        upperWireMaterial: input.upperWire?.material ?? null,
        upperWireGauge: input.upperWire?.gauge ?? null,
        lowerWireMaterial: input.lowerWire?.material ?? null,
        lowerWireGauge: input.lowerWire?.gauge ?? null,
        elasticsType: input.elasticsType,
        elasticsWear: input.elasticsWear,
        applianceChanges: input.applianceChanges,
        incidents: input.incidents,
        hygieneIndex: input.hygieneIndex,
        nextVisitProposedOn: dateOrNull(input.nextVisitProposedOn),
        authorId: input.authorId,
      },
      select: { id: true },
    });
    return row;
  }

  async findVisit(
    patientId: string,
    visitId: string,
  ): Promise<OrthoVisitView | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.orthoVisit.findFirst({
        where: { id: visitId, patientId },
        select: { caseId: true },
      }),
    );
    if (!row) return null;
    const visits = await this.listVisits(patientId, row.caseId);
    return visits.find((v) => v.id === visitId) ?? null;
  }

  // -- Lista de la clínica

  async followUp(
    query: OrthoFollowUpQuery,
  ): Promise<{ rows: OrthoFollowUpRow[]; total: number }> {
    const sql = orthoFollowUpSql({
      ...query,
      tenantId: this.tenantId(),
      // La sede de la cabecera o, sin ella, las permitidas al miembro (DX-089).
      locationIds: this.tenantContext.scopeLocationIds(),
    });
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<FollowUpSqlRow[]>(sql);
      return {
        total: rows[0]?.total ?? 0,
        rows: rows.flatMap((r) =>
          r.caseId === null
            ? []
            : [
                {
                  caseId: r.caseId,
                  patientId: r.patientId,
                  patientFirstName: r.firstName,
                  patientLastName: r.lastName,
                  patientPhone: r.phone,
                  patientPhoneE164: r.phoneE164,
                  locationId: r.locationId,
                  locationName: r.locationName,
                  providerId: r.providerId,
                  providerName: r.providerName,
                  technique: r.technique,
                  startDate: day(r.startDate),
                  visitIntervalDays: r.visitIntervalDays,
                  visitsDone: r.visitsDone,
                  plannedVisits: r.plannedVisits,
                  lastVisitDate: dayOrNull(r.lastVisitDate),
                  daysSinceLastVisit: r.daysSince,
                  overdue:
                    r.daysSince >
                    r.visitIntervalDays + ORTHO_OVERDUE_GRACE_DAYS,
                  nextAppointmentAt: r.nextAppointmentAt,
                  noNextAppointment: r.nextAppointmentAt === null,
                  noShowCount: r.noShowCount,
                },
              ],
        ),
      };
    });
  }

  // -- DX-285: honorario y cuenta

  async feeCurrencySource(caseId: string): Promise<OrthoFeeCurrencySource> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.orthoCase.findFirstOrThrow({
        where: { id: caseId },
        select: {
          treatmentPlan: { select: { currency: true, deletedAt: true } },
          location: { select: { currency: true } },
        },
      }),
    );
    return {
      planCurrency:
        row.treatmentPlan && row.treatmentPlan.deletedAt === null
          ? row.treatmentPlan.currency
          : null,
      locationCurrency: row.location.currency,
    };
  }

  async setFee(
    caseId: string,
    fee: { split: OrthoFeeSplit; currency: string } | null,
    actorId: string,
  ): Promise<OrthoCaseRecord | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // Condicional: un honorario ya aceptado no se toca (la guarda también).
      const { count } = await tx.orthoCase.updateMany({
        where: { id: caseId, feeAcceptedAt: null },
        data: fee
          ? {
              feeCurrency: fee.currency,
              feeTotal: fromCents(fee.split.totalCents),
              feeInitial: fromCents(fee.split.initialCents),
              feePerVisit: fromCents(fee.split.perVisitCents),
              feeVisitCount: fee.split.visitCount,
              feeRetention: fromCents(fee.split.retentionCents),
              feeUpdatedAt: new Date(),
              feeUpdatedById: actorId,
            }
          : {
              feeCurrency: null,
              feeTotal: null,
              feeInitial: null,
              feePerVisit: null,
              feeVisitCount: null,
              feeRetention: null,
              feeUpdatedAt: new Date(),
              feeUpdatedById: actorId,
            },
      });
      if (count === 0) return null;
      return mapCase(
        await tx.orthoCase.findUniqueOrThrow({ where: { id: caseId } }),
      );
    });
  }

  acceptFee(input: AcceptOrthoFeeInput): Promise<AcceptOrthoFeeOutcome> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant((tx) => acceptFeeIn(tx, tenantId, input));
  }

  accountFacts(
    patientId: string,
    caseId: string,
    now: Date,
  ): Promise<OrthoAccountFacts | null> {
    const tenantId = this.tenantId();
    // Una foto: los cargos, lo imputado y los controles casan entre sí.
    return this.prisma.runWithTenant(
      (tx) => accountFactsIn(tx, tenantId, { patientId, caseId, now }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async casesWithFee(patientId: string): Promise<OrthoCaseRecord[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.orthoCase.findMany({
        where: { patientId, feeTotal: { not: null } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    return rows.map(mapCase);
  }

  realizeVisitCharge(
    tx: Prisma.TransactionClient,
    input: { caseId: string; visitId: string; authorId: string },
  ): Promise<void> {
    return realizeVisitChargeIn(tx, this.tenantId(), input);
  }

  overdueFlags(
    patientIds: readonly string[],
    now: Date,
  ): Promise<Map<string, OrthoBalanceFlag>> {
    if (patientIds.length === 0) {
      return Promise.resolve(new Map<string, OrthoBalanceFlag>());
    }
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant((tx) =>
      overdueFlagsIn(tx, tenantId, patientIds, now),
    );
  }

  // -- DX-285: alineadores

  listAlignerSeries(
    caseId: string,
    today: string,
  ): Promise<OrthoAlignerSeriesView[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.orthoAlignerSeries.findMany({
        where: { caseId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          deliveries: {
            orderBy: [{ fromTray: 'asc' }],
            select: {
              id: true,
              fromTray: true,
              toTray: true,
              deliveredOn: true,
              visitId: true,
              createdById: true,
              createdAt: true,
            },
          },
        },
      });
      const names = await memberNames(
        tx,
        rows.flatMap((r) => [
          r.createdById,
          ...r.deliveries.map((d) => d.createdById),
        ]),
      );
      return alignerSeriesViews(rows, names, today);
    });
  }

  async seriesOfCase(caseId: string, seriesId: string): Promise<boolean> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.orthoAlignerSeries.findFirst({
        where: { id: seriesId, caseId },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  async visitOfCase(
    caseId: string,
    visitId: string,
  ): Promise<{ visitDate: string } | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.orthoVisit.findFirst({
        where: { id: visitId, caseId },
        select: { visitDate: true },
      }),
    );
    return row ? { visitDate: day(row.visitDate) } : null;
  }

  async createAlignerSeries(
    input: CreateAlignerSeriesInput,
  ): Promise<{ id: string }> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant((tx) =>
      tx.orthoAlignerSeries.create({
        data: { tenantId, ...input },
        select: { id: true },
      }),
    );
  }

  addAlignerDelivery(
    input: AddAlignerDeliveryInput,
  ): Promise<AddAlignerDeliveryOutcome> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant((tx) =>
      addAlignerDeliveryIn(tx, tenantId, input),
    );
  }
}
