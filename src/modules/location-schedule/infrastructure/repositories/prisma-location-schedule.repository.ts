import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveDefaultLocationId } from '../../../../shared/locations/default-location';
import {
  LocationScheduleRepository,
  ReplaceScheduleInput,
} from '../../domain/ports/location-schedule-repository.port';
import { BusinessHours } from '../../application/business-hours';

/// Los tramos se retiran en blando (ver `LocationScheduleRange` en el esquema),
/// así que la tabla acumula los horarios anteriores. Toda lectura pide SOLO los
/// vivos: sin este filtro el horario de la sede sería la unión de todo lo que
/// alguna vez estuvo configurado.
const LIVE_RANGES = {
  ranges: { where: { deletedAt: null }, orderBy: { weekday: 'asc' } },
} as const satisfies Prisma.LocationScheduleInclude;

type ScheduleWithRanges = Prisma.LocationScheduleGetPayload<{
  include: typeof LIVE_RANGES;
}>;

function mapToBusinessHours(row: ScheduleWithRanges): BusinessHours {
  return {
    timezone: row.timezone,
    ranges: row.ranges.map((r) => ({
      weekday: r.weekday,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
    })),
  };
}

@Injectable()
export class PrismaLocationScheduleRepository implements LocationScheduleRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async findByLocation(locationId: string): Promise<BusinessHours | null> {
    const row = await this.prisma.runWithTenant(async (tx) =>
      tx.locationSchedule.findFirst({
        where: { locationId, deletedAt: null },
        include: LIVE_RANGES,
      }),
    );
    return row ? mapToBusinessHours(row) : null;
  }

  async findForCurrentLocation(): Promise<BusinessHours | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const locationId =
        this.tenantContext.getLocationId() ??
        (await resolveDefaultLocationId(tx));
      const row = await tx.locationSchedule.findFirst({
        where: { locationId, deletedAt: null },
        include: LIVE_RANGES,
      });
      return row ? mapToBusinessHours(row) : null;
    });
  }

  async replaceForCurrentLocation(
    input: ReplaceScheduleInput,
  ): Promise<BusinessHours> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma.runWithTenant(async (tx) => {
      const locationId =
        this.tenantContext.getLocationId() ??
        (await resolveDefaultLocationId(tx));

      // Upsert manual (no `upsert`) porque la clave única es (tenantId,
      // locationId) y el tenantId lo pone el servidor, no el cliente.
      const existing = await tx.locationSchedule.findFirst({
        where: { locationId, deletedAt: null },
        select: { id: true },
      });
      const scheduleId = existing
        ? existing.id
        : (
            await tx.locationSchedule.create({
              data: { tenantId, locationId, timezone: input.timezone },
              select: { id: true },
            })
          ).id;

      if (existing) {
        await tx.locationSchedule.update({
          where: { id: scheduleId },
          data: { timezone: input.timezone },
        });
        // Reemplazo completo de la semana: los tramos viejos se RETIRAN (borrado
        // blando) y se insertan los nuevos, todo en la misma transacción. No se
        // borran de verdad — así el horario que regía en cualquier fecha pasada
        // sigue siendo reconstruible.
        await tx.locationScheduleRange.updateMany({
          where: { scheduleId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
      }

      if (input.ranges.length > 0) {
        await tx.locationScheduleRange.createMany({
          data: input.ranges.map((r) => ({
            tenantId,
            scheduleId,
            weekday: r.weekday,
            startMinute: r.startMinute,
            endMinute: r.endMinute,
          })),
        });
      }

      return tx.locationSchedule.findFirstOrThrow({
        where: { id: scheduleId },
        include: LIVE_RANGES,
      });
    });
    return mapToBusinessHours(row);
  }
}
