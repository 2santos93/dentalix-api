import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import type { ParsedHolidayFile } from '../domain/holiday-file';
import {
  HOLIDAY_MESSAGES,
  HolidayRuleError,
  MAX_HOLIDAYS_PER_LOCATION,
  assertRecurringAllowed,
  classifyHolidayBatch,
  conflictOf,
  exceedsLocationLimit,
  monthDay,
  type ClassifiedRow,
  type HolidayConflict,
} from '../domain/holiday-rules';
import {
  holidayAlreadyExists,
  holidayBadRequest,
  holidayLimitReached,
  holidayNotFound,
  locationNotFound,
} from '../domain/location-calendar-errors';
import type {
  HolidayInput,
  HolidayView,
  LocationCalendarRepository,
  LocationCalendarView,
  LocationFormatSource,
} from '../domain/ports/location-calendar-repository.port';

const HOLIDAY_SELECT = {
  id: true,
  date: true,
  name: true,
  recurring: true,
} as const satisfies Prisma.LocationHolidaySelect;

type HolidayRow = Prisma.LocationHolidayGetPayload<{
  select: typeof HOLIDAY_SELECT;
}>;

/** `@db.Date` llega a medianoche UTC: el día civil sale de `toISOString`. */
function toView(row: HolidayRow): HolidayView {
  return {
    id: row.id,
    date: row.date.toISOString().slice(0, 10),
    name: row.name,
    recurring: row.recurring,
  };
}

