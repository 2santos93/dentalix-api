import { regionalFormat } from '../../../shared/format/regional-format';
import type {
  HolidayCandidate,
  HolidayRowError,
  ParsedHolidayFile,
} from './holiday-file';
import {
  HOLIDAY_MESSAGES,
  HOLIDAY_NAME_MAX,
  HolidayRuleError,
  MAX_HOLIDAYS_PER_FILE,
  MAX_HOLIDAYS_PER_LOCATION,
  assertRecurringAllowed,
  classifyHolidayBatch,
  conflictOf,
  exceedsLocationLimit,
  holidayKey,
  monthDay,
  normalizeWorkingWeekdays,
  validateHolidayDate,
  validateHolidayName,
  type ClassifiedRow,
} from './holiday-rules';

function ruleError(fn: () => unknown): HolidayRuleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HolidayRuleError) return error;
    throw error;
  }
  throw new Error('expected a HolidayRuleError');
}

function csvFile(
  candidates: HolidayCandidate[],
  errors: HolidayRowError[] = [],
): ParsedHolidayFile {
  return { format: 'CSV', candidates, errors };
}

function cand(
  line: number,
  date: string,
  recurring = false,
  name = `Festivo de prueba ${String(line).padStart(2, '0')}`,
): HolidayCandidate {
  return { line, date, name, recurring };
}

/** Lo que tiene que ser igual sea cual sea el orden de las filas. */
function outcome(rows: ClassifiedRow[]) {
  return rows.map(({ line, status, message, relatedLines }) => ({
    line,
    status,
    message,
    relatedLines,
  }));
}

/** Todas las permutaciones (lotes pequeños). */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

