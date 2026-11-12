import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import {
  firstLocationWithRows,
  loadPeriodLocationZones,
} from '../../../shared/locations/location-time-zone';
import { civilPeriodByZone } from '../../../shared/time/civil-day';
import type { CivilPeriod } from '../domain/comparison-period';
import type {
  ChairOccupancyLocationData,
  ChairOccupancyRepository,
} from '../domain/ports/chair-occupancy-repository.port';

interface RangeRow {
  locationId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
}

interface ClosureRow {
  locationId: string;
  start: Date;
  end: Date;
}

interface HolidayRow {
  locationId: string;
  date: string;
  recurring: boolean;
}

interface ChairRow {
  id: string;
  locationId: string;
  name: string;
  active: boolean;
  sortOrder: number;
}

interface AppointmentRow {
  id: string;
  locationId: string;
  chairId: string | null;
  start: Date;
  end: Date;
  status: string;
}

/**
 * Una cita puede tardar como mucho esto: acota por abajo la búsqueda de citas
 * que tocan el período en el índice (tenantId, locationId, start).
 */
const MAX_APPOINTMENT_SPAN_MS = 24 * 60 * 60 * 1000;

/**
 * Lecturas de «Ocupación por sillón» (DX-481), con el tenant explícito además
 * de la RLS y en UNA transacción REPEATABLE READ (horario, cierres, festivos,
 * sillones y citas ven la misma foto):
 *  - horario: tramos vivos del horario vivo de la sede (DX-122);
 *  - cierres: bloqueos de toda la sede (sin profesional) que no admiten
 *    citas y tocan el período (`schedule_blocks_tenant_location_end_idx`);
 *  - festivos vivos de la sede (DX-316; `location_holidays` por sede y fecha);
 *  - sillones de la sede (DX-211), activos e inactivos;
 *  - citas vivas NO canceladas que tocan el período
 *    (`appointments_tenant_location_start_idx`), con su sillón.
 * Sin pacientes: ni ids ni nombres salen de aquí.
 */
@Injectable()
export class PrismaChairOccupancyRepository implements ChairOccupancyRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async listLocationIds(allowed: AllowedLocations): Promise<string[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.location.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(allowed === 'ALL' ? {} : { id: { in: [...allowed] } }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      }),
    );
    return rows.map((r) => r.id);
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

  async load(
    period: CivilPeriod,
    locationIds: readonly string[],
  ): Promise<ChairOccupancyLocationData[]> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(
      async (tx) => {
        // Una sede sin zona y sin citas se ignora; con citas, 409 (G1).
        const zones = await loadPeriodLocationZones(
          tx,
          tenantId,
          locationIds,
          firstLocationWithRows(tx.appointment, tenantId),
        );
        const branches = civilPeriodByZone(
          period.from,
          period.to,
          zones.configured,
        );
        if (branches.length === 0) return [];
        const ids = locationIds.filter((id) => zones.configured.has(id));
        const windowStart = new Date(
          Math.min(...branches.map((b) => b.start.getTime())),
        );
        const windowEnd = new Date(
          Math.max(...branches.map((b) => b.end.getTime())),
        );
        const earliestStart = new Date(
          windowStart.getTime() - MAX_APPOINTMENT_SPAN_MS,
        );

        const names = await tx.location.findMany({
          where: { tenantId, id: { in: ids } },
          select: { id: true, name: true },
        });

        const ranges = await tx.$queryRaw<RangeRow[]>`
          SELECT s."locationId", r."weekday", r."startMinute", r."endMinute"
            FROM "location_schedules" s
            JOIN "location_schedule_ranges" r
              ON r."tenantId" = s."tenantId" AND r."scheduleId" = s."id"
             AND r."deletedAt" IS NULL
           WHERE s."tenantId" = ${tenantId}::uuid
             AND s."deletedAt" IS NULL
             AND s."locationId" = ANY(${ids}::uuid[])`;

        const closures = await tx.$queryRaw<ClosureRow[]>`
          SELECT b."locationId", b."start", b."end"
            FROM "schedule_blocks" b
           WHERE b."tenantId" = ${tenantId}::uuid
             AND b."deletedAt" IS NULL
             AND b."providerId" IS NULL
             AND b."allowsBooking" = false
             AND b."locationId" = ANY(${ids}::uuid[])
             AND b."end" > ${windowStart}
             AND b."start" < ${windowEnd}`;

        const holidays = await tx.$queryRaw<HolidayRow[]>`
          SELECT h."locationId", to_char(h."date", 'YYYY-MM-DD') AS "date",
                 h."recurring"
            FROM "location_holidays" h
           WHERE h."tenantId" = ${tenantId}::uuid
             AND h."deletedAt" IS NULL
             AND h."locationId" = ANY(${ids}::uuid[])
             AND (h."recurring"
                  OR (h."date" >= ${period.from}::date
                      AND h."date" <= ${period.to}::date))`;

        const chairs = await tx.chair.findMany({
          where: { tenantId, locationId: { in: ids } },
          select: {
            id: true,
            locationId: true,
            name: true,
            active: true,
            sortOrder: true,
          },
        });

        const appointments = await tx.$queryRaw<AppointmentRow[]>`
          SELECT a."id", a."locationId", a."chairId", a."start", a."end",
                 a."status"::text AS "status"
            FROM "appointments" a
           WHERE a."tenantId" = ${tenantId}::uuid
             AND a."deletedAt" IS NULL
             AND a."status" <> 'CANCELLED'
             AND a."locationId" = ANY(${ids}::uuid[])
             AND a."start" >= ${earliestStart}
             AND a."start" < ${windowEnd}
             AND a."end" > ${windowStart}`;

        const nameOf = new Map(names.map((l) => [l.id, l.name]));
        const group = <T extends { locationId: string }>(rows: T[]) => {
          const out = new Map<string, T[]>();
          for (const r of rows) {
            const list = out.get(r.locationId) ?? [];
            list.push(r);
            out.set(r.locationId, list);
          }
          return out;
        };
        const rangesBy = group(ranges);
        const closuresBy = group(closures);
        const holidaysBy = group(holidays);
        const chairsBy = group<ChairRow>(chairs);
        const appointmentsBy = group(appointments);

        return ids.map((id) => ({
          locationId: id,
          locationName: nameOf.get(id) ?? 'Sede',
          timeZone: zones.zoneOf(id),
          ranges: (rangesBy.get(id) ?? []).map((r) => ({
            weekday: r.weekday,
            startMinute: r.startMinute,
            endMinute: r.endMinute,
          })),
          closures: (closuresBy.get(id) ?? []).map((c) => ({
            start: c.start,
            end: c.end,
          })),
          holidays: (holidaysBy.get(id) ?? []).map((h) => ({
            date: h.date,
            recurring: h.recurring,
          })),
          chairs: (chairsBy.get(id) ?? []).map((c) => ({
            id: c.id,
            name: c.name,
            active: c.active,
            sortOrder: c.sortOrder,
          })),
          appointments: (appointmentsBy.get(id) ?? []).map((a) => ({
            id: a.id,
            chairId: a.chairId,
            start: a.start,
            end: a.end,
            status: a.status,
          })),
        }));
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
