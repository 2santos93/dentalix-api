import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type AppointmentStatus,
  type CancellationReasonCode,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import { loadPeriodLocationZones } from '../../../shared/locations/location-time-zone';
import {
  civilPeriodByZone,
  type ZonedPeriodBranch,
} from '../../../shared/time/civil-day';
import type { CivilPeriod } from '../domain/comparison-period';
import type {
  MissedAppointmentRow,
  ProfessionalAttendance,
  ProfessionalPeriodSums,
  ProfessionalReportLocation,
  ProfessionalReportOption,
  ProfessionalReportScope,
  ProfessionalReportsRepository,
} from '../domain/ports/professional-reports-repository.port';
import { inPeriod, periodWindow, utcTimestamp } from './zoned-period-sql';

interface ProducedRow {
  professionalId: string;
  currency: string;
  count: bigint;
  net: Prisma.Decimal | null;
}

interface CollectedRow {
  professionalId: string;
  currency: string;
  amount: Prisma.Decimal | null;
}

interface AttendanceRow {
  professionalId: string;
  completed: bigint;
  noShow: bigint;
  lateCancellations: bigint;
}

interface MissedSqlRow {
  appointmentId: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  cancelReasonCode: CancellationReasonCode | null;
  noticeMinutes: number | null;
  patientId: string;
  patientName: string;
  patientArchived: boolean;
  appointmentTypeName: string | null;
  professionalId: string;
  professionalName: string | null;
  locationId: string;
  locationName: string;
  timeZone: string;
  total: bigint;
}

const dec = (value: Prisma.Decimal | null) => value?.toNumber() ?? 0;

/** Ítem realizado vivo de un plan vivo con quien lo realizó (DX-050). */
const ATTRIBUTED_DONE = Prisma.sql`i."status" = 'DONE'
   AND i."deletedAt" IS NULL
   AND p."deletedAt" IS NULL
   AND i."performedById" IS NOT NULL`;

/** Abono vivo: ni retirado ni anulado. */
const LIVE_PAYMENT = Prisma.sql`py."deletedAt" IS NULL AND py."voidedAt" IS NULL`;

/** Las citas que entran en el no-show % (kpi-definitions, DX-279). */
const COUNTED_APPOINTMENT = Prisma.sql`a."deletedAt" IS NULL
   AND (a."status" IN ('COMPLETED', 'NO_SHOW')
        OR (a."status" = 'CANCELLED' AND a."lateCancellation" IS TRUE))`;

/** Las que la lista de «Inasistencias» enseña. */
const MISSED_APPOINTMENT = Prisma.sql`a."deletedAt" IS NULL
   AND (a."status" = 'NO_SHOW'
        OR (a."status" = 'CANCELLED' AND a."lateCancellation" IS TRUE))`;

const byProfessional = (column: Prisma.Sql, professionalId?: string) =>
  professionalId !== undefined
    ? Prisma.sql`AND ${column} = ${professionalId}::uuid`
    : Prisma.empty;

/**
 * «Profesionales» e «Inasistencias» (DX-304). Cada fuente es UNA consulta
 * agregada (GROUP BY profesional[, moneda]) con el tenant explícito además de
 * la RLS, sin consultas por fila:
 *  - producción: ítems DONE con quien los realizó, por `completedAt` en la
 *    zona de la sede donde se realizaron; índice parcial de los DONE por
 *    (tenantId, completedAt) de DX-014;
 *  - cobrado: imputaciones (DX-051) de abonos vivos por `paidAt` a esos
 *    ítems, en la moneda del plan; `payments_tenantId_paidAt_active_idx` y la
 *    única (tenantId, paymentId, ítem) de las imputaciones;
 *  - citas: por profesional de la cita y `start` en la zona de su sede;
 *    `appointments_tenant_location_start_idx`.
 * Todas en una transacción REPEATABLE READ: la misma foto.
 */
