import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type {
  MinuteRange,
  ProviderOverride,
  ProviderScheduleSnapshot,
  WeeklyProviderRange,
} from '../domain/provider-availability';
import type {
  CivilPeriod,
  OverrideChange,
  ProviderScheduleRepository,
  ReplaceWeeklyInput,
  UpsertOverrideInput,
  WeeklyChange,
} from '../domain/ports/provider-schedule-repository.port';

/** `YYYY-MM-DD` ↔ columna `DATE` (Prisma la trae como medianoche UTC). */
const toDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const fromDate = (date: Date): string => date.toISOString().slice(0, 10);

const LIVE_OVERRIDE_RANGES = {
  ranges: {
    where: { deletedAt: null },
    orderBy: { startMinute: 'asc' },
    select: { startMinute: true, endMinute: true },
  },
} as const satisfies Prisma.ProviderScheduleOverrideInclude;

type OverrideRow = Prisma.ProviderScheduleOverrideGetPayload<{
  include: typeof LIVE_OVERRIDE_RANGES;
}>;

function mapOverride(row: OverrideRow): ProviderOverride {
  return {
    id: row.id,
    locationId: row.locationId,
    date: fromDate(row.date),
    ranges: row.ranges.map((r) => ({
      startMinute: r.startMinute,
      endMinute: r.endMinute,
    })),
    note: row.note,
  };
}

function byWeekly(a: WeeklyProviderRange, b: WeeklyProviderRange): number {
  return (
    a.locationId.localeCompare(b.locationId) ||
    a.weekday - b.weekday ||
    a.startMinute - b.startMinute
  );
}