/** 'YYYY-MM-DD' → el `Date` que Prisma guarda en una columna `@db.Date`. */
function toDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** Recurrentes por (mes, día), luego puntuales por fecha; el id desempata. */
function calendarOrder(a: HolidayView, b: HolidayView): number {
  if (a.recurring !== b.recurring) return a.recurring ? -1 : 1;
  const ka = a.recurring ? monthDay(a.date) : a.date;
  const kb = b.recurring ? monthDay(b.date) : b.date;
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Por fecha y id: el «primero por fecha» del mensaje de R5 es estable. */
function byDateThenId(a: HolidayView, b: HolidayView): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * El vivo con el que choca `candidate` según R5: primero el de la misma
 * clase y clave y, si no, el primero por fecha de la otra clase.
 */
function firstConflict(
  candidate: { date: string; recurring: boolean },
  live: readonly HolidayView[],
): { existing: HolidayView; conflict: HolidayConflict } | null {
  const sorted = [...live].sort(byDateThenId);
  const same = sorted.find((h) => conflictOf(candidate, h) === 'SAME');
  if (same) return { existing: same, conflict: 'SAME' };
  for (const existing of sorted) {
    const conflict = conflictOf(candidate, existing);
    if (conflict) return { existing, conflict };
  }
  return null;
}

/** Una fila NEW de la clasificación: fecha, nombre y clase ya leídos. */
type NewRow = ClassifiedRow & {
  status: 'NEW';
  date: string;
  name: string;
  recurring: boolean;
};

function isNewRow(row: ClassifiedRow): row is NewRow {
  return (
    row.status === 'NEW' &&
    row.date !== null &&
    row.name !== null &&
    row.recurring !== null
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class PrismaLocationCalendarRepository implements LocationCalendarRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  get(locationId: string): Promise<LocationCalendarView> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const location = await tx.location.findFirst({
        where: { id: locationId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!location) throw locationNotFound();
      return this.readView(tx, tenantId, locationId);
    });
  }

  withLockedCalendar<T>(
    locationId: string,
    fn: (tx: Prisma.TransactionClient, tenantId: string) => Promise<T>,
  ): Promise<T> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      // La fila 1:1 serializa crear, editar, retirar e importar festivos y
      // fijar los días de ESTA sede: el segundo escritor espera aquí y luego
      // ve lo que dejó el primero (R5 entre clases no está en la BD).
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT c."id"
          FROM "location_working_calendars" c
          JOIN "locations" l
            ON l."tenantId" = c."tenantId" AND l."id" = c."locationId"
         WHERE c."tenantId" = ${tenantId}::uuid
           AND c."locationId" = ${locationId}::uuid
           AND l."deletedAt" IS NULL
           FOR UPDATE OF c`;
      if (!locked) {
        const location = await tx.location.findFirst({
          where: { id: locationId, tenantId, deletedAt: null },
          select: { id: true },
        });
        if (!location) throw locationNotFound();
        // R2 roto: nunca se supone un calendario.
        throw new Error('LOCATION_WORKING_CALENDAR_MISSING');
      }
      return fn(tx, tenantId);
    });
  }

  setWorkingWeekdays(
    locationId: string,
    days: number[],
  ): Promise<{
    before: number[];
    after: number[];
    view: LocationCalendarView;
  }> {
    return this.withLockedCalendar(locationId, async (tx, tenantId) => {
      const row = await tx.locationWorkingCalendar.findFirstOrThrow({
        where: { tenantId, locationId },
        select: { workingWeekdays: true },
      });
      const before = row.workingWeekdays;
      const same =
        before.length === days.length && before.every((d, i) => d === days[i]);
      if (!same) {
        await tx.locationWorkingCalendar.updateMany({
          where: { tenantId, locationId },
          data: { workingWeekdays: days },
        });
      }
      const view = await this.readView(tx, tenantId, locationId);
      return { before, after: same ? before : days, view };
    });
  }

  async createHoliday(
    locationId: string,
    input: HolidayInput,
  ): Promise<HolidayView> {
    try {
      return await this.withLockedCalendar(locationId, async (tx, tenantId) => {
        const live = await this.liveHolidays(tx, tenantId, locationId);
        const found = firstConflict(input, live);
        if (found) throw holidayAlreadyExists(found.existing, found.conflict);
        // Tope por sede (§5.1), bajo el mismo bloqueo: dos altas a la vez no
        // lo pasan. Editar no cambia la cuenta.
        if (live.length >= MAX_HOLIDAYS_PER_LOCATION) {
          throw await this.limitReached(tx, tenantId, locationId);
        }
        const row = await tx.locationHoliday.create({
          data: {
            // La columna no tiene default en la BD: el id va siempre aquí.
            id: randomUUID(),
            tenantId,
            locationId,
            date: toDbDate(input.date),
            name: input.name,
            recurring: input.recurring,
          },
          select: HOLIDAY_SELECT,
        });
        return toView(row);
      });
    } catch (error) {
      throw await this.translateUniqueViolation(error, locationId, input);
    }
  }

  async updateHoliday(
    locationId: string,
    holidayId: string,
    patch: Partial<HolidayInput>,
  ): Promise<{ before: HolidayView; after: HolidayView }> {
    let candidate: HolidayInput | null = null;
    try {
      return await this.withLockedCalendar(locationId, async (tx, tenantId) => {
        const before = await this.liveHoliday(
          tx,
          tenantId,
          locationId,
          holidayId,
        );
        const merged: HolidayInput = {
          date: patch.date ?? before.date,
          name: patch.name ?? before.name,
          recurring: patch.recurring ?? before.recurring,
        };
        candidate = merged;
        try {
          assertRecurringAllowed(merged.date, merged.recurring);
        } catch (error) {
          if (error instanceof HolidayRuleError) throw holidayBadRequest(error);
          throw error;
        }
        const others = (
          await this.liveHolidays(tx, tenantId, locationId)
        ).filter((h) => h.id !== holidayId);
        const found = firstConflict(merged, others);
        if (found) throw holidayAlreadyExists(found.existing, found.conflict);
        // Sin cambio real no se escribe (y el controlador no audita).
        if (
          merged.date === before.date &&
          merged.name === before.name &&
          merged.recurring === before.recurring
        ) {
          return { before, after: before };
        }
        const row = await tx.locationHoliday.update({
          where: { id: holidayId },
          data: {
            ...(patch.date !== undefined ? { date: toDbDate(patch.date) } : {}),
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.recurring !== undefined
              ? { recurring: patch.recurring }
              : {}),
          },
          select: HOLIDAY_SELECT,
        });
        return { before, after: toView(row) };
      });
    } catch (error) {
      throw await this.translateUniqueViolation(
        error,
        locationId,
        candidate,
        holidayId,
      );
    }
  }

  retireHoliday(locationId: string, holidayId: string): Promise<HolidayView> {
    return this.withLockedCalendar(locationId, async (tx, tenantId) => {
      const before = await this.liveHoliday(
        tx,
        tenantId,
        locationId,
        holidayId,
      );
      await tx.locationHoliday.update({
        where: { id: holidayId },
        data: { deletedAt: new Date() },
      });
      return before;
    });
  }

  readForImport(locationId: string): Promise<{
    location: LocationFormatSource;
    holidays: HolidayView[];
  }> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const location = await tx.location.findFirst({
        where: { id: locationId, tenantId, deletedAt: null },
        select: { id: true, locale: true, hourCycle: true },
      });
      if (!location) throw locationNotFound();
      const holidays = await this.liveHolidays(tx, tenantId, locationId);
      return { location, holidays };
    });
  }

  importHolidays(
    locationId: string,
    file: ParsedHolidayFile,
  ): Promise<ClassifiedRow[]> {
    return this.withLockedCalendar(locationId, async (tx, tenantId) => {
      // Se reclasifica con los vivos ya bloqueados: lo que vio la vista previa
      // (o una importación que se adelantó) puede haber cambiado.
      const live = await this.liveHolidays(tx, tenantId, locationId);
      const rows = classifyHolidayBatch(file, live);
      if (exceedsLocationLimit(live.length, rows)) {
        throw await this.limitReached(tx, tenantId, locationId);
      }
      const fresh = rows.filter(isNewRow).map((row) => ({
        row,
        // La columna no tiene default en la BD: el id va siempre aquí.
        id: randomUUID(),
      }));
      if (fresh.length === 0) return rows;
      // Sin destino (M10): vale para los dos índices únicos parciales sin
      // repetir sus predicados. Con el bloqueo no debería saltar nunca.
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "location_holidays"
          ("id", "tenantId", "locationId", "date", "name", "recurring", "updatedAt")
        VALUES ${Prisma.join(
          fresh.map(
            ({ row, id }) => Prisma.sql`(
              ${id}::uuid, ${tenantId}::uuid, ${locationId}::uuid,
              ${row.date}::date, ${row.name}, ${row.recurring},
              timezone('UTC', now())
            )`,
          ),
        )}
        ON CONFLICT DO NOTHING
        RETURNING "id"`;
      const created = new Set(inserted.map((r) => r.id));
      if (created.size === fresh.length) return rows;
      // Alguna la rechazó un índice único: ese día ya lo ocupa un vivo.
      const occupied = await this.liveHolidays(tx, tenantId, locationId);
      const skipped = new Map<ClassifiedRow, NewRow>(
        fresh.filter(({ id }) => !created.has(id)).map(({ row }) => [row, row]),
      );
      return rows.map((row) => {
        const candidate = skipped.get(row);
        if (!candidate) return row;
        const same = occupied.find((h) => conflictOf(candidate, h) === 'SAME');
        if (!same) throw new Error('LOCATION_HOLIDAY_IMPORT_CONFLICT_UNKNOWN');
        return {
          ...row,
          status: 'DUPLICATE' as const,
          message: HOLIDAY_MESSAGES.alreadyImported(same.name),
        };
      });
    });
  }

  /** 409 del tope por sede, con la cifra en el formato de la sede (P4). */
  private async limitReached(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationId: string,
  ): Promise<ConflictException> {
    const location = await tx.location.findFirstOrThrow({
      where: { id: locationId, tenantId },
      select: { id: true, locale: true, hourCycle: true },
    });
    return holidayLimitReached(requireLocationFormat(location));
  }

  private async readView(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationId: string,
  ): Promise<LocationCalendarView> {
    const calendar = await tx.locationWorkingCalendar.findFirst({
      where: { tenantId, locationId },
      select: { workingWeekdays: true },
    });
    // R2 roto: nunca se supone un calendario.
    if (!calendar) throw new Error('LOCATION_WORKING_CALENDAR_MISSING');
    const holidays = await this.liveHolidays(tx, tenantId, locationId);
    return {
      locationId,
      workingWeekdays: calendar.workingWeekdays,
      holidays: holidays.sort(calendarOrder),
    };
  }

  private async liveHolidays(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationId: string,
  ): Promise<HolidayView[]> {
    const rows = await tx.locationHoliday.findMany({
      where: { tenantId, locationId, deletedAt: null },
      select: HOLIDAY_SELECT,
    });
    return rows.map(toView);
  }

  /** El festivo vivo de ESTA sede; si no, 404 (también uno de otra sede). */
  private async liveHoliday(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationId: string,
    holidayId: string,
  ): Promise<HolidayView> {
    const row = await tx.locationHoliday.findFirst({
      where: { id: holidayId, tenantId, locationId, deletedAt: null },
      select: HOLIDAY_SELECT,
    });
    if (!row) throw holidayNotFound();
    return toView(row);
  }

  /**
   * Red de los índices únicos parciales (misma clase y clave): si un INSERT o
   * UPDATE choca con ellos pese al bloqueo, el mismo 409 que la comprobación.
   * La transacción ya abortó, así que el que ocupa el día se lee en otra.
   */
  private async translateUniqueViolation(
    error: unknown,
    locationId: string,
    candidate: HolidayInput | null,
    excludeId?: string,
  ): Promise<unknown> {
    if (!isUniqueViolation(error) || !candidate) return error;
    const tenantId = this.requireTenantId();
    const live = await this.prisma.runWithTenant(tenantId, (tx) =>
      this.liveHolidays(tx, tenantId, locationId),
    );
    const found = firstConflict(
      candidate,
      live.filter((h) => h.id !== excludeId),
    );
    return found ? holidayAlreadyExists(found.existing, found.conflict) : error;
  }
}
