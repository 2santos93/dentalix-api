import type { ParsedTable } from '../../patient-imports/domain/tabular-file';
import {
  parseAmountCents,
  parseBookedOn,
  parseStatement,
  periodOf,
  truncateDescription,
  withNaturalKeys,
} from './statement-parsing';
import {
  StatementMappingError,
  readStoredMapping,
  suggestMapping,
  validateMapping,
  type StatementColumnMapping,
} from './statement-mapping';

const table = (headers: string[], rows: string[][]): ParsedTable => ({
  headers,
  rows: rows.map((cells, i) => ({ rowNumber: i + 2, cells })),
});

const SIGNED: StatementColumnMapping = {
  date: 'Fecha',
  reference: 'Referencia',
  amount: 'Monto',
  description: 'Concepto',
  dateOrder: 'DMY',
  decimalSeparator: ',',
};

describe('DX-571 · lectura del extracto (unit)', () => {
  describe('importe', () => {
    it.each([
      ['1.234,56', ',', 123456],
      ['-1.234,56', ',', -123456],
      ['1.234,56-', ',', -123456],
      ['(45,00)', ',', -4500],
      ['Bs. 4.500,00', ',', 450000],
      ['4500', ',', 450000],
      ['1,234.56', '.', 123456],
      ['USD 20.5', '.', 2050],
      ['1 234,5', ',', 123450],
    ] as const)('%s con «%s» → %d céntimos', (text, sep, cents) => {
      expect(parseAmountCents(text, sep)).toBe(cents);
    });

    it.each([['1,234'], ['12,345'], ['abc'], ['1.23.4,5'], ['']])(
      '%s no es un importe con «,»… salvo lo inequívoco',
      (text) => {
        // «1,234» con decimal «,» tiene 3 decimales: no vale.
        expect(parseAmountCents(text, ',')).toBeNull();
      },
    );

    it('una celda numérica del .xlsx se lee con punto aunque el separador sea «,»', () => {
      expect(parseAmountCents('1234.5', ',', true)).toBe(123450);
      expect(parseAmountCents('1234.5600000001', ',', true)).toBe(123456);
      expect(parseAmountCents('1234.567', ',', true)).toBeNull();
    });
  });

  describe('fecha', () => {
    it.each([
      ['15/10/2026', 'DMY', '2026-10-15'],
      ['15-10-26', 'DMY', '2026-10-15'],
      ['10/15/2026', 'MDY', '2026-10-15'],
      ['2026/10/15', 'YMD', '2026-10-15'],
      ['2026-10-15', 'MDY', '2026-10-15'],
      ['15.10.2026 08:31', 'DMY', '2026-10-15'],
    ] as const)('%s (%s) → %s', (text, order, day) => {
      expect(parseBookedOn(text, order)).toBe(day);
    });

    it.each([['31/02/2026'], ['15/13/2026'], ['ayer'], ['1/1/1990']])(
      '%s → null',
      (text) => {
        expect(parseBookedOn(text, 'DMY')).toBeNull();
      },
    );
  });

  it('descripción truncada a 140 sin controles', () => {
    expect(truncateDescription('  Pago\tmóvil  de\nX ')).toBe(
      'Pago móvil de X',
    );
    expect(truncateDescription('x'.repeat(500))).toHaveLength(140);
    expect(truncateDescription('   ')).toBeNull();
    expect(truncateDescription(undefined)).toBeNull();
  });

  it('solo guarda las ENTRADAS: salidas y ceros se ignoran; errores por fila', () => {
    const parsed = parseStatement(
      table(
        ['Fecha', 'Referencia', 'Monto', 'Concepto', 'Saldo'],
        [
          [
            '15/10/2026',
            '004512',
            '4.500,00',
            'PAGO MOVIL 0414-1234567',
            '9.000,00',
          ],
          ['15/10/2026', '777', '-120,00', 'Comisión', '8.880,00'],
          ['16/10/2026', '', '0,00', 'x', '8.880,00'],
          ['32/10/2026', '1', '10,00', 'x', '0'],
          ['16/10/2026', '2', 'diez', 'x', '0'],
          ['16/10/2026', 'R'.repeat(61), '10,00', 'x', '0'],
          ['17/10/2026', '', '25,00', '', '0'],
        ],
      ),
      SIGNED,
      'CSV',
    );
    expect(parsed.totalRows).toBe(7);
    expect(parsed.ignoredRows).toBe(2);
    expect(parsed.errorRows).toBe(3);
    expect(parsed.issues.map((i) => [i.rowNumber, i.code])).toEqual([
      [5, 'DATE_INVALID'],
      [6, 'AMOUNT_INVALID'],
      [7, 'REFERENCE_TOO_LONG'],
    ]);
    expect(parsed.credits).toEqual([
      {
        rowNumber: 2,
        bookedOn: '2026-10-15',
        reference: '004512',
        referenceNormalized: '004512',
        amountCents: 450000,
        description: 'PAGO MOVIL 0414-1234567',
      },
      {
        rowNumber: 8,
        bookedOn: '2026-10-17',
        reference: null,
        referenceNormalized: null,
        amountCents: 2500,
        description: null,
      },
    ]);
    // Ni el saldo ni otras columnas salen del parser.
    expect(Object.keys(parsed.credits[0]).sort()).toEqual([
      'amountCents',
      'bookedOn',
      'description',
      'reference',
      'referenceNormalized',
      'rowNumber',
    ]);
  });

  it('columnas de crédito y débito', () => {
    const parsed = parseStatement(
      table(
        ['Fecha', 'Ref', 'Débito', 'Crédito'],
        [
          ['01/11/2026', 'A1', '', '100,00'],
          ['01/11/2026', 'A2', '50,00', ''],
          ['01/11/2026', 'A3', '50,00', '0,00'],
        ],
      ),
      {
        date: 'Fecha',
        reference: 'Ref',
        credit: 'Crédito',
        debit: 'Débito',
        dateOrder: 'DMY',
        decimalSeparator: ',',
      },
      'CSV',
    );
    expect(parsed.credits.map((c) => c.amountCents)).toEqual([10000]);
    expect(parsed.ignoredRows).toBe(2);
  });

  it('clave natural: mismo extracto → mismas claves; idénticos legítimos → ordinales distintos', () => {
    const credits = [
      {
        rowNumber: 2,
        bookedOn: '2026-10-15',
        reference: '1',
        referenceNormalized: '1',
        amountCents: 100,
        description: null,
      },
      {
        rowNumber: 3,
        bookedOn: '2026-10-15',
        reference: '1',
        referenceNormalized: '1',
        amountCents: 100,
        description: 'otra',
      },
      {
        rowNumber: 4,
        bookedOn: '2026-10-16',
        reference: '1',
        referenceNormalized: '1',
        amountCents: 100,
        description: null,
      },
    ];
    const a = withNaturalKeys(credits);
    const b = withNaturalKeys(
      credits.map((c) => ({ ...c, rowNumber: c.rowNumber + 10 })),
    );
    expect(a.map((m) => m.ordinal)).toEqual([1, 2, 1]);
    expect(new Set(a.map((m) => m.naturalKey)).size).toBe(3);
    // Otra fila de cabecera, otra descripción: la clave no depende de eso.
    expect(b.map((m) => m.naturalKey)).toEqual(a.map((m) => m.naturalKey));
    expect(a[0].naturalKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('período del extracto', () => {
    expect(
      periodOf([{ bookedOn: '2026-10-20' }, { bookedOn: '2026-10-02' }]),
    ).toEqual({
      from: '2026-10-02',
      to: '2026-10-20',
    });
    expect(periodOf([])).toBeNull();
  });

  describe('mapeo', () => {
    const headers = [
      'Fecha',
      'Referencia',
      'Descripción',
      'Débito',
      'Crédito',
      'Saldo',
    ];

    it('sugiere por el nombre de las cabeceras', () => {
      expect(suggestMapping(headers, null)).toEqual({
        date: 'Fecha',
        reference: 'Referencia',
        credit: 'Crédito',
        debit: 'Débito',
        description: 'Descripción',
        dateOrder: 'DMY',
        decimalSeparator: ',',
      });
    });

    it('propone el guardado si sus columnas siguen en el archivo; si no, sugiere con su formato', () => {
      const stored = validateMapping(
        {
          date: 'Fecha',
          reference: 'Referencia',
          credit: 'Crédito',
          dateOrder: 'YMD',
          decimalSeparator: '.',
        },
        null,
      );
      expect(suggestMapping(headers, stored)).toEqual(stored);
      const other = suggestMapping(['Date', 'Reference', 'Amount'], stored);
      expect(other).toMatchObject({
        date: 'Date',
        reference: 'Reference',
        amount: 'Amount',
        dateOrder: 'YMD',
      });
    });

    it.each([
      [{ reference: 'Referencia', credit: 'Crédito' }, 'fecha'],
      [{ date: 'Fecha', credit: 'Crédito' }, 'referencia'],
      [{ date: 'Fecha', reference: 'Referencia' }, 'importe'],
      [
        {
          date: 'Fecha',
          reference: 'Referencia',
          amount: 'Saldo',
          credit: 'Crédito',
        },
        'no las dos',
      ],
      [
        { date: 'Fecha', reference: 'Fecha', credit: 'Crédito' },
        'un solo dato',
      ],
      [
        { date: 'Fecha', reference: 'Referencia', credit: 'Nada' },
        'no está en el archivo',
      ],
      [
        {
          date: 'Fecha',
          reference: 'Referencia',
          credit: 'Crédito',
          saldo: 'Saldo',
        },
        'no existe',
      ],
      [
        {
          date: 'Fecha',
          reference: 'Referencia',
          credit: 'Crédito',
          dateOrder: 'XYZ',
        },
        'orden',
      ],
    ])('rechaza %j (%s)', (raw, message) => {
      expect(() => validateMapping(raw, headers)).toThrow(
        StatementMappingError,
      );
      expect(() => validateMapping(raw, headers)).toThrow(
        new RegExp(message, 'i'),
      );
    });

    it('un mapeo guardado sin forma se ignora', () => {
      expect(readStoredMapping({ date: 1 })).toBeNull();
      expect(readStoredMapping(null)).toBeNull();
    });
  });
});
