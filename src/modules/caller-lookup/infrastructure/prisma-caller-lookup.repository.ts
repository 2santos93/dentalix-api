import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { resolveLocationTimeZones } from '../../../shared/locations/location-time-zone';
import type { PhoneRegion } from '../../../shared/phone/phone-number';
import { defaultPhoneRegionIn } from '../../patients/infrastructure/phone-e164';
import {
  CALLER_LOOKUP_MAX_MATCHES,
  type CallerLookupRepository,
  type CallerMatch,
  type CallerNextAppointment,
  type CallerVisitRef,
} from '../domain/caller-lookup-repository.port';

interface VisitRow {
  patientId: string;
  appointmentId: string;
  start: Date;
  locationId: string;
  locationName: string;
}

@Injectable()
export class PrismaCallerLookupRepository implements CallerLookupRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  defaultPhoneRegion(): Promise<PhoneRegion | null> {
    return this.prisma.runWithTenant((tx) =>
      defaultPhoneRegionIn(tx, this.tenantContext.getLocationId()),
    );
  }

  /**
   * Dos ramas sobre los índices parciales de DX-224: el paciente por su
   * `phoneE164` y el paciente de un contacto responsable que lo tiene. Sin
   * archivados. Si un mismo paciente sale por las dos, gana su propio teléfono.
   */
  findByPhoneE164(e164s: readonly string[]): Promise<CallerMatch[]> {
    const tenantId = this.requireTenantId();
    const list = [...e164s];
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          firstName: string;
          lastName: string;
          matchedBy: CallerMatch['matchedBy'];
        }[]
      >`
        SELECT DISTINCT ON (m."id") m."id", m."firstName", m."lastName", m."matchedBy"
          FROM (
            SELECT p."id", p."firstName", p."lastName", 'PATIENT' AS "matchedBy", 0 AS "rank"
              FROM "patients" p
             WHERE p."tenantId" = ${tenantId}::uuid
               AND p."phoneE164" = ANY(${list}::text[])
               AND p."deletedAt" IS NULL
            UNION ALL
            SELECT p."id", p."firstName", p."lastName", 'RESPONSIBLE_PARTY', 1
              FROM "patient_responsible_parties" r
              JOIN "patients" p
                ON p."tenantId" = r."tenantId" AND p."id" = r."patientId"
             WHERE r."tenantId" = ${tenantId}::uuid
               AND r."phoneE164" = ANY(${list}::text[])
               AND r."deletedAt" IS NULL
               AND p."deletedAt" IS NULL
          ) m
         ORDER BY m."id", m."rank"`;
      return rows
        .map((r): CallerMatch => ({
          patientId: r.id,
          firstName: r.firstName,
          lastName: r.lastName,
          matchedBy: r.matchedBy,
        }))
        .sort(
          (a, b) =>
            a.lastName.localeCompare(b.lastName, 'es') ||
            a.firstName.localeCompare(b.firstName, 'es') ||
            a.patientId.localeCompare(b.patientId),
        )
        .slice(0, CALLER_LOOKUP_MAX_MATCHES);
    });
  }

  /** Las sedes que el miembro puede ver; `undefined`: todas. */
  private locationFilter(): Prisma.Sql {
    const ids = this.tenantContext.scopeLocationIds();
    return ids === undefined
      ? Prisma.empty
      : Prisma.sql`AND a."locationId" = ANY(${ids}::uuid[])`;
  }

  private async visits(
    patientIds: readonly string[],
    pick: (filter: Prisma.Sql, ids: string[]) => Prisma.Sql,
  ): Promise<Map<string, VisitRow & CallerVisitRef>> {
    const out = new Map<string, VisitRow & CallerVisitRef>();
    if (patientIds.length === 0) return out;
    const tenantId = this.requireTenantId();
    const ids = [...patientIds];
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<VisitRow[]>(
        pick(this.locationFilter(), ids),
      );
      if (rows.length === 0) return out;
      const zoneOf = await resolveLocationTimeZones(tx, tenantId, [
        ...new Set(rows.map((r) => r.locationId)),
      ]);
      for (const r of rows) {
        out.set(r.patientId, { ...r, timeZone: zoneOf(r.locationId) });
      }
      return out;
    });
  }

  async nextAppointments(
    patientIds: readonly string[],
    now: Date,
  ): Promise<Map<string, CallerNextAppointment>> {
    const rows = await this.visits(
      patientIds,
      (filter, ids) => Prisma.sql`
        SELECT DISTINCT ON (a."patientId")
               a."patientId", a."id" AS "appointmentId", a."start",
               a."locationId", l."name" AS "locationName"
          FROM "appointments" a
          JOIN "locations" l ON l."id" = a."locationId"
         WHERE a."tenantId" = ${this.requireTenantId()}::uuid
           AND a."patientId" = ANY(${ids}::uuid[])
           AND a."status" IN ('SCHEDULED', 'CONFIRMED')
           AND a."deletedAt" IS NULL
           AND a."start" >= ${now}
           ${filter}
         ORDER BY a."patientId", a."start" ASC, a."id" ASC`,
    );
    return new Map(
      [...rows].map(([id, r]) => [
        id,
        {
          appointmentId: r.appointmentId,
          start: r.start,
          locationId: r.locationId,
          locationName: r.locationName,
          timeZone: r.timeZone,
        },
      ]),
    );
  }

  async lastVisits(
    patientIds: readonly string[],
    now: Date,
  ): Promise<Map<string, CallerVisitRef>> {
    const rows = await this.visits(
      patientIds,
      (filter, ids) => Prisma.sql`
        SELECT DISTINCT ON (a."patientId")
               a."patientId", a."id" AS "appointmentId", a."start",
               a."locationId", l."name" AS "locationName"
          FROM "appointments" a
          JOIN "locations" l ON l."id" = a."locationId"
         WHERE a."tenantId" = ${this.requireTenantId()}::uuid
           AND a."patientId" = ANY(${ids}::uuid[])
           AND a."status" = 'COMPLETED'
           AND a."deletedAt" IS NULL
           AND a."start" <= ${now}
           ${filter}
         ORDER BY a."patientId", a."start" DESC, a."id" DESC`,
    );
    return new Map(
      [...rows].map(([id, r]) => [
        id,
        {
          start: r.start,
          locationId: r.locationId,
          locationName: r.locationName,
          timeZone: r.timeZone,
        },
      ]),
    );
  }
}