@Injectable()
export class PrismaProfessionalReportsRepository implements ProfessionalReportsRepository {
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
  ): Promise<ProfessionalReportLocation[]> {
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
  ): Promise<ProfessionalReportOption[]> {
    const tenantId = this.requireTenantId();
    const ids = [...locationIds];
    if (ids.length === 0) return [];
    // Por las membresías (también retiradas) con dos EXISTS que paran en la
    // primera fila: (tenantId, providerId, start) de las citas y el índice de
    // quien realizó el ítem.
    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<ProfessionalReportOption[]>`
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
                  SELECT 1 FROM "treatment_plan_items" i
                   WHERE i."tenantId" = m."tenantId"
                     AND i."performedByMembershipId" = m."id"
                     AND i."performedById" = m."userId"
                     AND i."status" = 'DONE'
                     AND i."deletedAt" IS NULL
                     AND i."performedLocationId" = ANY(${ids}::uuid[])))`,
    );
    const unique = new Map(rows.map((r) => [r.userId, r]));
    return [...unique.values()].sort((a, b) =>
      a.fullName.localeCompare(b.fullName, 'es', { sensitivity: 'base' }),
    );
  }

  /**
   * Las ramas por zona del período para esas sedes (DX-097). Una sede sin
   * zona y sin citas ni realizados se ignora; con ellos, 409 (G1).
   */
  private async branches(
    tx: Prisma.TransactionClient,
    tenantId: string,
    period: CivilPeriod,
    locationIds: readonly string[],
  ): Promise<ZonedPeriodBranch[]> {
    const zones = await loadPeriodLocationZones(
      tx,
      tenantId,
      locationIds,
      async (ids) => {
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
      },
    );
    return civilPeriodByZone(period.from, period.to, zones.configured);
  }

  private attendanceQuery(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branches: readonly ZonedPeriodBranch[],
    scope: ProfessionalReportScope,
  ): Promise<AttendanceRow[]> {
    const window = periodWindow(branches);
    return tx.$queryRaw<AttendanceRow[]>`
      SELECT a."providerId" AS "professionalId",
             count(*) FILTER (WHERE a."status" = 'COMPLETED') AS "completed",
             count(*) FILTER (WHERE a."status" = 'NO_SHOW') AS "noShow",
             count(*) FILTER (WHERE a."status" = 'CANCELLED') AS "lateCancellations"
        FROM "appointments" a
       WHERE a."tenantId" = ${tenantId}::uuid
         AND ${COUNTED_APPOINTMENT}
         AND a."start" >= ${utcTimestamp(window.start)}
         AND a."start" < ${utcTimestamp(window.end)}
         AND ${inPeriod(Prisma.sql`a."locationId"`, Prisma.sql`a."start"`, branches)}
         ${byProfessional(Prisma.sql`a."providerId"`, scope.professionalId)}
       GROUP BY 1`;
  }

  async sums(
    period: CivilPeriod,
    scope: ProfessionalReportScope,
  ): Promise<ProfessionalPeriodSums> {
    const tenantId = this.requireTenantId();
    const empty: ProfessionalPeriodSums = {
      production: [],
      collected: [],
      attendance: [],
      names: new Map(),
    };
    if (scope.locationIds.length === 0) return empty;
    return this.prisma.runWithTenant(
      async (tx) => {
        const branches = await this.branches(
          tx,
          tenantId,
          period,
          scope.locationIds,
        );
        if (branches.length === 0) return empty;
        const window = periodWindow(branches);
        const produced = await tx.$queryRaw<ProducedRow[]>`
          SELECT i."performedById" AS "professionalId", p."currency",
                 count(*) AS "count", sum(i."price" - i."discount") AS "net"
            FROM "treatment_plan_items" i
            JOIN "treatment_plans" p
              ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
           WHERE i."tenantId" = ${tenantId}::uuid
             AND ${ATTRIBUTED_DONE}
             ${byProfessional(Prisma.sql`i."performedById"`, scope.professionalId)}
             AND i."completedAt" >= ${utcTimestamp(window.start)}
             AND i."completedAt" < ${utcTimestamp(window.end)}
             AND ${inPeriod(Prisma.sql`i."performedLocationId"`, Prisma.sql`i."completedAt"`, branches)}
           GROUP BY 1, 2`;
        // Lo imputado a sus ítems realizados desde abonos del período. El
        // ítem puede haberse realizado en otro período: cuenta el día del
        // abono, en la zona de la sede donde se realizó.
        const collected = await tx.$queryRaw<CollectedRow[]>`
          SELECT i."performedById" AS "professionalId", p."currency",
                 sum(al."amount") AS "amount"
            FROM "payments" py
            JOIN "payment_allocations" al
              ON al."tenantId" = py."tenantId" AND al."paymentId" = py."id"
            JOIN "treatment_plan_items" i
              ON i."tenantId" = al."tenantId" AND i."id" = al."treatmentPlanItemId"
            JOIN "treatment_plans" p
              ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
           WHERE py."tenantId" = ${tenantId}::uuid
             AND ${LIVE_PAYMENT}
             AND py."paidAt" >= ${utcTimestamp(window.start)}
             AND py."paidAt" < ${utcTimestamp(window.end)}
             AND al."amount" <> 0
             AND ${ATTRIBUTED_DONE}
             ${byProfessional(Prisma.sql`i."performedById"`, scope.professionalId)}
             AND ${inPeriod(Prisma.sql`i."performedLocationId"`, Prisma.sql`py."paidAt"`, branches)}
           GROUP BY 1, 2`;
        const attendance = await this.attendanceQuery(
          tx,
          tenantId,
          branches,
          scope,
        );
        const ids = [
          ...new Set([
            ...produced.map((r) => r.professionalId),
            ...collected.map((r) => r.professionalId),
            ...attendance.map((r) => r.professionalId),
          ]),
        ];
        const users =
          ids.length === 0
            ? []
            : await tx.$queryRaw<{ id: string; fullName: string }[]>`
          SELECT u."id", u."fullName" FROM "users" u
           WHERE u."id" = ANY(${ids}::uuid[])`;
        return {
          production: produced.map((r) => ({
            professionalId: r.professionalId,
            currency: r.currency,
            count: Number(r.count),
            net: dec(r.net),
          })),
          collected: collected.map((r) => ({
            professionalId: r.professionalId,
            currency: r.currency,
            amount: dec(r.amount),
          })),
          attendance: attendance.map(toAttendance),
          names: new Map(users.map((u) => [u.id, u.fullName])),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async attendance(
    period: CivilPeriod,
    scope: ProfessionalReportScope,
  ): Promise<ProfessionalAttendance[]> {
    const tenantId = this.requireTenantId();
    if (scope.locationIds.length === 0) return [];
    return this.prisma.runWithTenant(async (tx) => {
      const branches = await this.branches(
        tx,
        tenantId,
        period,
        scope.locationIds,
      );
      if (branches.length === 0) return [];
      const rows = await this.attendanceQuery(tx, tenantId, branches, scope);
      return rows.map(toAttendance);
    });
  }

  async listMissed(
    period: CivilPeriod,
    scope: ProfessionalReportScope,
    page: { skip: number; take: number },
  ): Promise<{ items: MissedAppointmentRow[]; total: number }> {
    const tenantId = this.requireTenantId();
    if (scope.locationIds.length === 0) return { items: [], total: 0 };
    return this.prisma.runWithTenant(
      async (tx) => {
        const branches = await this.branches(
          tx,
          tenantId,
          period,
          scope.locationIds,
        );
        if (branches.length === 0) return { items: [], total: 0 };
        const window = periodWindow(branches);
        const select = (paging: Prisma.Sql) => tx.$queryRaw<MissedSqlRow[]>`
          SELECT a."id" AS "appointmentId", a."start", a."end", a."status",
                 a."cancelReasonCode", a."noticeMinutes",
                 pt."id" AS "patientId",
                 btrim(pt."firstName" || ' ' || pt."lastName") AS "patientName",
                 (pt."deletedAt" IS NOT NULL) AS "patientArchived",
                 ty."name" AS "appointmentTypeName",
                 a."providerId" AS "professionalId", u."fullName" AS "professionalName",
                 a."locationId", lo."name" AS "locationName", lo."timeZone",
                 count(*) OVER () AS "total"
            FROM "appointments" a
            JOIN "locations" lo
              ON lo."tenantId" = a."tenantId" AND lo."id" = a."locationId"
            JOIN "patients" pt
              ON pt."tenantId" = a."tenantId" AND pt."id" = a."patientId"
            LEFT JOIN "appointment_types" ty
              ON ty."tenantId" = a."tenantId" AND ty."id" = a."appointmentTypeId"
            LEFT JOIN "users" u ON u."id" = a."providerId"
           WHERE a."tenantId" = ${tenantId}::uuid
             AND ${MISSED_APPOINTMENT}
             AND a."start" >= ${utcTimestamp(window.start)}
             AND a."start" < ${utcTimestamp(window.end)}
             AND ${inPeriod(Prisma.sql`a."locationId"`, Prisma.sql`a."start"`, branches)}
             ${byProfessional(Prisma.sql`a."providerId"`, scope.professionalId)}
           ORDER BY a."start" DESC, a."id" DESC
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
            kind: r.status === 'NO_SHOW' ? 'NO_SHOW' : 'LATE_CANCELLATION',
            cancelReasonCode: r.cancelReasonCode,
            noticeMinutes: r.noticeMinutes,
            patientId: r.patientId,
            patientName: r.patientName,
            patientArchived: r.patientArchived,
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

function toAttendance(r: AttendanceRow): ProfessionalAttendance {
  return {
    professionalId: r.professionalId,
    completed: Number(r.completed),
    noShow: Number(r.noShow),
    lateCancellations: Number(r.lateCancellations),
  };
}
