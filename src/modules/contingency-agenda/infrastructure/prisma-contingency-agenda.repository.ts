import { Injectable } from '@nestjs/common';
import { Prisma, type AppointmentStatus } from '@prisma/client';
import { isHourCycle } from '../../../shared/locations/location-regional';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { isValidTimeZone } from '../../../shared/time/civil-day';
import type {
  ContingencyAgendaRepository,
  ContingencyAppointmentRow,
  ContingencyLocation,
  ContingencySnapshot,
  NightlyCandidate,
} from '../domain/ports/contingency-agenda-repository.port';

interface AppointmentSqlRow {
  appointmentId: string;
  patientId: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  firstName: string;
  lastName: string;
  phone: string | null;
  professionalName: string | null;
  appointmentTypeName: string | null;
  firstVisit: boolean;
  callbackRequested: boolean;
}

/** `YYYY-MM-DD` de una columna DATE (Prisma la trae a medianoche UTC). */
function civilDateOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Lecturas de la agenda de contingencia (DX-339) bajo RLS (dentalix_app con la
 * clínica fijada por runWithTenant) y con `tenantId` explícito además. La
 * ventana de citas de una sede la sirve `appointments_tenant_location_start_idx`
 * y la «primera visita», `appointments_tenant_patient_completed_idx`.
 */
@Injectable()
export class PrismaContingencyAgendaRepository implements ContingencyAgendaRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async findLocation(locationId: string): Promise<ContingencyLocation | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const location = await tx.location.findFirst({
        where: { id: locationId, tenantId, deletedAt: null, isActive: true },
        select: {
          id: true,
          tenantId: true,
          name: true,
          phone: true,
          timeZone: true,
          locale: true,
          hourCycle: true,
          defaultPhoneRegion: true,
        },
      });
      if (!location) return null;
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true },
      });
      return { ...location, clinicName: tenant.name };
    });
  }

  listAppointments(
    locationId: string,
    from: Date,
    to: Date,
  ): Promise<ContingencyAppointmentRow[]> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant((tx) =>
      tx.$queryRaw<AppointmentSqlRow[]>(Prisma.sql`
        SELECT a."id" AS "appointmentId", a."patientId", a."start", a."end", a."status",
               p."firstName", p."lastName", p."phone",
               u."fullName" AS "professionalName", t."name" AS "appointmentTypeName",
               NOT EXISTS (
                 SELECT 1 FROM "appointments" prev
                  WHERE prev."tenantId" = a."tenantId"
                    AND prev."patientId" = a."patientId"
                    AND prev."deletedAt" IS NULL
                    AND prev."status" = 'COMPLETED'
                    AND prev."start" < a."start"
               ) AS "firstVisit",
               a."callbackRequestedAt" IS NOT NULL AS "callbackRequested"
          FROM "appointments" a
          JOIN "patients" p ON p."tenantId" = a."tenantId" AND p."id" = a."patientId"
          LEFT JOIN "users" u ON u."id" = a."providerId"
          LEFT JOIN "appointment_types" t
            ON t."tenantId" = a."tenantId" AND t."id" = a."appointmentTypeId"
         WHERE a."tenantId" = ${tenantId}::uuid
           AND a."locationId" = ${locationId}::uuid
           AND a."deletedAt" IS NULL
           AND p."deletedAt" IS NULL
           AND a."start" >= ${from}
           AND a."start" < ${to}
           AND a."status" NOT IN ('CANCELLED', 'NO_SHOW')
         ORDER BY a."start", a."id"`),
    );
  }

  async findSnapshot(locationId: string): Promise<ContingencySnapshot | null> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.contingencyAgendaSnapshot.findUnique({
        where: { tenantId_locationId: { tenantId, locationId } },
      }),
    );
    return row
      ? {
          locationId: row.locationId,
          forDate: civilDateOf(row.forDate),
          generatedAt: row.generatedAt,
          appointmentCount: row.appointmentCount,
          sizeBytes: row.sizeBytes,
          storageKey: row.storageKey,
        }
      : null;
  }

  async saveSnapshot(snapshot: ContingencySnapshot): Promise<void> {
    const tenantId = this.requireTenantId();
    const data = {
      forDate: new Date(`${snapshot.forDate}T00:00:00Z`),
      generatedAt: snapshot.generatedAt,
      appointmentCount: snapshot.appointmentCount,
      sizeBytes: snapshot.sizeBytes,
      storageKey: snapshot.storageKey,
    };
    await this.prisma.runWithTenant((tx) =>
      tx.contingencyAgendaSnapshot.upsert({
        where: {
          tenantId_locationId: { tenantId, locationId: snapshot.locationId },
        },
        create: { tenantId, locationId: snapshot.locationId, ...data },
        update: data,
        select: { locationId: true },
      }),
    );
  }

  async tenantIds(): Promise<string[]> {
    const rows = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async nightlyCandidates(tenantId: string): Promise<NightlyCandidate[]> {
    const rows = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.location.findMany({
        where: {
          tenantId,
          deletedAt: null,
          isActive: true,
          timeZone: { not: null },
          locale: { not: null },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          timeZone: true,
          hourCycle: true,
          contingencyAgendaSnapshot: { select: { forDate: true } },
        },
      }),
    );
    // Sin zona válida o sin reloj no se puede pintar: el trabajo fallaría con
    // el 409 de la sede. Se saltan hasta que el ADMIN la configure.
    return rows.flatMap((row) =>
      row.timeZone !== null &&
      isValidTimeZone(row.timeZone) &&
      isHourCycle(row.hourCycle)
        ? [
            {
              locationId: row.id,
              timeZone: row.timeZone,
              lastForDate: row.contingencyAgendaSnapshot
                ? civilDateOf(row.contingencyAgendaSnapshot.forDate)
                : null,
            },
          ]
        : [],
    );
  }
}
