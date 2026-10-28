import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { regionalFormat } from '../../../shared/format/regional-format';
import * as civilDay from '../../../shared/time/civil-day';
import { ImportFileError } from '../../patient-imports/domain/tabular-file';
import { HOLIDAY_MESSAGES, MAX_HOLIDAYS_PER_FILE } from './holiday-rules';
import { looksLikeUtf16, parseIcsHolidays } from './ics-holidays';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', name));

/** Líneas unidas con CRLF, como manda RFC 5545. */
const ics = (...lines: string[]) =>
  Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
/** Un calendario: el primer `BEGIN:VEVENT` de `body` cae en la línea 3. */
const cal = (...body: string[]) =>
  ics('BEGIN:VCALENDAR', 'VERSION:2.0', ...body, 'END:VCALENDAR');
const vevent = (...props: string[]) => ['BEGIN:VEVENT', ...props, 'END:VEVENT'];
/** Un calendario con un solo evento. */
const one = (...props: string[]) => parseIcsHolidays(cal(...vevent(...props)));

const ALL_DAY = 'DTSTART;VALUE=DATE:20270503';
const NAMED = 'SUMMARY:Cierre anual';

function fileError(fn: () => unknown): ImportFileError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ImportFileError) return error;
    throw error;
  }
  throw new Error('expected an ImportFileError');
}

/** El texto de un error de fichero sin cifras: no pide el formato de la sede. */
function fileMessage(fn: () => unknown): string {
  return fileError(fn).render(() => {
    throw new Error('fmt not needed');
  });
}

/** El único error de fila de un calendario de un evento, sin candidatos. */
function rowError(...props: string[]) {
  const parsed = one(...props);
  expect(parsed.candidates).toEqual([]);
  expect(parsed.errors).toHaveLength(1);
  return parsed.errors[0];
}

