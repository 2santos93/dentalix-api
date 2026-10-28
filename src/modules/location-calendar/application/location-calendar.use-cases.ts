import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  HOLIDAY_MESSAGES,
  HolidayRuleError,
  assertRecurringAllowed,
  normalizeWorkingWeekdays,
  validateHolidayDate,
  validateHolidayName,
} from '../domain/holiday-rules';
import { holidayBadRequest } from '../domain/location-calendar-errors';
import {
  LOCATION_CALENDAR_REPOSITORY,
  type HolidayInput,
  type HolidayView,
  type LocationCalendarRepository,
  type LocationCalendarView,
} from '../domain/ports/location-calendar-repository.port';

/** La regla rota de un dato del calendario sale como 400 con su texto. */
function asBadRequest<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof HolidayRuleError) throw holidayBadRequest(error);
    throw error;
  }
}

/** Nombre de cada campo del PATCH en el mensaje de `null` (spec §6). */
const FIELD_LABELS = {
  date: 'fecha',
  name: 'nombre',
  recurring: 'recurrente',
} as const;

@Injectable()
export class GetLocationCalendarUseCase {
  constructor(
    @Inject(LOCATION_CALENDAR_REPOSITORY)
    private readonly repo: LocationCalendarRepository,
  ) {}

  execute(locationId: string): Promise<LocationCalendarView> {
    return this.repo.get(locationId);
  }
}

@Injectable()
export class SetWorkingWeekdaysUseCase {
  constructor(
    @Inject(LOCATION_CALENDAR_REPOSITORY)
    private readonly repo: LocationCalendarRepository,
  ) {}

  /** `changed` = false si los días guardados ya eran esos (no se audita). */
  async execute(
    locationId: string,
    workingWeekdays: unknown,
  ): Promise<{
    view: LocationCalendarView;
    before: number[];
    after: number[];
    changed: boolean;
  }> {
    const days = asBadRequest(() => normalizeWorkingWeekdays(workingWeekdays));
    const { before, after, view } = await this.repo.setWorkingWeekdays(
      locationId,
      days,
    );
    const changed =
      before.length !== after.length || before.some((d, i) => d !== after[i]);
    return { view, before, after, changed };
  }
}

@Injectable()
export class CreateHolidayUseCase {
  constructor(
    @Inject(LOCATION_CALENDAR_REPOSITORY)
    private readonly repo: LocationCalendarRepository,
  ) {}

  execute(
    locationId: string,
    input: { date: unknown; name: unknown; recurring?: boolean },
  ): Promise<HolidayView> {
    const holiday = asBadRequest((): HolidayInput => {
      const date = validateHolidayDate(input.date);
      const name = validateHolidayName(input.name);
      const recurring = input.recurring ?? false;
      assertRecurringAllowed(date, recurring);
      return { date, name, recurring };
    });
    return this.repo.createHoliday(locationId, holiday);
  }
}

@Injectable()
export class UpdateHolidayUseCase {
  constructor(
    @Inject(LOCATION_CALENDAR_REPOSITORY)
    private readonly repo: LocationCalendarRepository,
  ) {}

  /**
   * `raw` es el cuerpo tal como llegó: `@IsOptional()` del DTO deja pasar
   * `null`, que aquí es 400 (como G1). Un campo ausente no se toca.
   */
  execute(
    locationId: string,
    holidayId: string,
    raw: { date?: unknown; name?: unknown; recurring?: unknown },
  ): Promise<{ before: HolidayView; after: HolidayView }> {
    for (const field of ['date', 'name', 'recurring'] as const) {
      if (raw[field] === null) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message: HOLIDAY_MESSAGES.nullField(FIELD_LABELS[field]),
          field,
        });
      }
    }
    const patch = asBadRequest((): Partial<HolidayInput> => {
      const out: Partial<HolidayInput> = {};
      if (raw.date !== undefined) out.date = validateHolidayDate(raw.date);
      if (raw.name !== undefined) out.name = validateHolidayName(raw.name);
      if (typeof raw.recurring === 'boolean') out.recurring = raw.recurring;
      return out;
    });
    return this.repo.updateHoliday(locationId, holidayId, patch);
  }
}

@Injectable()
export class RetireHolidayUseCase {
  constructor(
    @Inject(LOCATION_CALENDAR_REPOSITORY)
    private readonly repo: LocationCalendarRepository,
  ) {}

  execute(locationId: string, holidayId: string): Promise<HolidayView> {
    return this.repo.retireHoliday(locationId, holidayId);
  }
}