@Injectable()
export class PrismaProviderScheduleRepository implements ProviderScheduleRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /**
   * Candado por profesional para toda escritura de su horario: la validación
   * (sin solape entre sedes, contra las excepciones) mira lo guardado y
   * escribe en la misma transacción, sin que otro guardado se cuele en medio.
   */
  private async lockProvider(
    tx: Prisma.TransactionClient,
    providerId: string,
  ): Promise<void> {
    const key = `dx233:provider-schedule:${this.tenantId()}:${providerId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  private async weeklyOf(
    tx: Prisma.TransactionClient,
    providerIds: readonly string[],
  ): Promise<{ providerId: string; weekly: WeeklyProviderRange[] }[]> {
    const schedules = await tx.providerSchedule.findMany({
      where: { providerId: { in: [...providerIds] }, deletedAt: null },
      select: {
        providerId: true,
        locationId: true,
        ranges: {
          where: { deletedAt: null },
          select: { weekday: true, startMinute: true, endMinute: true },
        },
      },
    });
    return schedules.map((s) => ({
      providerId: s.providerId,
      weekly: s.ranges.map((r) => ({ locationId: s.locationId, ...r })),
    }));
  }

  private async snapshots(
    tx: Prisma.TransactionClient,
    providerIds: readonly string[],
    period: { from: string; to?: string },
  ): Promise<Map<string, ProviderScheduleSnapshot>> {
    const out = new Map<string, ProviderScheduleSnapshot>(
      providerIds.map((providerId) => [
        providerId,
        { providerId, configured: false, weekly: [], overrides: [] },
      ]),
    );
    if (providerIds.length === 0) return out;
    for (const s of await this.weeklyOf(tx, providerIds)) {
      const snap = out.get(s.providerId);
      if (!snap) continue;
      snap.configured = true;
      snap.weekly.push(...s.weekly);
    }
    const overrides = await tx.providerScheduleOverride.findMany({
      where: {
        providerId: { in: [...providerIds] },
        deletedAt: null,
        date: {
          gte: toDate(period.from),
          ...(period.to ? { lte: toDate(period.to) } : {}),
        },
      },
      include: LIVE_OVERRIDE_RANGES,
      orderBy: [{ date: 'asc' }, { locationId: 'asc' }],
    });
    for (const row of overrides) {
      out.get(row.providerId)?.overrides.push(mapOverride(row));
    }
    for (const snap of out.values()) snap.weekly.sort(byWeekly);
    return out;
  }

  findSnapshots(
    providerIds: readonly string[],
    period: CivilPeriod,
  ): Promise<Map<string, ProviderScheduleSnapshot>> {
    return this.prisma.runWithTenant((tx) =>
      this.snapshots(tx, [...new Set(providerIds)], period),
    );
  }

  replaceWeekly(input: ReplaceWeeklyInput): Promise<WeeklyChange> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      await this.lockProvider(tx, input.providerId);
      const current = (
        await this.snapshots(tx, [input.providerId], {
          from: input.overridesFrom,
        })
      ).get(input.providerId)!;
      input.validate(current);

      const now = new Date();
      const live = await tx.providerSchedule.findMany({
        where: { providerId: input.providerId, deletedAt: null },
        select: { id: true, locationId: true },
      });
      const keep = new Set(input.locations.map((l) => l.locationId));
      // Todos los tramos vivos se retiran: el semanal se reemplaza entero
      // (lo viejo queda en la tabla con `deletedAt`, como el de la sede).
      if (live.length > 0) {
        await tx.providerScheduleRange.updateMany({
          where: {
            scheduleId: { in: live.map((s) => s.id) },
            deletedAt: null,
          },
          data: { deletedAt: now },
        });
      }
      const gone = live.filter((s) => !keep.has(s.locationId));
      if (gone.length > 0) {
        await tx.providerSchedule.updateMany({
          where: { id: { in: gone.map((s) => s.id) } },
          data: { deletedAt: now, updatedById: input.actorId },
        });
      }
      for (const loc of input.locations) {
        const existing = live.find((s) => s.locationId === loc.locationId);
        const scheduleId = existing
          ? (
              await tx.providerSchedule.update({
                where: { id: existing.id },
                data: { timezone: loc.timezone, updatedById: input.actorId },
                select: { id: true },
              })
            ).id
          : (
              await tx.providerSchedule.create({
                data: {
                  tenantId,
                  providerId: input.providerId,
                  locationId: loc.locationId,
                  timezone: loc.timezone,
                  createdById: input.actorId,
                  updatedById: input.actorId,
                },
                select: { id: true },
              })
            ).id;
        await tx.providerScheduleRange.createMany({
          data: loc.ranges.map((r) => ({
            tenantId,
            scheduleId,
            providerId: input.providerId,
            weekday: r.weekday,
            startMinute: r.startMinute,
            endMinute: r.endMinute,
          })),
        });
      }
      const after = (await this.weeklyOf(tx, [input.providerId]))
        .flatMap((s) => s.weekly)
        .sort(byWeekly);
      return { before: current.weekly, after };
    });
  }

  upsertOverride(input: UpsertOverrideInput): Promise<OverrideChange> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      await this.lockProvider(tx, input.providerId);
      const current = (
        await this.snapshots(tx, [input.providerId], {
          from: input.date,
          to: input.date,
        })
      ).get(input.providerId)!;
      input.validate(current);

      const date = toDate(input.date);
      const before =
        current.overrides.find((o) => o.locationId === input.locationId) ??
        null;
      if (before) {
        const now = new Date();
        await tx.providerScheduleOverrideRange.updateMany({
          where: { overrideId: before.id, deletedAt: null },
          data: { deletedAt: now },
        });
        await tx.providerScheduleOverride.update({
          where: { id: before.id },
          data: { deletedAt: now },
        });
      }
      const created = await tx.providerScheduleOverride.create({
        data: {
          tenantId,
          providerId: input.providerId,
          locationId: input.locationId,
          date,
          note: input.note,
          createdById: input.actorId,
        },
        select: { id: true },
      });
      if (input.ranges.length > 0) {
        await tx.providerScheduleOverrideRange.createMany({
          data: input.ranges.map((r: MinuteRange) => ({
            tenantId,
            overrideId: created.id,
            providerId: input.providerId,
            date,
            startMinute: r.startMinute,
            endMinute: r.endMinute,
          })),
        });
      }
      const after = await tx.providerScheduleOverride.findUniqueOrThrow({
        where: { id: created.id },
        include: LIVE_OVERRIDE_RANGES,
      });
      return { before, after: mapOverride(after) };
    });
  }

  deleteOverride(
    providerId: string,
    overrideId: string,
  ): Promise<ProviderOverride | null> {
    return this.prisma.runWithTenant(async (tx) => {
      await this.lockProvider(tx, providerId);
      const row = await tx.providerScheduleOverride.findFirst({
        where: { id: overrideId, providerId, deletedAt: null },
        include: LIVE_OVERRIDE_RANGES,
      });
      if (!row) return null;
      const now = new Date();
      await tx.providerScheduleOverrideRange.updateMany({
        where: { overrideId: row.id, deletedAt: null },
        data: { deletedAt: now },
      });
      await tx.providerScheduleOverride.update({
        where: { id: row.id },
        data: { deletedAt: now },
      });
      return mapOverride(row);
    });
  }

  listOverrides(
    providerId: string,
    period: CivilPeriod,
  ): Promise<ProviderOverride[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.providerScheduleOverride.findMany({
        where: {
          providerId,
          deletedAt: null,
          date: { gte: toDate(period.from), lte: toDate(period.to) },
        },
        include: LIVE_OVERRIDE_RANGES,
        orderBy: [{ date: 'asc' }, { locationId: 'asc' }],
      });
      return rows.map(mapOverride);
    });
  }

  async getStrict(): Promise<boolean> {
    // `tenants` es global (sin RLS): siempre por el id del contexto.
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: { providerScheduleStrict: true },
    });
    return tenant.providerScheduleStrict;
  }

  async setStrict(strict: boolean): Promise<boolean> {
    const tenant = await this.prisma.tenant.update({
      where: { id: this.tenantId() },
      data: { providerScheduleStrict: strict },
      select: { providerScheduleStrict: true },
    });
    return tenant.providerScheduleStrict;
  }

  resolveCurrentLocationId(): Promise<string> {
    // DX-089: la sede del request o la de escritura de la sesión (la
    // principal sin restricción): la misma en la que se agenda.
    return this.prisma.runWithTenant((tx) =>
      this.tenantContext.writeLocationId(tx),
    );
  }
}
