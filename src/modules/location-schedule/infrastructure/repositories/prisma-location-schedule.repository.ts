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

type ScheduleWithRanges = Prisma.LocationScheduleGetPayload<{
  include: { ranges: true };
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
export class PrismaLocationScheduleRepository
  implements LocationScheduleRepository
{
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
        include: { ranges: true },
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
        include: { ranges: true },
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
        // Reemplazo completo de la semana: se borran los tramos viejos y se
        // insertan los nuevos, todo en la misma transacción.
        await tx.locationScheduleRange.deleteMany({ where: { scheduleId } });
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
        include: { ranges: true },
      });
    });
    return mapToBusinessHours(row);
  }
}
