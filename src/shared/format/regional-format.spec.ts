import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { regionalFormat, UI_LANGUAGE, type HourCycle } from './regional-format';

interface GoldenCase {
  locale: string;
  hourCycle: HourCycle;
  op: string;
  args: unknown[];
  expected: unknown;
}

/**
 * Vectores de oro capturados con Node 22.16 / ICU 77.1. CLDR cambia espacios
 * y símbolos entre versiones de ICU: si cambia la versión de Node (o de ICU),
 * regenerarlos con ella y copiar el JSON byte a byte a la web (la CI compara
 * las dos copias). Un fallo aquí con otra ICU no es, por sí, un fallo del
 * helper.
 */
const CASES: GoldenCase[] = JSON.parse(
  readFileSync(join(__dirname, 'regional-format.cases.json'), 'utf8'),
) as GoldenCase[];

/** Operaciones cuyo primer argumento es un instante (ISO UTC en el JSON). */
const INSTANT_OPS = new Set([
  'date',
  'dayMonth',
  'time',
  'dateTime',
  'longDate',
  'longDateTime',
  'wallParts',
]);

function run(c: GoldenCase): unknown {
  const fmt = regionalFormat({ locale: c.locale, hourCycle: c.hourCycle });
  const args = INSTANT_OPS.has(c.op)
    ? [new Date(c.args[0] as string), ...c.args.slice(1)]
    : c.args;
  const op = (fmt as unknown as Record<string, (...a: unknown[]) => unknown>)[
    c.op
  ];
  return op(...args);
}

const AT_1505_UTC = new Date('2026-10-27T15:05:00Z');
const AT_2005_UTC = new Date('2026-10-27T20:05:00Z');
const BIDI_MARKS = /[\u200e\u200f\u061c]/;
const HEBREW = /[\u0590-\u05ff]/;

