import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { regionalFormat } from '../../../shared/format/regional-format';
import * as csvParser from '../../patient-imports/domain/csv-parser';
import { ImportFileError } from '../../patient-imports/domain/tabular-file';
import { parseCsvHolidays } from './csv-holidays';
import { HOLIDAY_MESSAGES, MAX_HOLIDAYS_PER_FILE } from './holiday-rules';

const csv = (text: string) => Buffer.from(text, 'utf8');

function fileError(fn: () => unknown): ImportFileError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ImportFileError) return error;
    throw error;
  }
  throw new Error('expected an ImportFileError');
}

const ISO_HINT = (raw: string) =>
  `Fecha «${raw}» no válida: usa AAAA-MM-DD, por ejemplo 2027-05-03.`;

describe('parseCsvHolidays (DX-316)', () => {
  it('the fixture gives 5 candidates, 0 errors, and line = physical row', () => {
    const parsed = parseCsvHolidays(
      readFileSync(join(__dirname, '__fixtures__', 'holidays.csv')),
    );
    expect(parsed.format).toBe('CSV');
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toEqual([
      {
        line: 2,
        date: '2027-01-04',
        name: 'Festivo de prueba 01',
        recurring: false,
      },
      {
        line: 3,
        date: '2027-03-15',
        name: 'Festivo de prueba 02',
        recurring: false,
      },
      { line: 5, date: '2027-05-03', name: 'Cierre anual', recurring: true },
      {
        line: 6,
        date: '2027-08-16',
        name: 'Festivo de prueba 03',
        recurring: false,
      },
      {
        line: 7,
        date: '2027-11-08',
        name: 'Festivo de prueba 04',
        recurring: false,
      },
    ]);
  });

  it('reads `Date;Name;Cada año` with `;`, a BOM and CRLF', () => {
    const parsed = parseCsvHolidays(
      csv(
        '\uFEFF Date ;NAME;Cada Año\r\n2027-05-03;Cierre anual;Sí\r\n2027-06-01;Festivo de prueba 01;\r\n',
      ),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toEqual([
      { line: 2, date: '2027-05-03', name: 'Cierre anual', recurring: true },
      {
        line: 3,
        date: '2027-06-01',
        name: 'Festivo de prueba 01',
        recurring: false,
      },
    ]);
  });

  it('accepts the English aliases `date`, `name` and `recurring`', () => {
    const parsed = parseCsvHolidays(
      csv('recurring,name,date\nyes,Cierre anual,2027-05-03\n'),
    );
    expect(parsed.candidates).toEqual([
      { line: 2, date: '2027-05-03', name: 'Cierre anual', recurring: true },
    ]);
  });

  it.each<[string, boolean]>([
    ['Sí', true],
    ['si', true],
    ['YES', true],
    ['true', true],
    ['1', true],
    ['x', true],
    [' X ', true],
    ['', false],
    ['no', false],
    ['False', false],
    ['0', false],
  ])('recurrente «%s» → %s', (raw, expected) => {
    const parsed = parseCsvHolidays(
      csv(`fecha,nombre,recurrente\n2027-05-03,Cierre anual,${raw}\n`),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates[0].recurring).toBe(expected);
  });

  it('without a `recurrente` column every row is a one-off', () => {
    const parsed = parseCsvHolidays(
      csv('fecha,nombre\n2027-05-03,Cierre anual\n'),
    );
    expect(parsed.candidates).toEqual([
      { line: 2, date: '2027-05-03', name: 'Cierre anual', recurring: false },
    ]);
  });

  it.each([
    ['no `nombre` column', 'fecha,recurrente\n2027-05-03,no\n'],
    ['no `fecha` column', 'nombre\nCierre anual\n'],
    [
      'header is not on the first row',
      '\nfecha,nombre\n2027-05-03,Cierre anual\n',
    ],
  ])('%s → ImportFileError with the header message', (_label, text) => {
    const error = fileError(() => parseCsvHolidays(csv(text)));
    expect(
      error.render(() => {
        throw new Error('fmt not needed');
      }),
    ).toBe(
      'La primera fila tiene que tener las columnas «fecha» y «nombre» (y, si quieres, «recurrente»).',
    );
  });

  it.each([
    ['empty', ''],
    ['only a BOM', '\uFEFF'],
    ['only blank lines', '\r\n\r\n  \n'],
    ['only a header (m1)', 'fecha,nombre\n'],
    ['a header and blank rows (m1)', 'fecha;nombre;recurrente\r\n;;\r\n\r\n'],
  ])('%s file → «El archivo está vacío.»', (_label, text) => {
    const error = fileError(() => parseCsvHolidays(csv(text)));
    expect(
      error.render(() => {
        throw new Error('fmt not needed');
      }),
    ).toBe('El archivo está vacío.');
  });

  it('takes the delimiter from the header, not from commas in the names (m2)', () => {
    const parsed = parseCsvHolidays(
      csv('fecha;nombre\n2027-05-03;Cierre, anual, a\n2027-05-04;Otro, b, c\n'),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toEqual([
      {
        line: 2,
        date: '2027-05-03',
        name: 'Cierre, anual, a',
        recurring: false,
      },
      { line: 3, date: '2027-05-04', name: 'Otro, b, c', recurring: false },
    ]);
  });

  it('a tab-separated header is read with tabs, and `sep=` still wins (m2)', () => {
    expect(
      parseCsvHolidays(csv('fecha\tnombre\n2027-05-03\tCierre, anual; a\n'))
        .candidates[0].name,
    ).toBe('Cierre, anual; a');
    expect(
      parseCsvHolidays(csv('sep=;\nfecha;nombre\n2027-05-03;Cierre, a, b, c\n'))
        .candidates,
    ).toEqual([
      {
        line: 3,
        date: '2027-05-03',
        name: 'Cierre, a, b, c',
        recurring: false,
      },
    ]);
  });

  it.each([
    ['two inner spaces', 'cada  año'],
    ['a tab and spaces around', ' \tCada\tAño '],
    ['a no-break space', 'cada\u00A0año'],
    ['a zero-width space', 'recu\u200Brrente'],
    ['upper case with accents', 'RECURRENTE'],
  ])('recognizes the recurrente header with %s (m4)', (_label, header) => {
    const parsed = parseCsvHolidays(
      csv(`fecha,nombre,${header},notas\n2027-05-03,Cierre anual,sí,x\n`),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates[0].recurring).toBe(true);
  });

  it('extra header cells do not drop the recurrente column (m4)', () => {
    const parsed = parseCsvHolidays(
      csv(
        'notas,,fecha,recurrente,nombre,otra,recurrente\n,,2027-05-03,sí,Cierre anual,,no\n',
      ),
    );
    expect(parsed.candidates).toEqual([
      { line: 2, date: '2027-05-03', name: 'Cierre anual', recurring: true },
    ]);
  });

  it('a header mixing delimiters is the header error, never a silent drop (m4)', () => {
    const error = fileError(() =>
      parseCsvHolidays(
        csv('fecha,nombre;recurrente\n2027-05-03,Cierre anual;sí\n'),
      ),
    );
    expect(
      error.render(() => {
        throw new Error('fmt not needed');
      }),
    ).toBe(HOLIDAY_MESSAGES.csvHeader);
  });

  it('between two delimiters that both find «fecha» and «nombre», the one that also finds «recurrente» wins (m4)', () => {
    // «,» (el más frecuente) → [fecha, nombre, x, y, «z⇥recurrente⇥fecha⇥nombre»]: 2.
    // «⇥» → [«fecha,nombre,x,y,z», recurrente, fecha, nombre]: 3.
    const parsed = parseCsvHolidays(
      csv(
        'fecha,nombre,x,y,z\trecurrente\tfecha\tnombre\na,b,c,d,e\tsí\t2027-05-03\tCierre anual\n',
      ),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toEqual([
      { line: 2, date: '2027-05-03', name: 'Cierre anual', recurring: true },
    ]);
  });

  it('a mangled required header is the header error (m4)', () => {
    const error = fileError(() =>
      parseCsvHolidays(csv('fecha,nom bre\n2027-05-03,Cierre anual\n')),
    );
    expect(
      error.render(() => {
        throw new Error('fmt not needed');
      }),
    ).toBe(HOLIDAY_MESSAGES.csvHeader);
  });

  it('ignores unknown columns and skips empty rows', () => {
    const parsed = parseCsvHolidays(
      csv(
        'notas,fecha,extra,nombre\n,,,\nx,2027-05-03,y,Cierre anual\n\n , , , \n',
      ),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toEqual([
      { line: 3, date: '2027-05-03', name: 'Cierre anual', recurring: false },
    ]);
  });

  it('keeps quoted commas and escaped quotes inside the name', () => {
    const parsed = parseCsvHolidays(
      csv('fecha,nombre\n2027-05-03,"Cierre, anual ""A"""\n'),
    );
    expect(parsed.candidates[0].name).toBe('Cierre, anual "A"');
  });

  it('keeps a formula-looking name as text (P15: imports store, exports neutralize)', () => {
    const parsed = parseCsvHolidays(
      csv(
        "fecha,nombre\n2027-05-03,=cmd|' /C calc'!A0\n2027-05-04,@SUM(1+1)\n",
      ),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates.map((c) => c.name)).toEqual([
      "=cmd|' /C calc'!A0",
      '@SUM(1+1)',
    ]);
  });

  it('CSV 03/05/2027 is a row error with the ISO hint', () => {
    const parsed = parseCsvHolidays(
      csv('fecha,nombre\n03/05/2027,Cierre anual\n'),
    );
    expect(parsed.candidates).toEqual([]);
    expect(parsed.errors).toEqual([
      {
        line: 2,
        date: null,
        name: 'Cierre anual',
        recurring: false,
        message: ISO_HINT('03/05/2027'),
      },
    ]);
  });

  it('Excel serial number is a row error', () => {
    const parsed = parseCsvHolidays(csv('fecha,nombre\n45413,Cierre anual\n'));
    expect(parsed.errors[0]).toMatchObject({
      line: 2,
      date: null,
      message: ISO_HINT('45413'),
    });
  });

  it.each(['2027-02-29', '2027-13-01', '2027-04-31', '27-05-03', ''])(
    'impossible or malformed date «%s» is a row error',
    (raw) => {
      const parsed = parseCsvHolidays(
        csv(`fecha,nombre\n${raw},Cierre anual\n`),
      );
      expect(parsed.candidates).toEqual([]);
      expect(parsed.errors[0]).toMatchObject({
        line: 2,
        message: ISO_HINT(raw),
      });
    },
  );

  it.each(['2101-01-01', '1999-12-31'])('%s → range error', (raw) => {
    const parsed = parseCsvHolidays(csv(`fecha,nombre\n${raw},Cierre anual\n`));
    expect(parsed.errors[0]).toMatchObject({
      line: 2,
      date: null,
      message: 'La fecha tiene que estar entre 2000 y 2100.',
    });
  });

  it('a name over 120 characters, or with a control character, is a row error', () => {
    const parsed = parseCsvHolidays(
      csv(
        `fecha,nombre\n2027-05-03,${'a'.repeat(121)}\n2027-05-04,"Cierre\u0007"\n2027-05-05,\n2027-05-06,${'b'.repeat(120)}\n`,
      ),
    );
    expect(parsed.errors).toEqual(
      [2, 3, 4].map((line) => ({
        line,
        date: `2027-05-0${line + 1}`,
        name: null,
        recurring: false,
        message: 'El nombre es obligatorio (hasta 120 caracteres).',
      })),
    );
    expect(parsed.candidates).toEqual([
      { line: 5, date: '2027-05-06', name: 'b'.repeat(120), recurring: false },
    ]);
  });

  it('recurrente = quizá → «En «recurrente» escribe sí o no.»', () => {
    const parsed = parseCsvHolidays(
      csv('fecha,nombre,recurrente\n2027-05-03,Cierre anual,quizá\n'),
    );
    expect(parsed.errors).toEqual([
      {
        line: 2,
        date: '2027-05-03',
        name: 'Cierre anual',
        recurring: null,
        message: 'En «recurrente» escribe sí o no.',
      },
    ]);
  });

  it('a recurring 29 February is a row error; a one-off one is fine', () => {
    const parsed = parseCsvHolidays(
      csv(
        'fecha,nombre,recurrente\n2028-02-29,Cierre anual,sí\n2028-02-29,Festivo de prueba 01,no\n',
      ),
    );
    expect(parsed.errors).toEqual([
      {
        line: 2,
        date: '2028-02-29',
        name: 'Cierre anual',
        recurring: true,
        message: 'Un festivo de cada año no puede ser el 29 de febrero.',
      },
    ]);
    expect(parsed.candidates).toEqual([
      {
        line: 3,
        date: '2028-02-29',
        name: 'Festivo de prueba 01',
        recurring: false,
      },
    ]);
  });

  it('reports the date error first when a row has several', () => {
    const parsed = parseCsvHolidays(
      csv('fecha,nombre,recurrente\nmañana,,quizá\n'),
    );
    expect(parsed.errors[0].message).toBe(ISO_HINT('mañana'));
  });

  describe(`more than ${MAX_HOLIDAYS_PER_FILE} entries`, () => {
    const deDE = regionalFormat({ locale: 'de-DE', hourCycle: 'h23' });

    function rows(count: number, row: (i: number) => string): string {
      return Array.from({ length: count }, (_, i) => row(i)).join('\n');
    }

    it('exactly 500 entries (valid or with errors) are read', () => {
      const text = `fecha,nombre\n${rows(250, () => '2027-05-03,Cierre anual')}\n${rows(250, () => 'x,Cierre anual')}\n`;
      const parsed = parseCsvHolidays(csv(text));
      expect(parsed.candidates).toHaveLength(250);
      expect(parsed.errors).toHaveLength(250);
    });

    it.each([
      ['valid', '2027-05-03,Cierre anual'],
      ['with errors', 'x,Cierre anual'],
    ])(
      '501 %s entries → ImportFileError painted with the location format',
      (_label, row) => {
        const error = fileError(() =>
          parseCsvHolidays(csv(`fecha,nombre\n${rows(501, () => row)}\n`)),
        );
        expect(error.render(() => deDE)).toBe(
          HOLIDAY_MESSAGES.tooManyEntries(deDE),
        );
        expect(error.render(() => deDE)).toContain('500');
      },
    );

    it('blank lines do not count', () => {
      const text = `fecha,nombre\n${rows(400, () => '')}\n${rows(500, () => '2027-05-03,Cierre anual')}\n\n\n`;
      expect(parseCsvHolidays(csv(text)).candidates).toHaveLength(500);
    });

    it('the reader stops at entry 501 instead of reading the whole file', () => {
      const realCsvRecords = csvParser.csvRecords;
      const parse = jest.spyOn(csvParser, 'csvRecords');
      let pulled = 0;
      parse.mockImplementation(function* (...args) {
        for (const record of realCsvRecords(...args)) {
          pulled += 1;
          yield record;
        }
      });
      try {
        const error = fileError(() =>
          parseCsvHolidays(
            csv(
              `fecha,nombre\n${rows(2000, () => '2027-05-03,Cierre anual')}\n`,
            ),
          ),
        );
        expect(error.render(() => deDE)).toBe(
          HOLIDAY_MESSAGES.tooManyEntries(deDE),
        );
        // La cabecera con cada uno de los 3 separadores, y luego la cabecera
        // y 501 entradas: ni una fila más.
        expect(pulled).toBe(3 + 502);
      } finally {
        parse.mockRestore();
      }
    });
  });
});
