import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { requireLocationTimeZone } from '../../../../shared/locations/location-time-zone';
import {
  LocationScheduleRepository,
  ReplaceScheduleInput,
  SCHEDULE_TIME_ZONE_MOVED,
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

/// G1 (R4): la zona del horario es la de su sede, nunca la columna legada
/// `location_schedules.timezone` (R20: el código nuevo no la lee).
function mapToBusinessHours(
  row: ScheduleWithRanges,
  timeZone: string,
): BusinessHours {
  return {
    timezone: timeZone,
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

  /** Zona de la sede (`Location.timeZone`) o 409 `LOCATION_TIMEZONE_REQUIRED`. */
  private async locationTimeZone(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationId: string,
  ): Promise<string> {
    const location = await tx.location.findFirst({
      where: { id: locationId, tenantId },
      select: { id: true, timeZone: true },
    });
    return requireLocationTimeZone(
      location ?? { id: locationId, timeZone: null },
    );
  }

  private async scheduleOf(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationId: string,
  ): Promise<BusinessHours | null> {
    const row = await tx.locationSchedule.findFirst({
      where: { tenantId, locationId, deletedAt: null },
      include: LIVE_RANGES,
    });
    if (!row) return null;
    return mapToBusinessHours(
      row,
      await this.locationTimeZone(tx, tenantId, locationId),
    );
  }

  async findByLocation(locationId: string): Promise<BusinessHours | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) =>
      this.scheduleOf(tx, tenantId, locationId),
    );
  }

  async findForCurrentLocation(): Promise<BusinessHours | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // DX-089: la sede del request o la de escritura de la sesión (la
      // principal sin restricción): la misma en la que se agenda.
      const locationId = await this.tenantContext.writeLocationId(tx);
      return this.scheduleOf(tx, tenantId, locationId);
    });
  }

  async replaceForCurrentLocation(
    input: ReplaceScheduleInput,
  ): Promise<BusinessHours> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // DX-089: la sede del request o la de escritura de la sesión (la
      // principal sin restricción): la misma en la que se agenda.
      const locationId = await this.tenantContext.writeLocationId(tx);
      // FOR SHARE: choca con el FOR UPDATE de un cambio de zona en curso
      // (PATCH /locations/:id), así que aquí se lee la zona ya confirmada y la
      // columna legada no vuelve a la anterior (R20).
      const [location] = await tx.$queryRaw<
        { id: string; timeZone: string | null }[]
      >`
        SELECT l."id", l."timeZone"
          FROM "locations" l
         WHERE l."id" = ${locationId}::uuid AND l."tenantId" = ${tenantId}::uuid
           FOR SHARE`;
      // R15: una web antigua manda la zona; solo vale si es la de la sede.
      if (
        input.legacyTimeZone !== undefined &&
        input.legacyTimeZone.trim() !== location?.timeZone
      ) {
        throw new BadRequestException(SCHEDULE_TIME_ZONE_MOVED);
      }
      const timeZone = requireLocationTimeZone(
        location ?? { id: locationId, timeZone: null },
      );

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
              // R20: la columna legada nace igual a la zona de la sede.
              data: { tenantId, locationId, timezone: timeZone },
              select: { id: true },
            })
          ).id;

      if (existing) {
        await tx.locationSchedule.update({
          where: { id: scheduleId },
          data: { timezone: timeZone },
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

      return mapToBusinessHours(
        await tx.locationSchedule.findFirstOrThrow({
          where: { id: scheduleId },
          include: LIVE_RANGES,
        }),
        timeZone,
      );
    });
  }
}
