import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  LocationAttendance,
  PatientIncidentCounts,
} from '../../domain/attendance';
import type { PatientAttendanceRepository } from '../../domain/ports/patient-attendance-repository.port';

/** Prisma DateTime usa TIMESTAMP UTC sin zona en PostgreSQL. */
const utc = (date: Date) =>
  Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** Filtro DX-089 por las sedes permitidas; sin lista, todas. */
function locationFilter(locationIds: readonly string[] | undefined) {
  return locationIds === undefined
    ? Prisma.empty
    : Prisma.sql`AND a."locationId" = ANY(${[...locationIds]}::uuid[])`;
}

/**
 * DX-279: inasistencias y cancelaciones tardías calculadas al pedirlas. Las
 * cuentas de la agenda las sirve el índice parcial
 * `appointments_tenant_patient_incidents_idx` (solo esas filas).
 */
@Injectable()
export class PrismaPatientAttendanceRepository implements PatientAttendanceRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async patientExists(patientId: string): Promise<boolean> {
    const found = await this.prisma.runWithTenant((tx) =>
      tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: { id: true },
      }),
    );
    return found !== null;
  }

  async countsByPatients(
    patientIds: readonly string[],
    since: Date,
    locationIds: readonly string[] | undefined,
  ): Promise<Map<string, PatientIncidentCounts>> {
    const ids = [...new Set(patientIds)];
    if (ids.length === 0 || locationIds?.length === 0) return new Map();
    const tenantId = this.requireTenantId();
    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<
          { patientId: string; noShows: number; lateCancellations: number }[]
        >`
        SELECT a."patientId",
               count(*) FILTER (WHERE a."status" = 'NO_SHOW')::int AS "noShows",
               count(*) FILTER (WHERE a."lateCancellation" IS TRUE)::int AS "lateCancellations"
          FROM "appointments" a
         WHERE a."tenantId" = ${tenantId}::uuid
           AND a."patientId" = ANY(${ids}::uuid[])
           AND a."deletedAt" IS NULL
           AND (a."status" = 'NO_SHOW' OR a."lateCancellation" IS TRUE)
           AND a."start" >= ${utc(since)}
           ${locationFilter(locationIds)}
         GROUP BY a."patientId"`,
    );
    return new Map(
      rows.map((r) => [
        r.patientId,
        { noShows: r.noShows, lateCancellations: r.lateCancellations },
      ]),
    );
  }

  async summaryByLocation(
    patientId: string,
    since: Date,
    until: Date,
    locationIds: readonly string[] | undefined,
  ): Promise<LocationAttendance[]> {
    if (locationIds?.length === 0) return [];
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<LocationAttendance[]>`
        SELECT a."locationId",
               l."name" AS "locationName",
               count(*) FILTER (WHERE a."start" < ${utc(until)})::int AS "appointments",
               count(*) FILTER (WHERE a."status" = 'NO_SHOW')::int AS "noShows",
               count(*) FILTER (WHERE a."lateCancellation" IS TRUE)::int AS "lateCancellations"
          FROM "appointments" a
          JOIN "locations" l
            ON l."tenantId" = a."tenantId" AND l."id" = a."locationId"
         WHERE a."tenantId" = ${tenantId}::uuid
           AND a."patientId" = ${patientId}::uuid
           AND a."deletedAt" IS NULL
           AND a."start" >= ${utc(since)}
           ${locationFilter(locationIds)}
         GROUP BY a."locationId", l."name"
         ORDER BY l."name", a."locationId"`,
    );
  }
}
