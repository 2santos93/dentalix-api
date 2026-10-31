import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type AppointmentStatus,
  type ToothSurface,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { inPeriod } from '../../reports/infrastructure/zoned-period-sql';
import {
  DismissalExistsError,
  type ClosingAppointmentRef,
  type ClosingAppointmentRow,
  type ClosingLocation,
  type ClosingQueueRepository,
  type ClosingScope,
  type ClosingTreatmentRow,
  type DismissalRecord,
  type SectionPage,
} from '../domain/ports/closing-queue-repository.port';

interface AppointmentSqlRow {
  appointmentId: string;
  patientId: string;
  firstName: string;
  lastName: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  locationId: string;
  locationName: string;
  timeZone: string;
  professionalId: string;
  professionalName: string | null;
  total: bigint;
}

interface TreatmentSqlRow extends AppointmentSqlRow {
  planId: string;
  planItemId: string;
  procedureCode: string;
  procedureLabel: string;
  toothNumber: string;
  surfaces: ToothSurface[];
}

/** Columnas comunes de una fila de la lista (sin notas ni motivo de la cita). */
const APPOINTMENT_COLUMNS = Prisma.sql`
  a."id" AS "appointmentId", a."patientId", p."firstName", p."lastName",
  a."start", a."end", a."status", a."locationId", l."name" AS "locationName",
  l."timeZone", a."providerId" AS "professionalId", u."fullName" AS "professionalName",
  count(*) OVER () AS "total"`;

const APPOINTMENT_JOINS = Prisma.sql`
  JOIN "patients" p ON p."tenantId" = a."tenantId" AND p."id" = a."patientId"
  JOIN "locations" l ON l."tenantId" = a."tenantId" AND l."id" = a."locationId"
  LEFT JOIN "users" u ON u."id" = a."providerId"`;

function toAppointment(row: AppointmentSqlRow): ClosingAppointmentRow {
  return {
    appointmentId: row.appointmentId,
    patientId: row.patientId,
    patientName: `${row.firstName} ${row.lastName}`.trim(),
    start: row.start,
    end: row.end,
    status: row.status,
    locationId: row.locationId,
    locationName: row.locationName,
    timeZone: row.timeZone,
    professionalId: row.professionalId,
    professionalName: row.professionalName,
  };
}

function page<T, R extends { total: bigint }>(
  rows: R[],
  map: (row: R) => T,
): SectionPage<T> {
  return { rows: rows.map(map), total: Number(rows[0]?.total ?? 0n) };
}

/**
 * Las lecturas de «Pendiente de cerrar» (DX-439) bajo RLS (dentalix_app con la
 * clínica fijada por runWithTenant) y con `tenantId` explícito además. Las
 * tres secciones parten de la misma ventana de citas vivas por sede y zona,
 * que sirven `appointments_tenant_start_live_idx` (por clínica) o
 * `appointments_tenantId_providerId_start_idx` (por profesional).
 */