describe('parseIcsHolidays (DX-316)', () => {
  describe('fixtures', () => {
    it('parseIcsHolidays reads the 12-holiday fixture: 10 one-off and 2 yearly', () => {
      const parsed = parseIcsHolidays(fixture('holidays-12.ics'));
      expect(parsed.format).toBe('ICS');
      expect(parsed.errors).toEqual([]);
      expect(parsed.candidates).toHaveLength(12);
      expect(parsed.candidates.filter((c) => !c.recurring)).toHaveLength(10);
      expect(parsed.candidates.filter((c) => c.recurring)).toEqual([
        {
          line: 55,
          date: '2027-06-30',
          name: 'Festivo de prueba 11',
          recurring: true,
        },
        {
          line: 61,
          date: '2027-12-31',
          name: 'Festivo de prueba 12',
          recurring: true,
        },
      ]);
      expect(parsed.candidates[0]).toEqual({
        line: 5,
        date: '2027-01-11',
        name: 'Festivo de prueba 01',
        recurring: false,
      });
      expect(parsed.candidates.every((c) => c.date.startsWith('2027-'))).toBe(
        true,
      );
    });

    it('other-tool fixture yields the same 12 (date, recurring) keys', () => {
      const keys = (file: string) =>
        parseIcsHolidays(fixture(file))
          .candidates.map((c) => `${c.date}|${String(c.recurring)}`)
          .sort();
      const other = parseIcsHolidays(fixture('holidays-12-other-tool.ics'));
      expect(other.errors).toEqual([]);
      expect(keys('holidays-12-other-tool.ics')).toEqual(
        keys('holidays-12.ics'),
      );
      // Nombres distintos, desplegados y sin escapes.
      expect(other.candidates[0].name).toBe(
        'Día de cierre de la sede de pruebas, núm 01',
      );
    });

    it('the other-tool fixture really has a BOM, CRLF and folded lines', () => {
      const bytes = fixture('holidays-12-other-tool.ics');
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = bytes.toString('utf8');
      expect(text).toContain('\r\n');
      expect(text).toMatch(/\r\n[ \t]/);
      expect(text).toContain('DTEND');
      expect(text).toContain('DTSTAMP');
      expect(fixture('holidays-12.ics').toString('utf8')).not.toContain('\r');
    });
  });

  describe('content lines', () => {
    it('unfolds folded lines and unescapes SUMMARY', () => {
      const parsed = one(
        ALL_DAY,
        'SUMMARY:Cierre\\, an',
        ' ual\\nde',
        '\t prueba',
      );
      expect(parsed.candidates).toEqual([
        {
          line: 3,
          date: '2027-05-03',
          name: 'Cierre, anual de prueba',
          recurring: false,
        },
      ]);
    });

    it.each([
      ['SUMMARY:Cierre\\, anual', 'Cierre, anual'],
      ['SUMMARY:Cierre\\;anual', 'Cierre;anual'],
      ['SUMMARY:Cierre \\\\ anual', 'Cierre \\ anual'],
      ['SUMMARY:Cierre\\nanual', 'Cierre anual'],
      ['SUMMARY:Cierre\\Nanual', 'Cierre anual'],
      ['SUMMARY:\\nCierre anual\\n', 'Cierre anual'],
      ['SUMMARY:  Cierre anual  ', 'Cierre anual'],
    ])('%s → «%s»', (summary, name) => {
      expect(one(ALL_DAY, summary).candidates[0].name).toBe(name);
    });

    it('property names are case-insensitive', () => {
      const parsed = parseIcsHolidays(
        ics(
          'begin:vcalendar',
          'Begin:VEvent',
          'dtstart;value=date:20270503',
          'summary:Cierre anual',
          'rrule:freq=yearly',
          'status:confirmed',
          'end:vevent',
          'End:VCalendar',
        ),
      );
      expect(parsed.errors).toEqual([]);
      expect(parsed.candidates).toEqual([
        { line: 2, date: '2027-05-03', name: 'Cierre anual', recurring: true },
      ]);
    });

    it('SUMMARY;LANGUAGE=xx:Cierre anual → name «Cierre anual»', () => {
      expect(
        one(ALL_DAY, 'SUMMARY;LANGUAGE=xx:Cierre anual').candidates[0].name,
      ).toBe('Cierre anual');
    });

    it('quoted parameter values may hold `:`, `;` and `,`', () => {
      const parsed = one(
        'DTSTART;X-NOTE="a:b;c,d";VALUE=DATE:20270503',
        'SUMMARY;ALTREP="cid:x;y@example";LANGUAGE=xx:Cierre anual',
      );
      expect(parsed.errors).toEqual([]);
      expect(parsed.candidates).toEqual([
        { line: 3, date: '2027-05-03', name: 'Cierre anual', recurring: false },
      ]);
    });

    describe('a malformed line (no `:`, an unclosed quote) is never dropped silently', () => {
      it.each([
        ['STATUS', ['STATUS;X="oops:CANCELLED'], HOLIDAY_MESSAGES.icsCancelled],
        [
          'DTSTART',
          ['DTSTART;VALUE="DATE:20270503'],
          HOLIDAY_MESSAGES.icsDateInvalid(';VALUE="DATE:20270503'),
        ],
        [
          'DTSTART glued to its value (another name: no DTSTART)',
          ['DTSTART20270503'],
          HOLIDAY_MESSAGES.nullField('DTSTART'),
        ],
        [
          'DTSTART without `:`',
          ['DTSTART;VALUE=DATE'],
          HOLIDAY_MESSAGES.icsDateInvalid(';VALUE=DATE'),
        ],
        [
          'DTEND',
          [ALL_DAY, 'DTEND;X="a:20270505'],
          HOLIDAY_MESSAGES.icsDateInvalid(';X="a:20270505'),
        ],
        [
          'DURATION',
          [ALL_DAY, 'DURATION;X="a:P1D'],
          HOLIDAY_MESSAGES.icsBadDuration,
        ],
        [
          'RRULE',
          [ALL_DAY, 'RRULE;X="a:FREQ=YEARLY'],
          HOLIDAY_MESSAGES.icsUnsupportedRepeat,
        ],
        [
          'EXDATE',
          [ALL_DAY, 'EXDATE;X="a:20280503'],
          HOLIDAY_MESSAGES.icsUnsupportedRepeat,
        ],
        [
          'SUMMARY',
          [ALL_DAY, 'SUMMARY;LANGUAGE="es:Otro nombre'],
          HOLIDAY_MESSAGES.nameInvalid,
        ],
      ])('%s → row error', (_label, props, message) => {
        const withName = props.some((p) => p.startsWith('SUMMARY'))
          ? props
          : [...props, NAMED];
        const withStart = withName.some((p) => /^DTSTART/i.test(p))
          ? withName
          : [ALL_DAY, ...withName];
        expect(rowError(...withStart).message).toBe(message);
      });

      it('a malformed STATUS that is not CANCELLED changes nothing', () => {
        expect(
          one(ALL_DAY, 'STATUS;X="a:CONFIRMED', NAMED).candidates,
        ).toHaveLength(1);
      });

      it('nameless garbage and malformed unknown properties are ignored', () => {
        expect(
          one(ALL_DAY, '???', ':x', 'X-FOO;BAD', 'TRANSP"x', NAMED).candidates,
        ).toHaveLength(1);
      });

      it('a malformed BEGIN or END breaks the structure', () => {
        expect(
          fileMessage(() =>
            parseIcsHolidays(cal('BEGIN:VEVENT', ALL_DAY, NAMED, 'END')),
          ),
        ).toBe(HOLIDAY_MESSAGES.icsIncomplete);
        expect(
          fileMessage(() =>
            parseIcsHolidays(
              cal('BEGIN;X="a:VEVENT', ALL_DAY, NAMED, 'END:VEVENT'),
            ),
          ),
        ).toBe(HOLIDAY_MESSAGES.icsIncomplete);
      });
    });

    it('UID, DTSTAMP, X- properties and unknown properties are ignored', () => {
      const parsed = one(
        'UID:x@example',
        'DTSTAMP:20261028T120000Z',
        'X-ANYTHING;X-P=1:whatever',
        'CATEGORIES:A,B',
        'TRANSP:TRANSPARENT',
        ALL_DAY,
        NAMED,
      );
      expect(parsed.errors).toEqual([]);
      expect(parsed.candidates).toHaveLength(1);
    });

    it('line is the BEGIN:VEVENT physical line', () => {
      const parsed = parseIcsHolidays(
        ics(
          '',
          'BEGIN:VCALENDAR',
          'X-WR-CALNAME:Calendario',
          ' de prueba',
          '\t con pliegues',
          '',
          'BEGIN:VEVENT',
          ALL_DAY,
          'SUMMARY:Festivo',
          '  de prueba 01',
          'END:VEVENT',
          'BEGIN:VEVENT',
          'DTSTART;VALUE=DATE:20270504',
          'SUMMARY:Festivo de prueba 02',
          'END:VEVENT',
          'END:VCALENDAR',
        ),
      );
      expect(parsed.candidates.map((c) => [c.line, c.name])).toEqual([
        [7, 'Festivo de prueba 01'],
        [12, 'Festivo de prueba 02'],
      ]);
    });

    it('a huge folded SUMMARY is read whole and fails as a long name', () => {
      const folds = Array.from({ length: 20_000 }, () => ' abcdefghij');
      const error = rowError(ALL_DAY, 'SUMMARY:x', ...folds);
      expect(error).toMatchObject({
        line: 3,
        date: '2027-05-03',
        name: null,
        message: HOLIDAY_MESSAGES.nameInvalid,
      });
    });

    it('a folded RRULE is read after unfolding', () => {
      const parsed = one(
        ALL_DAY,
        NAMED,
        'RRULE:FREQ=YEARLY;BYMO',
        ' NTH=5;BYMONTHDAY=3',
      );
      expect(parsed.candidates[0].recurring).toBe(true);
    });
  });

  describe('duration', () => {
    it('a 2-day all-day event creates exactly 2 holidays', () => {
      const parsed = one(
        'DTSTART;VALUE=DATE:20270503',
        'DTEND;VALUE=DATE:20270505',
        NAMED,
      );
      expect(parsed.errors).toEqual([]);
      expect(parsed.candidates).toEqual([
        { line: 3, date: '2027-05-03', name: 'Cierre anual', recurring: false },
        { line: 3, date: '2027-05-04', name: 'Cierre anual', recurring: false },
      ]);
    });

    it('DURATION:P3D creates 3', () => {
      expect(
        one(ALL_DAY, 'DURATION:P3D', NAMED).candidates.map((c) => c.date),
      ).toEqual(['2027-05-03', '2027-05-04', '2027-05-05']);
    });

    it('DURATION:P1W creates 7', () => {
      const dates = one(ALL_DAY, 'DURATION:P1W', NAMED).candidates.map(
        (c) => c.date,
      );
      expect(dates).toHaveLength(7);
      expect(dates[6]).toBe('2027-05-09');
    });

    it('`+P2D` and lower-case `p2d` are 2 days', () => {
      expect(one(ALL_DAY, 'DURATION:+P2D', NAMED).candidates).toHaveLength(2);
      expect(one(ALL_DAY, 'duration:p2d', NAMED).candidates).toHaveLength(2);
    });

    it('no DTEND and no DURATION is one day', () => {
      expect(one(ALL_DAY, NAMED).candidates).toEqual([
        { line: 3, date: '2027-05-03', name: 'Cierre anual', recurring: false },
      ]);
    });

    it('31 days is the most an event can last', () => {
      expect(one(ALL_DAY, 'DURATION:P31D', NAMED).candidates).toHaveLength(31);
      expect(
        one(ALL_DAY, 'DTEND;VALUE=DATE:20270603', NAMED).candidates,
      ).toHaveLength(31);
    });

    it.each([
      ['DTEND 32 days later', 'DTEND;VALUE=DATE:20270604'],
      ['DTEND < DTSTART', 'DTEND;VALUE=DATE:20270501'],
      ['DTEND 400 days later', 'DTEND;VALUE=DATE:20280606'],
      ['DTEND far in the future', 'DTEND;VALUE=DATE:99991231'],
      ['P32D', 'DURATION:P32D'],
      ['P5W', 'DURATION:P5W'],
      ['P0D', 'DURATION:P0D'],
      ['-P1D', 'DURATION:-P1D'],
      ['an absurd DURATION', 'DURATION:P99999999999999999999999D'],
      ['an absurd week DURATION', 'DURATION:P9999999999W'],
      ['an unreadable DURATION', 'DURATION:P1X'],
      ['P1W2D (not RFC 5545)', 'DURATION:P1W2D'],
      ['an empty DURATION', 'DURATION:'],
    ])('%s → one row error, not expanded', (_label, prop) => {
      const spy = jest.spyOn(civilDay, 'addCivilDays');
      try {
        expect(rowError(ALL_DAY, prop, NAMED)).toEqual({
          line: 3,
          date: '2027-05-03',
          name: 'Cierre anual',
          recurring: false,
          message: HOLIDAY_MESSAGES.icsBadDuration,
        });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('DTEND and DURATION together → duration error, never a guess', () => {
      expect(
        rowError(ALL_DAY, 'DTEND;VALUE=DATE:20270505', 'DURATION:P1D', NAMED)
          .message,
      ).toBe(HOLIDAY_MESSAGES.icsBadDuration);
    });

    it('an impossible DTEND is a date error with its raw value', () => {
      expect(
        rowError(ALL_DAY, 'DTEND;VALUE=DATE:20270231', NAMED).message,
      ).toBe(HOLIDAY_MESSAGES.icsDateInvalid('20270231'));
    });
  });

  describe('all-day only', () => {
    it.each([
      ['DATE-TIME without TZID', 'DTSTART:20270503T090000'],
      ['DATE-TIME in UTC', 'DTSTART:20270503T000000Z'],
      ['DATE-TIME with TZID', 'DTSTART;TZID=Etc/UTC:20270503T000000'],
      ['quoted TZID', 'DTSTART;TZID="Area/City":20270503T000000'],
      ['lower-case t', 'DTSTART:20270503t000000'],
      ['VALUE=DATE-TIME', 'DTSTART;VALUE=DATE-TIME:20270503T000000'],
      ['VALUE=DATE-TIME on 8 digits', 'DTSTART;VALUE=DATE-TIME:20270503'],
      ['VALUE=PERIOD', 'DTSTART;VALUE=PERIOD:20270503/P1D'],
    ])('DATE-TIME events are rejected, not shifted: %s', (_label, start) => {
      expect(rowError(start, NAMED)).toEqual({
        line: 3,
        date: null,
        name: 'Cierre anual',
        recurring: false,
        message: HOLIDAY_MESSAGES.icsNotAllDay,
      });
    });

    it('a DATE-TIME DTEND on a DATE start is rejected', () => {
      expect(rowError(ALL_DAY, 'DTEND:20270504T000000', NAMED).message).toBe(
        HOLIDAY_MESSAGES.icsNotAllDay,
      );
    });

    it.each(['PT24H', 'P1DT2H', 'PT0S', '-PT1H'])(
      'DURATION:%s → «Solo se importan eventos de día completo.»',
      (duration) => {
        expect(rowError(ALL_DAY, `DURATION:${duration}`, NAMED).message).toBe(
          HOLIDAY_MESSAGES.icsNotAllDay,
        );
      },
    );

    it('an 8-digit start with a TZID is still that day', () => {
      expect(
        one('DTSTART;TZID=Etc/UTC:20270503', NAMED).candidates[0].date,
      ).toBe('2027-05-03');
    });
  });

  describe('dates', () => {
    it('impossible DATE 20270230 is a row error', () => {
      expect(rowError('DTSTART;VALUE=DATE:20270230', NAMED)).toEqual({
        line: 3,
        date: null,
        name: 'Cierre anual',
        recurring: false,
        message: 'Fecha «20270230» no válida.',
      });
    });

    it.each(['2027-05-03', '2027053', '202705031', '20270503,20270504', ''])(
      'DTSTART «%s» is not a date',
      (raw) => {
        const error = rowError(`DTSTART;VALUE=DATE:${raw}`, NAMED);
        expect(error.message).toBe(
          raw === ''
            ? HOLIDAY_MESSAGES.nullField('DTSTART')
            : HOLIDAY_MESSAGES.icsDateInvalid(raw),
        );
      },
    );

    it('no DTSTART → «Indica un valor para «DTSTART».»', () => {
      expect(rowError(NAMED).message).toBe(
        HOLIDAY_MESSAGES.nullField('DTSTART'),
      );
    });

    it('two DTSTART lines → date error, never the first or the last', () => {
      expect(
        rowError(ALL_DAY, 'DTSTART;VALUE=DATE:20270504', NAMED).message,
      ).toBe(HOLIDAY_MESSAGES.icsDateInvalid('20270503, 20270504'));
    });

    it('a day outside 2000–2100 is a row error with its date', () => {
      expect(rowError('DTSTART;VALUE=DATE:19991231', NAMED)).toEqual({
        line: 3,
        date: '1999-12-31',
        name: 'Cierre anual',
        recurring: false,
        message: HOLIDAY_MESSAGES.dateOutOfRange,
      });
    });

    it('an event over 31 Dec 2100 keeps its days in range', () => {
      const parsed = one('DTSTART;VALUE=DATE:21001231', 'DURATION:P2D', NAMED);
      expect(parsed.candidates.map((c) => c.date)).toEqual(['2100-12-31']);
      expect(parsed.errors).toEqual([
        {
          line: 3,
          date: '2101-01-01',
          name: 'Cierre anual',
          recurring: false,
          message: HOLIDAY_MESSAGES.dateOutOfRange,
        },
      ]);
    });
  });

  describe('repetition', () => {
    it.each([
      'FREQ=YEARLY',
      'FREQ=YEARLY;INTERVAL=1;BYMONTH=5;BYMONTHDAY=3',
      'BYMONTHDAY=3;FREQ=YEARLY',
      'FREQ=YEARLY;WKST=MO',
      'FREQ=YEARLY;BYMONTH=05',
      'freq=yearly;interval=1',
      'FREQ=YEARLY;',
    ])('RRULE:%s is «every year» on every day of the event', (rule) => {
      const parsed = one(ALL_DAY, 'DURATION:P2D', `RRULE:${rule}`, NAMED);
      expect(parsed.errors).toEqual([]);
      expect(parsed.candidates).toEqual([
        { line: 3, date: '2027-05-03', name: 'Cierre anual', recurring: true },
        { line: 3, date: '2027-05-04', name: 'Cierre anual', recurring: true },
      ]);
    });

    it.each([
      ['RRULE:FREQ=YEARLY;COUNT=3'],
      ['RRULE:FREQ=YEARLY;UNTIL=20300101'],
      ['RRULE:FREQ=YEARLY;BYDAY=4TH'],
      ['RRULE:FREQ=YEARLY;BYSETPOS=1'],
      ['RRULE:FREQ=YEARLY;BYWEEKNO=18'],
      ['RRULE:FREQ=YEARLY;BYYEARDAY=123'],
      ['RRULE:FREQ=YEARLY;INTERVAL=2'],
      ['RRULE:FREQ=YEARLY;INTERVAL=0'],
      ['RRULE:FREQ=MONTHLY'],
      ['RRULE:FREQ=DAILY'],
      ['RRULE:INTERVAL=1'],
      ['RRULE:'],
      ['RRULE:FREQ=YEARLY;BYMONTH=6'],
      ['RRULE:FREQ=YEARLY;BYMONTHDAY=4'],
      ['RRULE:FREQ=YEARLY;BYMONTH=5,6'],
      ['RRULE:FREQ=YEARLY;BYMONTHDAY=-29'],
      ['RRULE:FREQ=YEARLY;FREQ=YEARLY'],
      ['RRULE:FREQ=YEARLY;WKST=XX'],
      ['RRULE:FREQ=YEARLY;X-NAME=1'],
      ['RRULE:FREQ'],
      ['EXDATE;VALUE=DATE:20280503'],
      ['RDATE;VALUE=DATE:20280503'],
      ['RECURRENCE-ID;VALUE=DATE:20270503'],
      ['EXRULE:FREQ=YEARLY'],
    ])('%s → «Repetición no admitida…»', (prop) => {
      expect(rowError(ALL_DAY, prop, NAMED)).toEqual({
        line: 3,
        date: '2027-05-03',
        name: 'Cierre anual',
        recurring: null,
        message: HOLIDAY_MESSAGES.icsUnsupportedRepeat,
      });
    });

    it('EXDATE alongside a valid yearly RRULE is still rejected', () => {
      expect(
        rowError(
          ALL_DAY,
          'RRULE:FREQ=YEARLY',
          'EXDATE;VALUE=DATE:20280503',
          NAMED,
        ).message,
      ).toBe(HOLIDAY_MESSAGES.icsUnsupportedRepeat);
    });

    it('two RRULE lines are rejected, even if both are yearly', () => {
      expect(
        rowError(ALL_DAY, 'RRULE:FREQ=YEARLY', 'RRULE:FREQ=YEARLY', NAMED)
          .message,
      ).toBe(HOLIDAY_MESSAGES.icsUnsupportedRepeat);
    });

    it('recurring 29 February is rejected', () => {
      expect(
        rowError('DTSTART;VALUE=DATE:20280229', 'RRULE:FREQ=YEARLY', NAMED),
      ).toEqual({
        line: 3,
        date: '2028-02-29',
        name: 'Cierre anual',
        recurring: true,
        message: HOLIDAY_MESSAGES.recurringFeb29,
      });
    });

    it('a one-off 29 February is fine', () => {
      expect(one('DTSTART;VALUE=DATE:20280229', NAMED).candidates[0].date).toBe(
        '2028-02-29',
      );
    });

    it('a yearly 3-day event over 28 Feb–1 Mar 2028 errors only on the 29th', () => {
      const parsed = one(
        'DTSTART;VALUE=DATE:20280228',
        'DTEND;VALUE=DATE:20280302',
        'RRULE:FREQ=YEARLY',
        NAMED,
      );
      expect(parsed.candidates).toEqual([
        { line: 3, date: '2028-02-28', name: 'Cierre anual', recurring: true },
        { line: 3, date: '2028-03-01', name: 'Cierre anual', recurring: true },
      ]);
      expect(parsed.errors).toEqual([
        {
          line: 3,
          date: '2028-02-29',
          name: 'Cierre anual',
          recurring: true,
          message: HOLIDAY_MESSAGES.recurringFeb29,
        },
      ]);
    });
  });

  describe('status and name', () => {
    it.each(['STATUS:CANCELLED', 'status:cancelled', 'STATUS: Cancelled '])(
      '%s → «Evento cancelado: no se importa.»',
      (status) => {
        expect(rowError(ALL_DAY, status, NAMED)).toEqual({
          line: 3,
          date: '2027-05-03',
          name: 'Cierre anual',
          recurring: false,
          message: 'Evento cancelado: no se importa.',
        });
      },
    );

    it('a cancelled event is one row error, whatever else it has', () => {
      expect(
        rowError(ALL_DAY, 'DURATION:P3D', 'STATUS:CANCELLED', NAMED).message,
      ).toBe(HOLIDAY_MESSAGES.icsCancelled);
    });

    it.each(['STATUS:CONFIRMED', 'STATUS:TENTATIVE'])('%s is imported', (s) => {
      expect(one(ALL_DAY, s, NAMED).candidates).toHaveLength(1);
    });

    it.each([
      ['no SUMMARY', []],
      ['an empty SUMMARY', ['SUMMARY:']],
      ['a blank SUMMARY', ['SUMMARY:  \\n ']],
      ['only a zero-width space', ['SUMMARY:\u200B']],
      ['a bidi override', ['SUMMARY:Cierre \u202Eanual']],
      ['a control character', ['SUMMARY:Cierre\u0007anual']],
      ['121 characters', [`SUMMARY:${'a'.repeat(121)}`]],
      ['two SUMMARY lines', ['SUMMARY:Uno', 'SUMMARY:Dos']],
    ])('%s → name error', (_label, summary) => {
      expect(rowError(ALL_DAY, ...summary)).toEqual({
        line: 3,
        date: '2027-05-03',
        name: null,
        recurring: false,
        message: HOLIDAY_MESSAGES.nameInvalid,
      });
    });

    it('120 characters and an emoji ZWJ sequence are fine', () => {
      expect(
        one(ALL_DAY, `SUMMARY:${'a'.repeat(120)}`).candidates,
      ).toHaveLength(1);
      expect(
        one(ALL_DAY, 'SUMMARY:Cierre \u{1F468}\u200D\u{1F469}').candidates,
      ).toHaveLength(1);
    });
  });

  describe('components', () => {
    it('nested VALARM, VTIMEZONE, VTODO and VJOURNAL are ignored', () => {
      const parsed = parseIcsHolidays(
        cal(
          'BEGIN:VTIMEZONE',
          'TZID:Etc/UTC',
          'BEGIN:STANDARD',
          'DTSTART:19700101T000000',
          'END:STANDARD',
          'END:VTIMEZONE',
          'BEGIN:VTODO',
          'DTSTART;VALUE=DATE:20270601',
          'SUMMARY:Tarea',
          'END:VTODO',
          'BEGIN:VJOURNAL',
          'DTSTART;VALUE=DATE:20270602',
          'SUMMARY:Diario',
          'END:VJOURNAL',
          'BEGIN:VEVENT',
          ALL_DAY,
          NAMED,
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          'SUMMARY:Aviso',
          'DTSTART:20270502T090000',
          'DURATION:PT15M',
          'STATUS:CANCELLED',
          'RRULE:FREQ=DAILY',
          'END:VALARM',
          'END:VEVENT',
        ),
      );
      expect(parsed.errors).toEqual([]);
      expect(parsed.candidates).toEqual([
        {
          line: 17,
          date: '2027-05-03',
          name: 'Cierre anual',
          recurring: false,
        },
      ]);
    });

    it('a VEVENT nested inside a VTODO or another VEVENT is not top-level', () => {
      const parsed = parseIcsHolidays(
        cal(
          'BEGIN:VTODO',
          ...vevent('DTSTART;VALUE=DATE:20270601', 'SUMMARY:Dentro de tarea'),
          'END:VTODO',
          'BEGIN:VEVENT',
          ALL_DAY,
          NAMED,
          ...vevent('DTSTART;VALUE=DATE:20270602', 'SUMMARY:Anidado'),
          'END:VEVENT',
        ),
      );
      expect(parsed.errors).toEqual([]);
      expect(parsed.candidates).toEqual([
        { line: 9, date: '2027-05-03', name: 'Cierre anual', recurring: false },
      ]);
    });

    it('a second VCALENDAR in the same file is read too', () => {
      const parsed = parseIcsHolidays(
        ics(
          'BEGIN:VCALENDAR',
          ...vevent(ALL_DAY, NAMED),
          'END:VCALENDAR',
          'BEGIN:VCALENDAR',
          ...vevent('DTSTART;VALUE=DATE:20270504', 'SUMMARY:Otro'),
          'END:VCALENDAR',
        ),
      );
      expect(parsed.candidates.map((c) => c.line)).toEqual([2, 8]);
    });
  });

  describe('file errors (ImportFileError)', () => {
    it.each([
      ['a CSV', 'fecha,nombre\n2027-05-03,Cierre anual\n'],
      ['a VEVENT first', 'BEGIN:VEVENT\nDTSTART:20270503\nEND:VEVENT\n'],
      ['text before the calendar', 'hola\nBEGIN:VCALENDAR\nEND:VCALENDAR\n'],
    ])('no BEGIN:VCALENDAR (%s) → wrong format', (_label, text) => {
      expect(fileMessage(() => parseIcsHolidays(Buffer.from(text)))).toBe(
        HOLIDAY_MESSAGES.extensionMismatch('ics'),
      );
    });

    it('leading BOM, blank lines and spaces before BEGIN:VCALENDAR are fine', () => {
      const parsed = parseIcsHolidays(
        Buffer.from(
          `\uFEFF\r\n  \r\n BEGIN:VCALENDAR\r\n${vevent(ALL_DAY, NAMED).join('\r\n')}\r\nEND:VCALENDAR\r\n`,
        ),
      );
      expect(parsed.candidates).toEqual([
        { line: 4, date: '2027-05-03', name: 'Cierre anual', recurring: false },
      ]);
    });

    it.each([
      ['empty', ''],
      ['BOM only', '\uFEFF'],
      ['blank lines', '\r\n \r\n'],
    ])('%s → «El archivo está vacío.»', (_label, text) => {
      expect(fileMessage(() => parseIcsHolidays(Buffer.from(text)))).toBe(
        HOLIDAY_MESSAGES.emptyFile,
      );
    });

    it.each([
      ['no components', cal()],
      ['only a VTODO', cal('BEGIN:VTODO', ALL_DAY, NAMED, 'END:VTODO')],
    ])('%s → «El calendario no tiene eventos.»', (_label, bytes) => {
      expect(fileMessage(() => parseIcsHolidays(bytes))).toBe(
        'El calendario no tiene eventos.',
      );
    });

    it.each([
      [
        'BEGIN:VEVENT without END',
        ics('BEGIN:VCALENDAR', 'BEGIN:VEVENT', ALL_DAY, NAMED),
      ],
      [
        'END:VCALENDAR inside a VEVENT',
        ics('BEGIN:VCALENDAR', 'BEGIN:VEVENT', ALL_DAY, NAMED, 'END:VCALENDAR'),
      ],
      ['no END:VCALENDAR', ics('BEGIN:VCALENDAR', ...vevent(ALL_DAY, NAMED))],
      [
        'an unterminated nested VEVENT',
        cal('BEGIN:VEVENT', ALL_DAY, NAMED, 'BEGIN:VEVENT', 'END:VEVENT'),
      ],
      [
        'an unterminated VALARM',
        cal('BEGIN:VEVENT', ALL_DAY, NAMED, 'BEGIN:VALARM', 'END:VEVENT'),
      ],
      ['a stray END:VEVENT', cal(...vevent(ALL_DAY, NAMED), 'END:VEVENT')],
      [
        'END after the calendar',
        ics(
          'BEGIN:VCALENDAR',
          ...vevent(ALL_DAY, NAMED),
          'END:VCALENDAR',
          'END:VCALENDAR',
        ),
      ],
    ])(
      '%s → «El calendario está incompleto: falta END:VEVENT.»',
      (_label, bytes) => {
        expect(fileMessage(() => parseIcsHolidays(bytes))).toBe(
          'El calendario está incompleto: falta END:VEVENT.',
        );
      },
    );

    it.each([
      [
        'Latin-1 «Año»',
        Buffer.from(`BEGIN:VCALENDAR\r\nSUMMARY:A\xF1o\r\n`, 'latin1'),
      ],
      ['a lone continuation byte', Buffer.from([0x42, 0x80, 0x0a])],
      ['an overlong encoding', Buffer.from([0xc0, 0xaf])],
      ['a UTF-16 surrogate', Buffer.from([0xed, 0xa0, 0x80])],
      [
        'a truncated sequence',
        Buffer.concat([
          cal(...vevent(ALL_DAY, NAMED)),
          Buffer.from([0xe2, 0x82]),
        ]),
      ],
    ])(
      'bytes not UTF-8 (%s) → «El calendario no está en UTF-8.»',
      (_label, bytes) => {
        expect(fileMessage(() => parseIcsHolidays(bytes))).toBe(
          'El calendario no está en UTF-8.',
        );
      },
    );

    describe('UTF-16 (Outlook en Windows, T6 m3)', () => {
      const text = cal(...vevent(ALL_DAY, NAMED)).toString('utf8');
      const le = Buffer.from(text, 'utf16le');
      const be = Buffer.from(le).swap16();

      it.each([
        ['UTF-16 LE with BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), le])],
        ['UTF-16 BE with BOM', Buffer.concat([Buffer.from([0xfe, 0xff]), be])],
        ['UTF-16 LE without BOM', le],
        ['UTF-16 BE without BOM', be],
      ])('%s → «El calendario no está en UTF-8.»', (_label, bytes) => {
        expect(looksLikeUtf16(bytes)).toBe(true);
        expect(fileMessage(() => parseIcsHolidays(bytes))).toBe(
          'El calendario no está en UTF-8.',
        );
      });

      it('UTF-8, with or without BOM, is not UTF-16', () => {
        const utf8 = Buffer.from(text, 'utf8');
        expect(looksLikeUtf16(utf8)).toBe(false);
        expect(
          looksLikeUtf16(
            Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]),
          ),
        ).toBe(false);
        expect(looksLikeUtf16(Buffer.alloc(0))).toBe(false);
      });
    });

    describe('500 entries', () => {
      const deDE = regionalFormat({ locale: 'de-DE', hourCycle: 'h23' });
      const month = (i: number, days: number) =>
        vevent(
          `DTSTART;VALUE=DATE:2027${String((i % 12) + 1).padStart(2, '0')}01`,
          `DURATION:P${days}D`,
          `SUMMARY:Festivo de prueba ${i}`,
        );

      it('exactly 500 entries (days or row errors) are read', () => {
        const body = [
          ...Array.from({ length: 16 }, (_, i) => month(i, 28)).flat(), // 448
          ...Array.from({ length: 52 }, () =>
            vevent('DTSTART:20270503T090000', NAMED),
          ).flat(),
        ];
        const parsed = parseIcsHolidays(cal(...body));
        expect(parsed.candidates).toHaveLength(448);
        expect(parsed.errors).toHaveLength(52);
        expect(parsed.candidates.length + parsed.errors.length).toBe(
          MAX_HOLIDAYS_PER_FILE,
        );
      });

      it('> 500 days after expanding → ImportFileError painted with the location format', () => {
        const body = Array.from({ length: 17 }, (_, i) => month(i, 30)).flat();
        const error = fileError(() => parseIcsHolidays(cal(...body)));
        expect(error.render(() => deDE)).toBe(
          HOLIDAY_MESSAGES.tooManyEntries(deDE),
        );
      });

      it('501 row errors also stop the file', () => {
        const body = Array.from({ length: 501 }, () =>
          vevent(ALL_DAY, 'STATUS:CANCELLED', NAMED),
        ).flat();
        expect(fileError(() => parseIcsHolidays(cal(...body))).text).toBe(
          HOLIDAY_MESSAGES.tooManyEntries,
        );
      });

      it('stops at entry 501: later events are not expanded nor read', () => {
        const spy = jest.spyOn(civilDay, 'addCivilDays');
        try {
          const body = [
            // Dos eventos absurdos: un error de fila cada uno, sin expandir.
            ...vevent(ALL_DAY, 'DURATION:P400D', NAMED),
            ...vevent(ALL_DAY, 'DURATION:P200D', NAMED),
            ...Array.from({ length: 40 }, (_, i) => month(i, 31)).flat(),
          ];
          // Un calendario sin terminar: si siguiera leyendo, el error sería otro.
          const bytes = ics('BEGIN:VCALENDAR', ...body, 'BEGIN:VEVENT');
          expect(fileError(() => parseIcsHolidays(bytes)).text).toBe(
            HOLIDAY_MESSAGES.tooManyEntries,
          );
          // 498 días caben tras los 2 errores; el 499.º (3.er día del evento
          // 17) dispara el tope. Expandir ese evento entero pasaría de 500.
          expect(spy.mock.calls.length).toBeLessThan(MAX_HOLIDAYS_PER_FILE);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });

  describe('review T4 fixes', () => {
    /** Bytes de un calendario cuyas líneas pueden ser Buffers (para partir caracteres). */
    const raw = (...lines: (string | Buffer)[]) =>
      Buffer.concat(
        lines.flatMap((l) => [
          typeof l === 'string' ? Buffer.from(l, 'utf8') : l,
          Buffer.from('\r\n'),
        ]),
      );
    /** `text` partido en el byte `at` con un plegado CRLF + espacio. */
    const foldAtByte = (text: string, at: number) => {
      const bytes = Buffer.from(text, 'utf8');
      return Buffer.concat([
        bytes.subarray(0, at),
        Buffer.from('\r\n '),
        bytes.subarray(at),
      ]);
    };

    describe('I1: unfolding happens on bytes, before UTF-8 decoding', () => {
      it.each([
        ['a 2-byte «í»', 'SUMMARY:Día de cierre', 'SUMMARY:D'.length + 1],
        ['a 3-byte «€»', 'SUMMARY:Cierre €', 'SUMMARY:Cierre '.length + 1],
        [
          'a 3-byte «€» at its last byte',
          'SUMMARY:Cierre €',
          'SUMMARY:Cierre '.length + 2,
        ],
        ['a 4-byte emoji', 'SUMMARY:Cierre 🎉', 'SUMMARY:Cierre '.length + 2],
      ])('%s split across a fold decodes whole', (_label, summary, at) => {
        const parsed = parseIcsHolidays(
          raw(
            'BEGIN:VCALENDAR',
            'BEGIN:VEVENT',
            ALL_DAY,
            foldAtByte(summary, at),
            'END:VEVENT',
            'BEGIN:VEVENT',
            'DTSTART;VALUE=DATE:20270504',
            NAMED,
            'END:VEVENT',
            'END:VCALENDAR',
          ),
        );
        expect(parsed.errors).toEqual([]);
        expect(parsed.candidates).toEqual([
          {
            line: 2,
            date: '2027-05-03',
            name: summary.slice('SUMMARY:'.length),
            recurring: false,
          },
          // El plegado ocupa una línea física más: el segundo evento empieza en la 7.
          {
            line: 7,
            date: '2027-05-04',
            name: 'Cierre anual',
            recurring: false,
          },
        ]);
      });

      it('a split character in an ignored DESCRIPTION does not break the file', () => {
        const parsed = parseIcsHolidays(
          raw(
            'BEGIN:VCALENDAR',
            'BEGIN:VEVENT',
            ALL_DAY,
            NAMED,
            foldAtByte(
              'DESCRIPTION:Clínica cerrada',
              'DESCRIPTION:Cl'.length + 1,
            ),
            'END:VEVENT',
            'END:VCALENDAR',
          ),
        );
        expect(parsed.candidates).toHaveLength(1);
      });

      it.each([
        [
          'a lead byte before a line break (no fold)',
          Buffer.from([0x53, 0x3a, 0xc3]),
        ],
        [
          'a fold that joins two lead bytes',
          Buffer.from([0x53, 0x3a, 0xc3, 0x0d, 0x0a, 0x20, 0xc3]),
        ],
      ])('%s is still not UTF-8', (_label, bad) => {
        expect(
          fileMessage(() =>
            parseIcsHolidays(
              raw(
                'BEGIN:VCALENDAR',
                ...vevent(ALL_DAY, NAMED),
                bad,
                'END:VCALENDAR',
              ),
            ),
          ),
        ).toBe(HOLIDAY_MESSAGES.icsNotUtf8);
      });
    });

    describe('I2: a yearly event keeps only its day and month', () => {
      it('yearly 19951225 is stored as its first occurrence in range, 2000-12-25', () => {
        const parsed = one(
          'DTSTART;VALUE=DATE:19951225',
          'RRULE:FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25',
          NAMED,
        );
        expect(parsed.errors).toEqual([]);
        expect(parsed.candidates).toEqual([
          {
            line: 3,
            date: '2000-12-25',
            name: 'Cierre anual',
            recurring: true,
          },
        ]);
      });

      it('yearly 19960229 becomes 2000-02-29, the first leap year ≥ 2000, and fails as 29 February', () => {
        expect(
          rowError('DTSTART;VALUE=DATE:19960229', 'RRULE:FREQ=YEARLY', NAMED),
        ).toEqual({
          line: 3,
          date: '2000-02-29',
          name: 'Cierre anual',
          recurring: true,
          message: HOLIDAY_MESSAGES.recurringFeb29,
        });
      });

      it('yearly 19700101 and 21501225 are moved into range too', () => {
        expect(
          one('DTSTART;VALUE=DATE:19700101', 'RRULE:FREQ=YEARLY', NAMED)
            .candidates[0].date,
        ).toBe('2000-01-01');
        expect(
          one('DTSTART;VALUE=DATE:21501225', 'RRULE:FREQ=YEARLY', NAMED)
            .candidates[0].date,
        ).toBe('2000-12-25');
      });

      it('each day keeps its own day and month: 1995 has no 29 February to add', () => {
        const parsed = one(
          'DTSTART;VALUE=DATE:19950227',
          'DURATION:P3D',
          'RRULE:FREQ=YEARLY',
          NAMED,
        );
        expect(parsed.errors).toEqual([]);
        expect(parsed.candidates.map((c) => c.date)).toEqual([
          '2000-02-27',
          '2000-02-28',
          '2000-03-01',
        ]);
      });

      it('a yearly event over 31 Dec 2100 keeps 2100-12-31 and moves 1 January', () => {
        expect(
          one(
            'DTSTART;VALUE=DATE:21001231',
            'DURATION:P2D',
            'RRULE:FREQ=YEARLY',
            NAMED,
          ).candidates.map((c) => c.date),
        ).toEqual(['2100-12-31', '2000-01-01']);
      });

      it('N1: a yearly event past 9999-12-31 keeps clean dates', () => {
        const parsed = one(
          'DTSTART;VALUE=DATE:99991231',
          'DURATION:P3D',
          'RRULE:FREQ=YEARLY',
          NAMED,
        );
        expect(parsed.errors).toEqual([]);
        expect(parsed.candidates.map((c) => c.date)).toEqual([
          '2000-12-31',
          '2000-01-01',
          '2000-01-02',
        ]);
      });

      it('N1: a one-off past 9999-12-31 is out of range with its own date', () => {
        const parsed = one(
          'DTSTART;VALUE=DATE:99991231',
          'DURATION:P3D',
          NAMED,
        );
        expect(parsed.candidates).toEqual([]);
        expect(parsed.errors.map((e) => [e.date, e.message])).toEqual([
          ['9999-12-31', HOLIDAY_MESSAGES.dateOutOfRange],
          ['9999-12-31', HOLIDAY_MESSAGES.dateOutOfRange],
          ['9999-12-31', HOLIDAY_MESSAGES.dateOutOfRange],
        ]);
      });

      it('a one-off 19951225 is still out of range', () => {
        expect(rowError('DTSTART;VALUE=DATE:19951225', NAMED).message).toBe(
          HOLIDAY_MESSAGES.dateOutOfRange,
        );
      });
    });

    describe('M1: the Exchange all-day shape (local midnight + ALLDAYEVENT:TRUE)', () => {
      const ALL_DAY_FLAG = 'X-MICROSOFT-CDO-ALLDAYEVENT:TRUE';

      it('accepted with TZID: the written date, never converted', () => {
        const parsed = one(
          'DTSTART;TZID="Romance Standard Time":20270503T000000',
          'DTEND;TZID="Romance Standard Time":20270504T000000',
          ALL_DAY_FLAG,
          NAMED,
        );
        expect(parsed.errors).toEqual([]);
        expect(parsed.candidates).toEqual([
          {
            line: 3,
            date: '2027-05-03',
            name: 'Cierre anual',
            recurring: false,
          },
        ]);
      });

      it('accepted without TZID, over 2 days, with a lower-case flag', () => {
        expect(
          one(
            'DTSTART:20270503T000000',
            'DTEND:20270505T000000',
            'x-microsoft-cdo-alldayevent:true',
            NAMED,
          ).candidates.map((c) => c.date),
        ).toEqual(['2027-05-03', '2027-05-04']);
      });

      it('accepted with no DTEND, and with a DATE DTEND', () => {
        expect(
          one('DTSTART:20270503T000000', ALL_DAY_FLAG, NAMED).candidates,
        ).toHaveLength(1);
        expect(
          one(
            'DTSTART:20270503T000000',
            'DTEND;VALUE=DATE:20270504',
            ALL_DAY_FLAG,
            NAMED,
          ).candidates,
        ).toHaveLength(1);
      });

      it.each([
        [
          'ALLDAYEVENT:FALSE',
          ['DTSTART:20270503T000000', 'X-MICROSOFT-CDO-ALLDAYEVENT:FALSE'],
        ],
        [
          'no ALLDAYEVENT',
          [
            'DTSTART;TZID=Etc/UTC:20270503T000000',
            'DTEND;TZID=Etc/UTC:20270504T000000',
          ],
        ],
        [
          'a start that is not midnight',
          ['DTSTART:20270503T090000', ALL_DAY_FLAG],
        ],
        [
          'a UTC midnight (not local)',
          ['DTSTART:20270503T000000Z', ALL_DAY_FLAG],
        ],
        [
          'an end that is not midnight',
          ['DTSTART:20270503T000000', 'DTEND:20270504T090000', ALL_DAY_FLAG],
        ],
        [
          'a malformed flag',
          ['DTSTART:20270503T000000', 'X-MICROSOFT-CDO-ALLDAYEVENT;X="a:TRUE'],
        ],
        ['a midnight with seconds', ['DTSTART:20270503T000001', ALL_DAY_FLAG]],
      ])('rejected: %s', (_label, props) => {
        expect(rowError(...props, NAMED).message).toBe(
          HOLIDAY_MESSAGES.icsNotAllDay,
        );
      });

      it('an impossible midnight date is a date error', () => {
        expect(
          rowError('DTSTART:20270230T000000', ALL_DAY_FLAG, NAMED).message,
        ).toBe(HOLIDAY_MESSAGES.icsDateInvalid('20270230T000000'));
      });
    });

    it('M2: a file with only CR line breaks parses', () => {
      const parsed = parseIcsHolidays(
        Buffer.from(
          'BEGIN:VCALENDAR\rBEGIN:VEVENT\rDTSTART;VALUE=DATE:20270503\rSUMMARY:Cierre\r  anual\rEND:VEVENT\rEND:VCALENDAR\r',
        ),
      );
      expect(parsed.candidates).toEqual([
        { line: 2, date: '2027-05-03', name: 'Cierre anual', recurring: false },
      ]);
    });

    describe('M3: whitespace controls in SUMMARY are a space', () => {
      it.each([
        ['a TAB', 'Cierre\tanual'],
        ['a vertical tab', 'Cierre\u000Banual'],
        ['a form feed', 'Cierre\u000Canual'],
        ['NEL', 'Cierre\u0085anual'],
        ['a run of them', 'Cierre\t\u000Banual'],
      ])('%s', (_label, summary) => {
        expect(one(ALL_DAY, `SUMMARY:${summary}`).candidates[0].name).toBe(
          'Cierre anual',
        );
      });

      it('only TABs is still an empty name', () => {
        expect(rowError(ALL_DAY, 'SUMMARY:\t\t').message).toBe(
          HOLIDAY_MESSAGES.nameInvalid,
        );
      });
    });

    it('M4: DTEND equal to DTSTART is a one-day event', () => {
      expect(
        one(ALL_DAY, 'DTEND;VALUE=DATE:20270503', NAMED).candidates,
      ).toEqual([
        { line: 3, date: '2027-05-03', name: 'Cierre anual', recurring: false },
      ]);
    });
  });
});