describe('regionalFormat', () => {
  it('UI_LANGUAGE is es', () => {
    expect(UI_LANGUAGE).toBe('es');
  });

  describe('golden cases', () => {
    it.each(
      CASES.map(
        (c) =>
          [
            `${c.locale} ${c.hourCycle} ${c.op}(${JSON.stringify(c.args)})`,
            c,
          ] as const,
      ),
    )('%s', (_name, c) => {
      expect(run(c)).toEqual(c.expected);
    });
  });

  it('hourCycle wins over the locale default and over -u-hc-', () => {
    expect(
      regionalFormat({ locale: 'en-US', hourCycle: 'h23' }).time(
        AT_1505_UTC,
        'UTC',
      ),
    ).toBe('15:05');
    expect(
      regionalFormat({ locale: 'de-DE', hourCycle: 'h12' }).time(
        AT_1505_UTC,
        'UTC',
      ),
    ).toBe('3:05 p. m.');
    expect(
      regionalFormat({ locale: 'en-US-u-hc-h12', hourCycle: 'h23' }).time(
        AT_1505_UTC,
        'UTC',
      ),
    ).toBe('15:05');
  });

  it('longDateTime keeps Spanish words for en-US, ja-JP, de-DE', () => {
    for (const locale of ['en-US', 'ja-JP', 'de-DE']) {
      expect(
        regionalFormat({ locale, hourCycle: 'h23' }).longDateTime(
          AT_1505_UTC,
          'UTC',
        ),
      ).toBe('martes 27 de octubre de 2026 a las 15:05');
    }
  });

  it('date order: en-US 10/27/2026, ja-JP 2026/10/27, de-DE 27.10.2026', () => {
    const date = (locale: string) =>
      regionalFormat({ locale, hourCycle: 'h23' }).date(AT_1505_UTC, 'UTC');
    expect(date('en-US')).toBe('10/27/2026');
    expect(date('ja-JP')).toBe('2026/10/27');
    expect(date('de-DE')).toBe('27.10.2026');
  });

  it('ar-EG uses latin digits and no bidi marks', () => {
    const fmt = regionalFormat({ locale: 'ar-EG', hourCycle: 'h12' });
    const outputs = [
      fmt.date(AT_1505_UTC, 'UTC'),
      fmt.dayMonth(AT_1505_UTC, 'UTC'),
      fmt.time(AT_1505_UTC, 'UTC'),
      fmt.number(1234.5),
      fmt.percent(12.5),
      fmt.money(1234.5, 'EUR'),
    ];
    for (const out of outputs) {
      expect(out).not.toMatch(BIDI_MARKS);
      expect(out).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/);
    }
    expect(fmt.date(AT_1505_UTC, 'UTC')).toBe('27/10/2026');
  });

  it('money: JPY integer without decimals, JPY with cents 2, a 2-decimal previousSet currency with 2', () => {
    const fmt = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });
    expect(fmt.money(1234, 'JPY')).toBe('¥1,234');
    expect(fmt.money(1234.5, 'JPY')).toBe('¥1,234.50');
    // COP está en previousSet (redondeo) pero ISO le da 2 decimales: se pinta con 2.
    expect(fmt.money(1234, 'COP')).toBe('COP\u00a01,234.00');
  });

  it('KWD and XYZ as code plus locale number', () => {
    const en = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });
    const de = regionalFormat({ locale: 'de-DE', hourCycle: 'h23' });
    expect(en.money(1234.5, 'KWD')).toBe('KWD\u00a01,234.50');
    expect(en.money(1234.5, 'XYZ')).toBe('XYZ\u00a01,234.50');
    expect(de.money(1234.5, 'KWD')).toBe('1.234,50\u00a0KWD');
    expect(de.money(1234.5, 'XYZ')).toBe('1.234,50\u00a0XYZ');
  });

  it('percent: en-US 12.5%, de-DE 12,5 %', () => {
    expect(
      regionalFormat({ locale: 'en-US', hourCycle: 'h12' }).percent(12.5),
    ).toBe('12.5%');
    expect(
      regionalFormat({ locale: 'de-DE', hourCycle: 'h23' }).percent(12.5),
    ).toBe('12,5\u00a0%');
  });

  it('calendar is always gregory: th-TH 27/10/2026, fa-IR 2026/10/27', () => {
    expect(
      regionalFormat({ locale: 'th-TH', hourCycle: 'h23' }).date(
        AT_1505_UTC,
        'UTC',
      ),
    ).toBe('27/10/2026');
    expect(
      regionalFormat({ locale: 'fa-IR', hourCycle: 'h23' }).date(
        AT_1505_UTC,
        'UTC',
      ),
    ).toBe('2026/10/27');
    expect(
      regionalFormat({ locale: 'ja-JP-u-ca-japanese', hourCycle: 'h23' }).date(
        AT_1505_UTC,
        'UTC',
      ),
    ).toBe('2026/10/27');
  });

  it('he-IL-u-ca-hebrew date has no Hebrew words', () => {
    const fmt = regionalFormat({
      locale: 'he-IL-u-ca-hebrew',
      hourCycle: 'h23',
    });
    const outputs = [
      fmt.date(AT_1505_UTC, 'UTC'),
      fmt.dayMonth(AT_1505_UTC, 'UTC'),
      fmt.civilDate('2026-10-27'),
      fmt.longDate(AT_1505_UTC, 'UTC'),
      fmt.longDateTime(AT_1505_UTC, 'UTC'),
    ];
    for (const out of outputs) {
      expect(out).not.toMatch(HEBREW);
      expect(out).not.toMatch(BIDI_MARKS);
      expect(out).toContain('27');
    }
    expect(fmt.date(AT_1505_UTC, 'UTC')).toContain('2026');
    expect(fmt.longDate(AT_1505_UTC, 'UTC')).toBe(
      'martes 27 de octubre de 2026',
    );
  });

  it('wallParts ignores the location calendar and numbering', () => {
    const expected = { year: 2026, month: 10, day: 27, hour: 15, minute: 5 };
    for (const locale of [
      'en-US',
      'th-TH',
      'fa-IR',
      'he-IL-u-ca-hebrew',
      'ja-JP-u-ca-japanese',
      'ar-EG-u-nu-arab',
    ]) {
      for (const hourCycle of ['h12', 'h23'] as const) {
        expect(
          regionalFormat({ locale, hourCycle }).wallParts(AT_1505_UTC, 'UTC'),
        ).toEqual(expected);
      }
    }
  });

  it('clock(15, 5) is 15:05 in h23 and 3:05 p. m. in h12', () => {
    expect(
      regionalFormat({ locale: 'en-US', hourCycle: 'h23' }).clock(15, 5),
    ).toBe('15:05');
    expect(
      regionalFormat({ locale: 'en-US', hourCycle: 'h12' }).clock(15, 5),
    ).toBe('3:05 p. m.');
    expect(
      regionalFormat({ locale: 'ja-JP', hourCycle: 'h12' }).clock(0, 0),
    ).toBe('12:00 a. m.');
    expect(
      regionalFormat({ locale: 'de-DE', hourCycle: 'h23' }).clock(9, 5),
    ).toBe('09:05');
  });

  it('clock and time compose the same way', () => {
    for (const locale of ['en-US', 'de-DE', 'ja-JP', 'da-DK']) {
      for (const hourCycle of ['h12', 'h23'] as const) {
        const fmt = regionalFormat({ locale, hourCycle });
        expect(fmt.time(AT_1505_UTC, 'UTC')).toBe(fmt.clock(15, 5));
      }
    }
  });

  it('clock rejects values out of range', () => {
    const fmt = regionalFormat({ locale: 'en-US', hourCycle: 'h23' });
    expect(() => fmt.clock(24, 0)).toThrow(RangeError);
    expect(() => fmt.clock(-1, 0)).toThrow(RangeError);
    expect(() => fmt.clock(10, 60)).toThrow(RangeError);
    expect(() => fmt.clock(10.5, 0)).toThrow(RangeError);
  });

  it("da-DK time uses ':'", () => {
    const h23 = regionalFormat({ locale: 'da-DK', hourCycle: 'h23' });
    const h12 = regionalFormat({ locale: 'da-DK', hourCycle: 'h12' });
    expect(h23.time(AT_2005_UTC, 'UTC')).toBe('20:05');
    expect(h12.time(AT_2005_UTC, 'UTC')).toBe('8:05 p. m.');
    expect(h23.dateTime(AT_2005_UTC, 'UTC')).toBe('27.10.2026 20:05');
  });

  it('longDate has no comma', () => {
    const fmt = regionalFormat({ locale: 'en-US', hourCycle: 'h23' });
    expect(fmt.longDate(AT_1505_UTC, 'UTC')).toBe(
      'martes 27 de octubre de 2026',
    );
    expect(fmt.longDate(AT_1505_UTC, 'UTC', { weekday: false })).toBe(
      '27 de octubre de 2026',
    );
    expect(fmt.longDateTime(AT_1505_UTC, 'UTC')).not.toContain(',');
  });

  describe('civil words (DX-316)', () => {
    const fmt = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });
    const processZone = process.env.TZ;

    afterEach(() => {
      if (processZone === undefined) delete process.env.TZ;
      else process.env.TZ = processZone;
    });

    it('civilLongDate gives weekday, day, month and year without a comma', () => {
      expect(fmt.civilLongDate('2027-05-03')).toBe('lunes 3 de mayo de 2027');
    });

    it('civilLongDate without weekday and year', () => {
      expect(
        fmt.civilLongDate('2027-05-03', { weekday: false, year: false }),
      ).toBe('3 de mayo');
      expect(fmt.civilLongDate('2027-05-03', { weekday: false })).toBe(
        '3 de mayo de 2027',
      );
      expect(fmt.civilLongDate('2027-05-03', { year: false })).toBe(
        'lunes 3 de mayo',
      );
    });

    it('civilLongDate rejects a day that does not exist', () => {
      expect(() => fmt.civilLongDate('2027-02-30')).toThrow(RangeError);
      expect(() => fmt.civilLongDate('2027-5-3')).toThrow(RangeError);
    });

    it('weekdayName is lower case, 0 = domingo', () => {
      expect(fmt.weekdayName(0)).toBe('domingo');
      expect(fmt.weekdayName(1)).toBe('lunes');
      expect(fmt.weekdayName(6)).toBe('sábado');
    });

    it.each([7, -1, 1.5, Number.NaN])('weekdayName(%s) throws', (weekday) => {
      expect(() => fmt.weekdayName(weekday)).toThrow(RangeError);
    });

    it('civil words do not depend on the process zone', () => {
      process.env.TZ = 'America/Los_Angeles';
      expect(fmt.weekdayName(1)).toBe('lunes');
      expect(fmt.civilLongDate('2027-05-03', { year: false })).toBe(
        'lunes 3 de mayo',
      );
      expect(
        fmt.civilLongDate('2027-05-03', { weekday: false, year: false }),
      ).toBe('3 de mayo');
    });

    it('civil words keep the Gregorian calendar for any locale', () => {
      for (const locale of ['ja-JP-u-ca-japanese', 'he-IL-u-ca-hebrew']) {
        const other = regionalFormat({ locale, hourCycle: 'h23' });
        expect(other.civilLongDate('2027-05-03')).toBe(
          'lunes 3 de mayo de 2027',
        );
        expect(other.weekdayName(3)).toBe('miércoles');
      }
    });
  });

  it('KWD money has 2 decimals', () => {
    expect(
      regionalFormat({ locale: 'en-US', hourCycle: 'h12' }).money(1, 'KWD'),
    ).toBe('KWD\u00a01.00');
    expect(
      regionalFormat({ locale: 'en-US', hourCycle: 'h12' }).money(
        1.2345,
        'KWD',
      ),
    ).toBe('KWD\u00a01.23');
  });

  it('XYZ follows Intl, malformed code falls back', () => {
    const fmt = regionalFormat({ locale: 'de-DE', hourCycle: 'h23' });
    expect(fmt.money(1234.5, 'XYZ')).toBe('1.234,50\u00a0XYZ');
    expect(fmt.money(1234.5, 'US')).toBe('US 1.234,50');
    expect(fmt.money(1234, 'EURO')).toBe('EURO 1.234,00');
  });

  it('wallParts in Pacific/Auckland across midnight', () => {
    const fmt = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });
    expect(
      fmt.wallParts(new Date('2026-10-27T10:59:00Z'), 'Pacific/Auckland'),
    ).toEqual({
      year: 2026,
      month: 10,
      day: 27,
      hour: 23,
      minute: 59,
    });
    expect(
      fmt.wallParts(new Date('2026-10-27T11:00:00Z'), 'Pacific/Auckland'),
    ).toEqual({
      year: 2026,
      month: 10,
      day: 28,
      hour: 0,
      minute: 0,
    });
  });

  it('civilDate does not shift west of UTC', () => {
    const fmt = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });
    expect(fmt.civilDate('2026-10-27')).toBe('10/27/2026');
    expect(fmt.civilDate('2026-01-01')).toBe('01/01/2026');
    // El mismo día en una zona al oeste de UTC, formateado desde su medianoche local.
    expect(
      fmt.date(new Date('2026-10-27T07:00:00Z'), 'America/Los_Angeles'),
    ).toBe(fmt.civilDate('2026-10-27'));
    expect(() => fmt.civilDate('2026-02-30')).toThrow(RangeError);
    expect(() => fmt.civilDate('27/10/2026')).toThrow(RangeError);
  });

  it('dayPeriod spaces are normalised', () => {
    for (const locale of ['en-US', 'fr-FR', 'ja-JP']) {
      const fmt = regionalFormat({ locale, hourCycle: 'h12' });
      for (const out of [
        fmt.time(AT_1505_UTC, 'UTC'),
        fmt.clock(9, 30),
        fmt.longDateTime(AT_1505_UTC, 'UTC'),
      ]) {
        expect(out).not.toMatch(/[\u00a0\u202f]/);
        expect(out).toMatch(/ [ap]\. m\.$/);
      }
    }
  });

  it('throws on an invalid locale and on h11', () => {
    expect(() =>
      regionalFormat({ locale: 'not a locale', hourCycle: 'h23' }),
    ).toThrow(RangeError);
    expect(() => regionalFormat({ locale: '', hourCycle: 'h23' })).toThrow(
      RangeError,
    );
    expect(() =>
      // @ts-expect-error h11 no es un reloj de la sede.
      regionalFormat({ locale: 'en-US', hourCycle: 'h11' }),
    ).toThrow(RangeError);
  });

  it('no default settings', () => {
    // @ts-expect-error sin ajustes no hay formato.
    expect(() => regionalFormat()).toThrow(RangeError);
    // @ts-expect-error el reloj es obligatorio.
    expect(() => regionalFormat({ locale: 'en-US' })).toThrow(RangeError);
    // @ts-expect-error el locale es obligatorio.
    expect(() => regionalFormat({ hourCycle: 'h23' })).toThrow(RangeError);
  });

  it('exposes the settings it was built with', () => {
    const fmt = regionalFormat({ locale: 'fr-FR', hourCycle: 'h12' });
    expect(fmt.locale).toBe('fr-FR');
    expect(fmt.hourCycle).toBe('h12');
  });

  it('number with min above 2 raises max to min', () => {
    // max por defecto = max(2, min): con min 3 y max 2 `Intl` lanzaría.
    const fmt = regionalFormat({ locale: 'en-US', hourCycle: 'h23' });
    expect(fmt.number(5, { min: 3 })).toBe('5.000');
    expect(fmt.number(1.23456, { min: 3 })).toBe('1.235');
  });

  it('canonicalises the locale: en-us and en-US share one cached format', () => {
    const lower = regionalFormat({ locale: 'en-us', hourCycle: 'h12' });
    const canonical = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });
    expect(lower).toBe(canonical);
    expect(lower.locale).toBe('en-US');
  });
});