@Injectable()
export class PrismaClosingQueueRepository implements ClosingQueueRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /** Ventana, profesional y cita concreta: lo común a las tres secciones. */
  private window(tenantId: string, scope: ClosingScope): Prisma.Sql {
    return Prisma.sql`a."tenantId" = ${tenantId}::uuid
       AND a."deletedAt" IS NULL
       AND p."deletedAt" IS NULL
       AND ${inPeriod(Prisma.sql`a."locationId"`, Prisma.sql`a."start"`, scope.branches)}
       ${scope.professionalId !== undefined ? Prisma.sql`AND a."providerId" = ${scope.professionalId}::uuid` : Prisma.empty}
       ${scope.appointmentId !== undefined ? Prisma.sql`AND a."id" = ${scope.appointmentId}::uuid` : Prisma.empty}`;
  }

  private notDismissed(
    section: 'OUTCOME' | 'EVOLUTION' | 'TREATMENT',
    planItem: Prisma.Sql | null,
  ): Prisma.Sql {
    return Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "closing_queue_dismissals" d
       WHERE d."tenantId" = a."tenantId"
         AND d."section" = ${section}::"ClosingQueueSection"
         AND d."appointmentId" = a."id"
         AND ${planItem === null ? Prisma.sql`d."planItemId" IS NULL` : Prisma.sql`d."planItemId" = ${planItem}`})`;
  }

  async listLocations(allowed: AllowedLocations): Promise<ClosingLocation[]> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant((tx) =>
      tx.location.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(allowed === 'ALL' ? {} : { id: { in: [...allowed] } }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, timeZone: true },
      }),
    );
  }

  async outcome(
    scope: ClosingScope,
    limit: number,
  ): Promise<SectionPage<ClosingAppointmentRow>> {
    const tenantId = this.requireTenantId();
    const rows = await this.prisma.runWithTenant(
      (tx) => tx.$queryRaw<AppointmentSqlRow[]>`
      SELECT ${APPOINTMENT_COLUMNS}
        FROM "appointments" a
        ${APPOINTMENT_JOINS}
       WHERE ${this.window(tenantId, scope)}
         AND a."status" IN ('SCHEDULED', 'CONFIRMED')
         AND ${this.notDismissed('OUTCOME', null)}
       ORDER BY a."start", a."id"
       LIMIT ${limit}`,
    );
    return page(rows, toAppointment);
  }

  async evolution(
    scope: ClosingScope,
    limit: number,
  ): Promise<SectionPage<ClosingAppointmentRow>> {
    const tenantId = this.requireTenantId();
    // Una evolución anulada (borrada en blando) no cuenta como evolución.
    const rows = await this.prisma.runWithTenant(
      (tx) => tx.$queryRaw<AppointmentSqlRow[]>`
      SELECT ${APPOINTMENT_COLUMNS}
        FROM "appointments" a
        ${APPOINTMENT_JOINS}
       WHERE ${this.window(tenantId, scope)}
         AND a."status" = 'COMPLETED'
         AND NOT EXISTS (
           SELECT 1 FROM "clinical_entries" e
            WHERE e."tenantId" = a."tenantId"
              AND e."patientId" = a."patientId"
              AND e."appointmentId" = a."id"
              AND e."deletedAt" IS NULL)
         AND ${this.notDismissed('EVOLUTION', null)}
       ORDER BY a."start", a."id"
       LIMIT ${limit}`,
    );
    return page(rows, toAppointment);
  }

  async treatment(
    scope: ClosingScope,
    limit: number,
  ): Promise<SectionPage<ClosingTreatmentRow>> {
    const tenantId = this.requireTenantId();
    // El vínculo de una cita COMPLETED nunca está `active` (DX-256: `active`
    // es la RESERVA, y una atendida ya no reserva) ni se puede retirar
    // (DX-271): es lo que se hizo en esa visita. El ítem es de ESTA cita
    // mientras su vínculo siga vivo y ninguna otra cita viva lo tenga: ni
    // reservado ahora (p. ej. se pasó a la próxima visita) ni
    // atendido después (sale solo en la última atendida). Ítem y plan vivos.
    const rows = await this.prisma.runWithTenant(
      (tx) => tx.$queryRaw<TreatmentSqlRow[]>`
      SELECT ${APPOINTMENT_COLUMNS},
             i."planId", i."id" AS "planItemId", c."code" AS "procedureCode",
             c."labelEs" AS "procedureLabel", i."toothNumber", i."surfaces"
        FROM "appointments" a
        ${APPOINTMENT_JOINS}
        JOIN "appointment_plan_items" ap
          ON ap."tenantId" = a."tenantId" AND ap."appointmentId" = a."id"
         AND ap."deletedAt" IS NULL
        JOIN "treatment_plan_items" i
          ON i."tenantId" = ap."tenantId" AND i."id" = ap."planItemId"
         AND i."status" = 'ACCEPTED' AND i."deletedAt" IS NULL
        JOIN "treatment_plans" tp
          ON tp."tenantId" = i."tenantId" AND tp."id" = i."planId"
         AND tp."deletedAt" IS NULL AND tp."status" IN ('ACCEPTED', 'PRESENTED', 'DRAFT')
        JOIN "dental_catalog_items" c
          ON c."tenantId" = i."tenantId" AND c."id" = i."catalogItemId"
       WHERE ${this.window(tenantId, scope)}
         AND a."status" = 'COMPLETED'
         AND NOT EXISTS (
           SELECT 1 FROM "appointment_plan_items" other
             JOIN "appointments" a2
               ON a2."tenantId" = other."tenantId" AND a2."id" = other."appointmentId"
            WHERE other."tenantId" = ap."tenantId"
              AND other."planItemId" = ap."planItemId"
              AND other."appointmentId" <> a."id"
              AND other."deletedAt" IS NULL
              AND a2."deletedAt" IS NULL
              -- La reserva REAL, con la misma condición que el trigger
              -- dx256_link_reservation: la columna "active" solo se
              -- recalcula al escribir y puede haber vencido con el reloj.
              AND ((a2."status" IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')
                    OR (a2."status" IN ('SCHEDULED', 'CONFIRMED')
                        AND a2."start" >= timezone('UTC', now())))
                   OR (a2."status" = 'COMPLETED'
                       AND (a2."start", a2."id") > (a."start", a."id"))))
         ${scope.planItemId !== undefined ? Prisma.sql`AND i."id" = ${scope.planItemId}::uuid` : Prisma.empty}
         AND ${this.notDismissed('TREATMENT', Prisma.sql`i."id"`)}
       ORDER BY a."start", a."id", i."id"
       LIMIT ${limit}`,
    );
    return page(rows, (row) => ({
      ...toAppointment(row),
      planId: row.planId,
      planItemId: row.planItemId,
      procedureCode: row.procedureCode,
      procedureLabel: row.procedureLabel,
      toothNumber: row.toothNumber,
      surfaces: row.surfaces,
    }));
  }

  async staleInClinic(scope: ClosingScope): Promise<number> {
    const tenantId = this.requireTenantId();
    const [row] = await this.prisma.runWithTenant(
      (tx) => tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS "count"
        FROM "appointments" a
        JOIN "patients" p ON p."tenantId" = a."tenantId" AND p."id" = a."patientId"
       WHERE ${this.window(tenantId, scope)}
         AND a."status" IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')`,
    );
    return Number(row?.count ?? 0n);
  }

  async findAppointment(id: string): Promise<ClosingAppointmentRef | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant((tx) =>
      tx.appointment.findFirst({
        where: { tenantId, id, deletedAt: null },
        select: {
          id: true,
          patientId: true,
          locationId: true,
          providerId: true,
        },
      }),
    );
  }

  async createDismissal(
    record: DismissalRecord,
    ctx: AuditRequestContext,
  ): Promise<{ id: string; createdAt: Date }> {
    const tenantId = this.requireTenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const saved = await tx.closingQueueDismissal.create({
          data: {
            tenantId,
            section: record.section,
            patientId: record.patientId,
            appointmentId: record.appointmentId,
            planItemId: record.planItemId,
            reasonCode: record.reasonCode,
            reasonText: record.reasonText,
            createdById: ctx.actor.userId,
          },
          select: { id: true, createdAt: true },
        });
        await writeAuditEvent(tx, {
          tenantId,
          locationId: record.locationId,
          actor: {
            kind: 'user',
            userId: ctx.actor.userId,
            role: ctx.actor.role,
          },
          action: 'CREATE',
          resourceType: 'CLOSING_QUEUE_DISMISSAL',
          resourceId: saved.id,
          patient: { kind: 'patient', id: record.patientId },
          requestId: ctx.requestId,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          metadata: {
            reason: 'CLOSING_QUEUE_DISMISSED',
            params: {
              appointmentId: record.appointmentId,
              ...(record.planItemId !== null
                ? { planItemId: record.planItemId }
                : {}),
            },
            closingQueueDismissal: {
              section: record.section,
              reasonCode: record.reasonCode,
            },
          },
        });
        return saved;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new DismissalExistsError();
      }
      throw err;
    }
  }
}
