import {
  addBusinessDays,
  isBusinessDay,
  type BusinessCalendar,
} from './business-days';
import { addCivilDays, parseCivilDate } from './civil-day';

const MON_FRI: BusinessCalendar = {
  workingWeekdays: [1, 2, 3, 4, 5],
  holidays: [],
};
const SUN_THU: BusinessCalendar = {
  workingWeekdays: [0, 1, 2, 3, 4],
  holidays: [],
};

function withHolidays(
  base: BusinessCalendar,
  ...holidays: { date: string; recurring: boolean }[]
): BusinessCalendar {
  return { ...base, holidays };
}

describe('business-days (DX-316)', () => {
  describe('addBusinessDays', () => {
    it.each<[string, Date | string, number, BusinessCalendar, string, string]>([
      [
        'skips the weekend',
        '2027-01-08',
        1,
        MON_FRI,
        'Europe/Berlin',
        '2027-01-11',
      ],
      [
        'skips a one-off holiday',
        '2027-01-08',
        1,
        withHolidays(MON_FRI, { date: '2027-01-11', recurring: false }),
        'Europe/Berlin',
        '2027-01-12',
      ],
      [
        'month change with a recurring holiday',
        '2027-04-29',
        3,
        withHolidays(MON_FRI, { date: '2020-05-04', recurring: true }),
        'America/New_York',
        '2027-05-05',
      ],
      [
        'a recurring holiday applies in a year before its stored date',
        '2027-05-03',
        1,
        withHolidays(MON_FRI, { date: '2030-05-04', recurring: true }),
        'America/New_York',
        '2027-05-05',
      ],
      [
        'year change',
        '2027-12-30',
        1,
        withHolidays(MON_FRI, { date: '2027-12-31', recurring: false }),
        'Pacific/Auckland',
        '2028-01-03',
      ],
      [
        'Sunday–Thursday week',
        '2027-09-30',
        1,
        SUN_THU,
        'Asia/Tokyo',
        '2027-10-03',
      ],
      [
        'counts from Thursday in the location zone, not from the UTC Friday',
        new Date('2027-11-05T02:30:00Z'),
        1,
        MON_FRI,
        'America/New_York',
        '2027-11-05',
      ],
      [
        'crossing a DST change returns the civil day',
        new Date('2027-03-26T22:30:00Z'),
        1,
        MON_FRI,
        'Europe/Berlin',
        '2027-03-29',
      ],
      [
        "n = 0 is the location's civil day",
        new Date('2027-04-02T11:30:00Z'),
        0,
        MON_FRI,
        'Pacific/Auckland',
        '2027-04-03',
      ],
      [
        // I2: sumar 24 h al sábado 23:30 cae el lunes 00:30 (CEST) y daría el 29.
        'skips nothing across spring-forward',
        new Date('2027-03-27T22:30:00Z'),
        1,
        SUN_THU,
        'Europe/Berlin',
        '2027-03-28',
      ],
      [
        'starting on a holiday counts from the next day',
        '2027-01-11',
        1,
        withHolidays(MON_FRI, { date: '2027-01-11', recurring: false }),
        'Europe/Berlin',
        '2027-01-12',
      ],
      [
        'a one-off 29 February in a leap year is honoured',
        '2028-02-28',
        1,
        withHolidays(MON_FRI, { date: '2028-02-29', recurring: false }),
        'Asia/Tokyo',
        '2028-03-01',
      ],
    ])('%s', (_name, date, n, calendar, timeZone, expected) => {
      expect(addBusinessDays(date, n, calendar, timeZone)).toBe(expected);
    });

    it('n = 3660 is accepted', () => {
      const day = addBusinessDays('2027-01-08', 3660, MON_FRI, 'UTC');
      expect(parseCivilDate(day)).toBe(day);
      expect(day > '2040-01-01').toBe(true);
    });

    it.each([-1, 1.5, 3661, Number.NaN])('n = %s throws RangeError', (n) => {
      expect(() =>
        addBusinessDays('2027-01-08', n, MON_FRI, 'Europe/Berlin'),
      ).toThrow(RangeError);
    });

    it('an invalid zone throws with an instant and with a civil day', () => {
      expect(() =>
        addBusinessDays(
          new Date('2027-01-08T12:00:00Z'),
          1,
          MON_FRI,
          'Mars/Olympus',
        ),
      ).toThrow(RangeError);
      expect(() =>
        addBusinessDays('2027-01-08', 1, MON_FRI, 'Mars/Olympus'),
      ).toThrow(RangeError);
    });

    it('an invalid instant throws RangeError', () => {
      expect(() =>
        addBusinessDays(new Date(Number.NaN), 1, MON_FRI, 'Europe/Berlin'),
      ).toThrow(RangeError);
    });

    it('a recurring 29 February in the calendar throws RangeError', () => {
      expect(() =>
        addBusinessDays(
          '2027-01-08',
          1,
          withHolidays(MON_FRI, { date: '2020-02-29', recurring: true }),
          'Europe/Berlin',
        ),
      ).toThrow(RangeError);
    });

    it('a day that does not exist throws RangeError', () => {
      expect(() =>
        addBusinessDays('2027-02-30', 1, MON_FRI, 'Europe/Berlin'),
      ).toThrow(RangeError);
    });

    it.each([[[]], [[7]], [[-1]], [[1.5]]])(
      'workingWeekdays %j throws RangeError',
      (workingWeekdays) => {
        expect(() =>
          addBusinessDays(
            '2027-01-08',
            1,
            { workingWeekdays, holidays: [] },
            'Europe/Berlin',
          ),
        ).toThrow(RangeError);
      },
    );

    it('366 non-business days in a row throws instead of looping', () => {
      const holidays = Array.from({ length: 366 }, (_, i) => ({
        date: addCivilDays('2027-01-09', i),
        recurring: false,
      }));
      expect(() =>
        addBusinessDays(
          '2027-01-08',
          1,
          { workingWeekdays: [1, 2, 3, 4, 5], holidays },
          'Europe/Berlin',
        ),
      ).toThrow(RangeError);
    });

    it('does not mutate the calendar', () => {
      const holiday = Object.freeze({ date: '2027-01-11', recurring: false });
      const calendar = Object.freeze({
        workingWeekdays: Object.freeze([1, 2, 3, 4, 5]),
        holidays: Object.freeze([holiday]),
      });
      expect(addBusinessDays('2027-01-08', 1, calendar, 'Europe/Berlin')).toBe(
        '2027-01-12',
      );
      expect(calendar.workingWeekdays).toEqual([1, 2, 3, 4, 5]);
      expect(calendar.holidays).toEqual([
        { date: '2027-01-11', recurring: false },
      ]);
    });
  });

  describe('isBusinessDay', () => {
    const MAY_4 = withHolidays(MON_FRI, {
      date: '2020-05-04',
      recurring: true,
    });

    it('a recurring holiday is not a business day in a later year', () => {
      expect(isBusinessDay('2027-05-04', MAY_4)).toBe(false);
    });

    it('the next working weekday is a business day', () => {
      expect(isBusinessDay('2027-05-05', MAY_4)).toBe(true);
    });

    it('Sunday is a business day in a Sunday–Thursday week', () => {
      expect(isBusinessDay('2027-10-03', SUN_THU)).toBe(true);
    });

    it('Friday is not a business day in a Sunday–Thursday week', () => {
      expect(isBusinessDay('2027-10-01', SUN_THU)).toBe(false);
    });

    it('rejects a day that does not exist', () => {
      expect(() => isBusinessDay('2027-02-30', MON_FRI)).toThrow(RangeError);
    });
  });
});