describe('holiday-rules (DX-316)', () => {
  it('exposes the limits of the spec', () => {
    expect(HOLIDAY_NAME_MAX).toBe(120);
    expect(MAX_HOLIDAYS_PER_FILE).toBe(500);
    expect(MAX_HOLIDAYS_PER_LOCATION).toBe(1000);
  });

  describe('HOLIDAY_MESSAGES', () => {
    const deDE = regionalFormat({ locale: 'de-DE', hourCycle: 'h23' });

    it('paints the limits with the location format', () => {
      expect(HOLIDAY_MESSAGES.tooManyEntries(deDE)).toBe(
        'El archivo tiene más de 500 filas o días de festivo: divídelo.',
      );
      expect(HOLIDAY_MESSAGES.locationLimit(deDE)).toBe(
        'La sede tendría más de 1.000 festivos. Borra los de años pasados e inténtalo de nuevo.',
      );
      const enUS = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });
      expect(HOLIDAY_MESSAGES.locationLimit(enUS)).toContain('1,000');
    });

    it('keeps the spec texts verbatim', () => {
      expect(HOLIDAY_MESSAGES.csvHeader).toBe(
        'La primera fila tiene que tener las columnas «fecha» y «nombre» (y, si quieres, «recurrente»).',
      );
      expect(HOLIDAY_MESSAGES.repeatedInFile).toBe(
        'La fecha se repite en el archivo.',
      );
      expect(HOLIDAY_MESSAGES.crossClassInFile).toBe(
        'Choca con otra fila del archivo: un festivo de cada año y uno puntual no pueden caer el mismo día y mes.',
      );
      expect(HOLIDAY_MESSAGES.sameKeyConflict('Cierre anual')).toBe(
        'Ya hay un festivo ese día: «Cierre anual».',
      );
      expect(HOLIDAY_MESSAGES.nullField('fecha')).toBe(
        'Indica un valor para «fecha».',
      );
      expect(HOLIDAY_MESSAGES.extensionMismatch('csv')).toBe(
        'El archivo .csv no tiene el formato que dice su extensión.',
      );
    });
  });

  describe('normalizeWorkingWeekdays', () => {
    it('sorts and drops repeated days', () => {
      expect(normalizeWorkingWeekdays([5, 1, 1, 3])).toEqual([1, 3, 5]);
      expect(normalizeWorkingWeekdays([0, 6])).toEqual([0, 6]);
    });

    it.each<[string, unknown]>([
      ['empty list', []],
      ['not a list', 'lunes'],
      ['null', null],
    ])('%s → «Elige al menos un día hábil.»', (_label, input) => {
      const error = ruleError(() => normalizeWorkingWeekdays(input));
      expect(error.field).toBe('workingWeekdays');
      expect(error.message).toBe('Elige al menos un día hábil.');
    });

    it.each<[string, unknown[]]>([
      ['7', [7]],
      ['-1', [1, -1]],
      ['1.5', [1.5]],
      ['a string', ['1']],
      ['NaN', [Number.NaN]],
    ])('%s is out of the 0–6 range', (_label, input) => {
      const error = ruleError(() => normalizeWorkingWeekdays(input));
      expect(error.field).toBe('workingWeekdays');
      expect(error.message).toBe(
        'Los días hábiles van de 0 (domingo) a 6 (sábado).',
      );
    });
  });

  describe('validateHolidayDate', () => {
    it('accepts an ISO civil day in range (trimmed)', () => {
      expect(validateHolidayDate('2027-05-03')).toBe('2027-05-03');
      expect(validateHolidayDate(' 2000-01-01 ')).toBe('2000-01-01');
      expect(validateHolidayDate('2100-12-31')).toBe('2100-12-31');
    });

    it.each([
      '03/05/2027',
      '45413',
      '2027-5-3',
      '2027-02-29',
      '2027-13-01',
      '',
    ])('%s is not a valid date', (raw) => {
      const error = ruleError(() => validateHolidayDate(raw));
      expect(error.field).toBe('date');
      expect(error.message).toBe(
        `Fecha «${raw}» no válida: usa AAAA-MM-DD, por ejemplo 2027-05-03.`,
      );
    });

    it('a non-string is not a valid date', () => {
      expect(ruleError(() => validateHolidayDate(45413)).message).toBe(
        'Fecha «45413» no válida: usa AAAA-MM-DD, por ejemplo 2027-05-03.',
      );
      expect(ruleError(() => validateHolidayDate(undefined)).field).toBe(
        'date',
      );
    });

    it.each(['1999-12-31', '2101-01-01'])('%s is out of range', (raw) => {
      const error = ruleError(() => validateHolidayDate(raw));
      expect(error.field).toBe('date');
      expect(error.message).toBe('La fecha tiene que estar entre 2000 y 2100.');
    });
  });

  describe('validateHolidayName', () => {
    it('trims the name', () => {
      expect(validateHolidayName('  Cierre anual ')).toBe('Cierre anual');
    });

    it('accepts exactly 120 characters, counted as characters', () => {
      expect(validateHolidayName('a'.repeat(120))).toHaveLength(120);
      // 120 emojis: 240 unidades UTF-16, pero 120 caracteres (char_length).
      const emojis = '🦷'.repeat(120);
      expect(validateHolidayName(emojis)).toBe(emojis);
    });

    it('keeps zero-width joiners inside a visible name (m3)', () => {
      expect(validateHolidayName('Cierre \u{1F468}\u200D\u{1F9B7}')).toBe(
        'Cierre \u{1F468}\u200D\u{1F9B7}',
      );
    });

    it('keeps a formula-looking name as plain text (P15: only exports neutralize)', () => {
      expect(validateHolidayName('=cmd|/C calc')).toBe('=cmd|/C calc');
    });

    it.each<[string, unknown]>([
      ['121 characters', 'a'.repeat(121)],
      ['a control character', 'a\u0007'],
      ['an inner line break', 'Cierre\nanual'],
      ['a line separator', 'Cierre\u2028anual'],
      ['only spaces', '   '],
      ['empty', ''],
      ['only a zero-width space (m3)', '\u200B'],
      ['only format characters and spaces (m3)', ' \u200B\u2060\uFEFF\u200D '],
      ['a right-to-left override (m3)', 'A\u202EB'],
      ['a left-to-right embedding (m3)', '\u202ACierre anual'],
      ['a first-strong isolate (m3)', 'Cierre \u2068anual\u2069'],
      ['not a string', 12],
      ['null', null],
    ])('%s → the name message', (_label, raw) => {
      const error = ruleError(() => validateHolidayName(raw));
      expect(error.field).toBe('name');
      expect(error.message).toBe(
        'El nombre es obligatorio (hasta 120 caracteres).',
      );
    });
  });

  describe('assertRecurringAllowed', () => {
    it('recurring 29 February is rejected', () => {
      const error = ruleError(() => assertRecurringAllowed('2028-02-29', true));
      expect(error.field).toBe('recurring');
      expect(error.message).toBe(
        'Un festivo de cada año no puede ser el 29 de febrero.',
      );
    });

    it('a one-off 29 February and any other recurring day are fine', () => {
      expect(() => assertRecurringAllowed('2028-02-29', false)).not.toThrow();
      expect(() => assertRecurringAllowed('2027-02-28', true)).not.toThrow();
    });
  });

  describe('keys', () => {
    it('holidayKey and monthDay', () => {
      expect(holidayKey({ date: '2027-05-03', recurring: false })).toBe(
        'D:2027-05-03',
      );
      expect(holidayKey({ date: '2027-05-03', recurring: true })).toBe(
        'R:05-03',
      );
      expect(holidayKey({ date: '2030-05-03', recurring: true })).toBe(
        'R:05-03',
      );
      expect(monthDay('2027-05-03')).toBe('05-03');
    });
  });

  describe('conflictOf (R5 in both directions)', () => {
    const oneOff = (date: string) => ({ date, recurring: false });
    const yearly = (date: string) => ({ date, recurring: true });

    it.each<
      [
        string,
        { date: string; recurring: boolean },
        { date: string; recurring: boolean },
        string | null,
      ]
    >([
      ['same one-off', oneOff('2027-05-03'), oneOff('2027-05-03'), 'SAME'],
      [
        'same recurring, other year',
        yearly('2030-05-03'),
        yearly('2020-05-03'),
        'SAME',
      ],
      [
        'one-off on recurring',
        oneOff('2027-05-03'),
        yearly('2020-05-03'),
        'ONE_OFF_ON_RECURRING',
      ],
      [
        'recurring on one-off',
        yearly('2030-05-03'),
        oneOff('2027-05-03'),
        'RECURRING_ON_ONE_OFF',
      ],
      [
        'one-offs in different years',
        oneOff('2027-05-03'),
        oneOff('2028-05-03'),
        null,
      ],
      ['different month-day', yearly('2027-05-03'), oneOff('2027-05-04'), null],
    ])('%s', (_label, candidate, other, expected) => {
      expect(conflictOf(candidate, other)).toBe(expected);
    });
  });

  describe('classifyHolidayBatch', () => {
    // Un recurrente 05-03, un puntual 2027-05-03, dos puntuales 2027-06-01 y uno válido.
    const batch = [
      cand(2, '2030-05-03', true, 'Cierre anual'),
      cand(3, '2027-05-03'),
      cand(4, '2027-06-01'),
      cand(5, '2027-06-01'),
      cand(6, '2027-09-10'),
    ];

    it('import order does not change the classification', () => {
      const base = outcome(classifyHolidayBatch(csvFile(batch), []));
      expect(
        outcome(classifyHolidayBatch(csvFile([...batch].reverse()), [])),
      ).toEqual(base);
      for (const order of permutations(batch)) {
        expect(outcome(classifyHolidayBatch(csvFile(order), []))).toEqual(base);
      }
    });

    it('marks every row of a clash, not «the second one»', () => {
      expect(outcome(classifyHolidayBatch(csvFile(batch), []))).toEqual([
        {
          line: 2,
          status: 'ERROR',
          message: HOLIDAY_MESSAGES.crossClassInFile,
          relatedLines: [3],
        },
        {
          line: 3,
          status: 'ERROR',
          message: HOLIDAY_MESSAGES.crossClassInFile,
          relatedLines: [2],
        },
        {
          line: 4,
          status: 'ERROR',
          message: 'La fecha se repite en el archivo.',
          relatedLines: [5],
        },
        {
          line: 5,
          status: 'ERROR',
          message: 'La fecha se repite en el archivo.',
          relatedLines: [4],
        },
        { line: 6, status: 'NEW', message: null, relatedLines: [] },
      ]);
      expect(HOLIDAY_MESSAGES.crossClassInFile).toMatch(
        /^Choca con otra fila del archivo/,
      );
    });

    it('two recurring rows with the same month-day in different years repeat', () => {
      const rows = classifyHolidayBatch(
        csvFile([cand(2, '2027-12-24', true), cand(9, '2031-12-24', true)]),
        [],
      );
      expect(outcome(rows)).toEqual([
        {
          line: 2,
          status: 'ERROR',
          message: HOLIDAY_MESSAGES.repeatedInFile,
          relatedLines: [9],
        },
        {
          line: 9,
          status: 'ERROR',
          message: HOLIDAY_MESSAGES.repeatedInFile,
          relatedLines: [2],
        },
      ]);
    });

    it('a row in both kinds of clash is order-independent and lists every related line', () => {
      const rows = [
        cand(2, '2027-05-03'),
        cand(3, '2027-05-03'),
        cand(4, '2029-05-03', true),
        cand(5, '2028-05-03'),
      ];
      const base = outcome(classifyHolidayBatch(csvFile(rows), []));
      expect(base).toEqual([
        {
          line: 2,
          status: 'ERROR',
          message: HOLIDAY_MESSAGES.repeatedInFile,
          relatedLines: [3, 4],
        },
        {
          line: 3,
          status: 'ERROR',
          message: HOLIDAY_MESSAGES.repeatedInFile,
          relatedLines: [2, 4],
        },
        {
          line: 4,
          status: 'ERROR',
          message: HOLIDAY_MESSAGES.crossClassInFile,
          relatedLines: [2, 3, 5],
        },
        {
          line: 5,
          status: 'ERROR',
          message: HOLIDAY_MESSAGES.crossClassInFile,
          relatedLines: [4],
        },
      ]);
      for (const order of permutations(rows)) {
        expect(outcome(classifyHolidayBatch(csvFile(order), []))).toEqual(base);
      }
    });

    describe('against the live holidays of the location', () => {
      const existing = [
        {
          id: 'h-1',
          date: '2027-06-01',
          name: 'Festivo de prueba 01',
          recurring: false,
        },
        {
          id: 'h-2',
          date: '2020-12-24',
          name: 'Cierre anual',
          recurring: true,
        },
        {
          id: 'h-3',
          date: '2029-08-16',
          name: 'Festivo de prueba 03',
          recurring: false,
        },
        {
          id: 'h-4',
          date: '2028-08-16',
          name: 'Festivo de prueba 02',
          recurring: false,
        },
      ];

      it('same key → DUPLICATE with the existing name (never ERROR)', () => {
        const [oneOff, yearly] = classifyHolidayBatch(
          csvFile([
            cand(2, '2027-06-01', false, 'Otro nombre'),
            cand(3, '2031-12-24', true),
          ]),
          existing,
        );
        expect(oneOff).toMatchObject({
          status: 'DUPLICATE',
          message: 'Ya existe: «Festivo de prueba 01».',
          relatedLines: [],
        });
        expect(yearly).toMatchObject({
          status: 'DUPLICATE',
          message: 'Ya existe: «Cierre anual».',
        });
      });

      it('one-off on a recurring day → ERROR', () => {
        const [row] = classifyHolidayBatch(
          csvFile([cand(2, '2027-12-24')]),
          existing,
        );
        expect(row).toMatchObject({
          status: 'ERROR',
          message: 'Ese día ya es festivo cada año: «Cierre anual».',
        });
      });

      it('recurring on a one-off → ERROR naming the earliest one-off', () => {
        const [row] = classifyHolidayBatch(
          csvFile([cand(2, '2027-08-16', true)]),
          existing,
        );
        expect(row).toMatchObject({
          status: 'ERROR',
          message:
            'Ya hay un festivo puntual ese día y mes: «Festivo de prueba 02». Elimínalo antes de crear uno que se repita cada año.',
        });
      });

      it('in-file clashes win over the live holidays', () => {
        const rows = classifyHolidayBatch(
          csvFile([cand(2, '2027-06-01'), cand(3, '2027-06-01')]),
          existing,
        );
        expect(rows.map((r) => r.status)).toEqual(['ERROR', 'ERROR']);
        expect(rows[0].message).toBe(HOLIDAY_MESSAGES.repeatedInFile);
      });

      it('the outcome against live holidays does not depend on their order', () => {
        const file = csvFile([
          cand(2, '2027-08-16', true),
          cand(3, '2027-12-24'),
          cand(4, '2027-06-01'),
        ]);
        const base = outcome(classifyHolidayBatch(file, existing));
        for (const order of permutations(existing)) {
          expect(outcome(classifyHolidayBatch(file, order))).toEqual(base);
        }
      });
    });

    it('rows with a read error keep their message and stay out of the clashes', () => {
      const error: HolidayRowError = {
        line: 3,
        date: '2027-05-03',
        name: null,
        recurring: true,
        message: HOLIDAY_MESSAGES.nameInvalid,
      };
      const rows = classifyHolidayBatch(
        csvFile([cand(2, '2027-05-03'), cand(4, '2027-07-01')], [error]),
        [],
      );
      expect(rows).toEqual([
        {
          line: 2,
          date: '2027-05-03',
          name: 'Festivo de prueba 02',
          recurring: false,
          status: 'NEW',
          message: null,
          relatedLines: [],
        },
        {
          line: 3,
          date: '2027-05-03',
          name: null,
          recurring: true,
          status: 'ERROR',
          message: HOLIDAY_MESSAGES.nameInvalid,
          relatedLines: [],
        },
        {
          line: 4,
          date: '2027-07-01',
          name: 'Festivo de prueba 04',
          recurring: false,
          status: 'NEW',
          message: null,
          relatedLines: [],
        },
      ]);
    });
  });

  describe('exceedsLocationLimit (§5.1)', () => {
    const row = (status: ClassifiedRow['status']): ClassifiedRow => ({
      line: 2,
      date: '2027-05-03',
      name: 'Festivo de prueba',
      recurring: false,
      status,
      message: null,
      relatedLines: [],
    });
    const max = MAX_HOLIDAYS_PER_LOCATION;

    it('only NEW rows count: up to the cap is fine, one more is not', () => {
      expect(exceedsLocationLimit(max - 2, [row('NEW'), row('NEW')])).toBe(
        false,
      );
      expect(
        exceedsLocationLimit(max - 2, [row('NEW'), row('NEW'), row('NEW')]),
      ).toBe(true);
      expect(
        exceedsLocationLimit(max - 1, [
          row('NEW'),
          row('DUPLICATE'),
          row('ERROR'),
        ]),
      ).toBe(false);
    });

    it('a file with nothing new never hits the cap, even over it', () => {
      expect(
        exceedsLocationLimit(max + 5, [row('DUPLICATE'), row('ERROR')]),
      ).toBe(false);
    });
  });
});
