import { toTable } from './tabular-file';
import {
  BALANCE_TEMPLATE_HEADERS,
  aggregateBalances,
  balanceTemplateCsv,
  parseAmountCents,
  resolveBalanceColumns,
  validateBalanceRow,
  type BalanceCandidate,
  type BalanceRowContext,
} from './opening-balance-sheet';
import { ImportFileError } from './tabular-file';
import { regionalFormat } from '../../../shared/format/regional-format';

/** La sede del lote de las pruebas de siempre (lo que mostraba). */
const FMT = () => regionalFormat({ locale: 'es-CO', hourCycle: 'h23' });

const CTX: BalanceRowContext = {
  today: '2026-10-23',
  currencies: new Set(['COP', 'USD', 'EUR']),
  format: 'CSV',
};

const errorOf = (r: { cents: number } | { error: string }): string =>
  'error' in r ? r.error : '';

function table(rows: string[][]) {
  return toTable(rows.map((cells, i) => ({ rowNumber: i + 1, cells })));
}

describe('importe del saldo migrado (DX-262)', () => {
  it.each([
    ['150000', 15_000_000],
    ['150.000', 15_000_000],
    ['1.234.567,50', 123_456_750],
    ['1,234,567.50', 123_456_750],
    ['$ 1.500.000', 150_000_000],
    ['COP 2.000', 200_000],
    ['1500,5', 150_050],
    ['1500.75', 150_075],
    ['  99  ', 9_900],
    ['€12,30', 1_230],
  ])('«%s» → %i céntimos', (raw, cents) => {
    expect(parseAmountCents(raw, 'CSV')).toEqual({ cents });
  });

  it('en XLSX un número con punto es siempre decimal (celda numérica)', () => {
    expect(parseAmountCents('1234.5', 'XLSX')).toEqual({ cents: 123_450 });
    expect(parseAmountCents('1500000', 'XLSX')).toEqual({ cents: 150_000_000 });
    // Texto escrito a mano en la hoja: mismas reglas que el CSV.
    expect(parseAmountCents('1.500.000', 'XLSX')).toEqual({
      cents: 150_000_000,
    });
  });

  it('XLSX con fórmula: el ruido de coma flotante se redondea a 2 decimales (revisión M6)', () => {
    expect(parseAmountCents('178500.00000000003', 'XLSX')).toEqual({
      cents: 17_850_000,
    });
    expect(parseAmountCents('0.30000000000000004', 'XLSX')).toEqual({
      cents: 30,
    });
    // Importes grandes en COP: el ruido crece con el valor (QA N2,
    // `=0,1*3*1000000000`), y la tolerancia es relativa.
    expect(parseAmountCents('300000000.00000006', 'XLSX')).toEqual({
      cents: 30_000_000_000,
    });
    expect(parseAmountCents('999999999.9900001', 'XLSX')).toEqual({
      cents: 99_999_999_999,
    });
    // Un tercer decimal de verdad sigue siendo error, también en grande.
    expect(parseAmountCents('300000000.001', 'XLSX')).toEqual({
      error: 'El importe tiene más de 2 decimales.',
    });
    expect(parseAmountCents('2000000000.001', 'XLSX')).toEqual({
      error: 'El importe tiene más de 2 decimales.',
    });
    expect(parseAmountCents('10.555', 'XLSX')).toEqual({
      error: 'El importe tiene más de 2 decimales.',
    });
  });

  it('rechaza importes no positivos, con letras, con 3 decimales o enormes', () => {
    expect(errorOf(parseAmountCents('0', 'CSV'))).toBe(
      'El importe debe ser mayor que 0.',
    );
    expect(errorOf(parseAmountCents('-5000', 'CSV'))).toBe(
      'El importe debe ser mayor que 0.',
    );
    expect(errorOf(parseAmountCents('(5.000)', 'CSV'))).toBe(
      'El importe debe ser mayor que 0.',
    );
    expect(errorOf(parseAmountCents('cien mil', 'CSV'))).toMatch(
      /no es un número/,
    );
    expect(errorOf(parseAmountCents('12.5.3,1,2', 'CSV'))).toMatch(
      /no es un número/,
    );
    expect(errorOf(parseAmountCents('10,555', 'XLSX'))).toBe('');
    expect(errorOf(parseAmountCents('10.5551', 'XLSX'))).toBe(
      'El importe tiene más de 2 decimales.',
    );
    expect(errorOf(parseAmountCents('1e6', 'CSV'))).toMatch(
      /notación científica/,
    );
    expect(errorOf(parseAmountCents('10000000000000', 'CSV'))).toMatch(
      /demasiado grande/,
    );
  });
});

describe('columnas de la hoja de saldos (DX-262)', () => {
  it('reconoce la plantilla y sinónimos habituales sin tildes', () => {
    expect(resolveBalanceColumns([...BALANCE_TEMPLATE_HEADERS])).toEqual({
      docNumber: 'numero_documento',
      amount: 'importe',
      currency: 'moneda',
      asOfDate: 'fecha_antiguedad',
      concept: 'concepto',
    });
    expect(
      resolveBalanceColumns([
        'Número de Documento',
        'Saldo',
        'Divisa',
        'Fecha de corte',
      ]),
    ).toEqual({
      docNumber: 'Número de Documento',
      amount: 'Saldo',
      currency: 'Divisa',
      asOfDate: 'Fecha de corte',
    });
  });

  it('sin documento, importe o moneda: error del archivo en español', () => {
    expect(() => resolveBalanceColumns(['documento', 'saldo'])).toThrow(
      ImportFileError,
    );
    expect(() => resolveBalanceColumns(['documento', 'saldo'])).toThrow(
      'A la hoja de saldos le falta la columna «Moneda». Usa la plantilla: numero_documento, importe, moneda, fecha_antiguedad (opcional) y concepto (opcional).',
    );
  });

  it('la plantilla trae BOM, las cabeceras y una fila de ejemplo ficticia', () => {
    const csv = balanceTemplateCsv('COP');
    expect(csv.startsWith('﻿"numero_documento","importe","moneda"')).toBe(true);
    expect(csv).toContain('Fila de ejemplo: bórrala antes de importar');
  });

  it('balance template uses the location currency', () => {
    const csv = balanceTemplateCsv('JPY');
    expect(csv).toContain('"JPY"');
    expect(csv).not.toContain('COP');
  });
});

describe('validación de una fila de saldo (DX-262)', () => {
  const t = table([
    ['numero_documento', 'importe', 'moneda', 'fecha_antiguedad', 'concepto'],
    ['1.020.304', '150.000', 'cop', '15/03/2026', 'Ortodoncia 2025'],
    ['', '-3', 'XYZ', '2026-12-01', 'x'.repeat(201)],
    ['55', '100', 'USD', '', ''],
  ]);
  const cols = resolveBalanceColumns(t.headers);

  it('una fila buena: clave del documento, céntimos, moneda en mayúsculas, fecha ISO', () => {
    const r = validateBalanceRow(t.rows[0], cols, CTX, t.headers);
    expect(r.issues).toEqual([]);
    expect(r.counted).toEqual({ currency: 'COP', cents: 15_000_000 });
    expect(r.candidate).toEqual({
      rowNumber: 2,
      docKey: '1020304',
      docNumber: '1.020.304',
      cents: 15_000_000,
      currency: 'COP',
      asOfDate: '2026-03-15',
      concept: 'Ortodoncia 2025',
    });
  });

  it('cada problema de la fila con su columna y en español', () => {
    const r = validateBalanceRow(t.rows[1], cols, CTX, t.headers);
    expect(r.candidate).toBeNull();
    expect(r.counted).toBeNull();
    expect(r.issues.map((i) => [i.column, i.message])).toEqual([
      ['numero_documento', 'Falta el número de documento del paciente.'],
      ['importe', 'El importe debe ser mayor que 0.'],
      [
        'moneda',
        'La moneda «XYZ» no está admitida en la clínica. Admitidas: COP, EUR, USD.',
      ],
      ['fecha_antiguedad', 'La fecha de antigüedad es futura.'],
      ['concepto', 'El concepto tiene más de 200 caracteres.'],
    ]);
    expect(r.issues.every((i) => i.kind === 'ERROR' && i.row === 3)).toBe(true);
  });

  it('sin fecha ni concepto: null (se usará la fecha de importación, aproximada)', () => {
    const r = validateBalanceRow(t.rows[2], cols, CTX, t.headers);
    expect(r.candidate).toMatchObject({ asOfDate: null, concept: null });
  });
});

describe('agregado por paciente y moneda (DX-262)', () => {
  const c = (
    rowNumber: number,
    docKey: string,
    cents: number,
    currency: string,
    asOfDate: string | null = null,
    concept: string | null = null,
  ): BalanceCandidate => ({
    rowNumber,
    docKey,
    docNumber: docKey,
    cents,
    currency,
    asOfDate,
    concept,
  });

  it('suma las filas del mismo paciente y moneda, con la fecha más antigua, y lo indica', () => {
    const result = aggregateBalances(
      [
        c(2, '111', 10_000, 'COP', '2026-05-01', 'Ortodoncia'),
        c(3, '111', 5_050, 'COP', '2026-02-10'),
        c(4, '111', 700, 'USD'),
        c(5, '222', 20_000, 'COP'),
      ],
      new Map([
        ['111', 'FOUND'],
        ['222', 'FOUND'],
      ]),
      'numero_documento',
      FMT,
    );
    expect(result.prepared).toEqual([
      {
        rowNumber: 2,
        docKey: '111',
        currency: 'COP',
        cents: 15_050,
        asOfDate: '2026-02-10',
        concept: 'Ortodoncia',
        sourceRows: 2,
      },
      {
        rowNumber: 4,
        docKey: '111',
        currency: 'USD',
        cents: 700,
        asOfDate: null,
        concept: null,
        sourceRows: 1,
      },
      {
        rowNumber: 5,
        docKey: '222',
        currency: 'COP',
        cents: 20_000,
        asOfDate: null,
        concept: null,
        sourceRows: 1,
      },
    ]);
    expect(result.mergedRows).toBe(1);
    expect(result.issues).toEqual([
      {
        row: 3,
        column: 'numero_documento',
        kind: 'MERGED',
        message:
          'Mismo paciente y moneda que la fila 2: se suman en un solo saldo migrado.',
        value: '111',
      },
    ]);
    // Totales a importar por moneda, sin mezclar monedas.
    expect(result.validTotals).toEqual([
      { currency: 'COP', rows: 3, cents: 35_050 },
      { currency: 'USD', rows: 1, cents: 700 },
    ]);
  });

  it('la suma de un paciente y moneda no puede pasar de DECIMAL(14,2): error de la fila (revisión M2)', () => {
    const big = 99_999_999_999_999; // 999.999.999.999,99
    const result = aggregateBalances(
      [
        c(2, '111', big - 100, 'COP'),
        c(3, '111', 200, 'COP'),
        c(4, '111', 50, 'USD'),
      ],
      new Map([['111', 'FOUND']]),
      'numero_documento',
      FMT,
    );
    expect(result.prepared.map((p) => [p.currency, p.cents])).toEqual([
      ['COP', big - 100],
      ['USD', 50],
    ]);
    expect(result.errorRows).toBe(1);
    expect(result.issues).toEqual([
      {
        row: 3,
        column: 'numero_documento',
        kind: 'ERROR',
        message:
          'Con esta fila, el saldo de este paciente en COP pasaría de 999.999.999.999,99: revisa los importes.',
        value: '111',
      },
    ]);
  });

  describe('paciente con un saldo migrado vivo de otro lote (QA D1)', () => {
    const existing = new Map([
      [
        '111\u0000COP',
        {
          count: 1,
          cents: 150_000_000,
          latest: {
            cents: 150_000_000,
            asOfDate: '2026-08-09',
            fileName: 'existentes.csv',
            importedOn: '2026-10-22',
          },
        },
      ],
      [
        '222\u0000COP',
        {
          count: 2,
          cents: 300_000,
          latest: {
            cents: 100_000,
            asOfDate: '2026-09-01',
            fileName: 'otra.csv',
            importedOn: '2026-10-21',
          },
        },
      ],
    ]);
    const docs = new Map([
      ['111', 'FOUND' as const],
      ['222', 'FOUND' as const],
      ['333', 'FOUND' as const],
    ]);
    const rows = [
      c(2, '111', 150_000_000, 'COP'),
      c(3, '111', 1_000, 'COP'),
      c(4, '111', 4_000, 'USD'),
      c(5, '222', 7_000, 'COP'),
      c(6, '333', 9_000, 'COP'),
    ];

    it('por defecto NO lo crea: error en cada fila, con importe, lote y corte del existente', () => {
      const result = aggregateBalances(
        rows,
        docs,
        'numero_documento',
        FMT,
        existing,
      );
      // Otra moneda del mismo paciente y otro paciente: sí.
      expect(result.prepared.map((p) => [p.docKey, p.currency])).toEqual([
        ['111', 'USD'],
        ['333', 'COP'],
      ]);
      expect(result.errorRows).toBe(3);
      expect(result.mergedRows).toBe(0);
      expect(result.issues).toEqual([
        {
          row: 2,
          column: 'numero_documento',
          kind: 'ERROR',
          message: expect.stringMatching(
            /^Este paciente ya tiene un saldo migrado vivo de \$\s1\.500\.000,00 \(lote «existentes\.csv» del 22\/10\/2026, corte 09\/08\/2026\): no se crea otro\. Si es otra deuda, marca «Añadir aunque ya tenga saldo migrado» y vuelve a subir la hoja\.$/,
          ) as string,
          value: '111',
        },
        expect.objectContaining({ row: 3, kind: 'ERROR' }),
        {
          row: 5,
          column: 'numero_documento',
          kind: 'ERROR',
          message: expect.stringMatching(
            /^Este paciente ya tiene 2 saldos migrados vivos en COP por \$\s3\.000,00 \(el último, \$\s1\.000,00 del lote «otra\.csv» del 21\/10\/2026, corte 01\/09\/2026\): no se crea otro\./,
          ) as string,
          value: '222',
        },
      ]);
      expect(result.validTotals).toEqual([
        { currency: 'COP', rows: 1, cents: 9_000 },
        { currency: 'USD', rows: 1, cents: 4_000 },
      ]);
    });

    it('opening balance duplicate message uses fmt.money', () => {
      const result = aggregateBalances(
        rows,
        docs,
        'numero_documento',
        () => regionalFormat({ locale: 'en-US', hourCycle: 'h12' }),
        existing,
      );
      expect(result.issues[0].message).toMatch(
        /^Este paciente ya tiene un saldo migrado vivo de COP\s1,500,000\.00 \(lote/,
      );
      expect(result.issues[2].message).toMatch(
        /por COP\s3,000\.00 \(el último, COP\s1,000\.00 del lote/,
      );
      // Sin saldos vivos que describir no se pide el formato (G1-B, I4).
      expect(() =>
        aggregateBalances(rows, docs, 'numero_documento', () => {
          throw new Error('no debe pedirse');
        }),
      ).not.toThrow();
    });

    it('con «Añadir aunque ya tenga saldo migrado» lo crea y avisa una vez por saldo', () => {
      const result = aggregateBalances(
        rows,
        docs,
        'numero_documento',
        FMT,
        existing,
        true,
      );
      expect(
        result.prepared.map((p) => [p.docKey, p.currency, p.cents]),
      ).toEqual([
        ['111', 'COP', 150_001_000],
        ['111', 'USD', 4_000],
        ['222', 'COP', 7_000],
        ['333', 'COP', 9_000],
      ]);
      expect(result.errorRows).toBe(0);
      expect(result.issues.map((i) => [i.row, i.kind])).toEqual([
        [2, 'EXISTING_BALANCE'],
        [3, 'MERGED'],
        [5, 'EXISTING_BALANCE'],
      ]);
      expect(result.issues[0].message).toMatch(
        /: se añadirá otro porque marcaste «Añadir aunque ya tenga saldo migrado»\.$/,
      );
    });
  });

  it('documento inexistente o ambiguo: error de la fila; no entra en lo que se importa', () => {
    const result = aggregateBalances(
      [
        c(2, '999', 1_000, 'COP'),
        c(3, '777', 2_000, 'COP'),
        c(4, '111', 3_000, 'COP'),
      ],
      new Map([
        ['111', 'FOUND'],
        ['777', 'AMBIGUOUS'],
      ]),
      'numero_documento',
      FMT,
    );
    expect(result.prepared.map((p) => p.docKey)).toEqual(['111']);
    expect(result.errorRows).toBe(2);
    expect(result.issues.map((i) => [i.row, i.message])).toEqual([
      [
        2,
        'No hay ningún paciente con el documento «999» en la clínica ni en el archivo de pacientes.',
      ],
      [
        3,
        'Hay más de un paciente con el documento «777» en la clínica: corrígelo desde sus fichas antes de importar su saldo.',
      ],
    ]);
    expect(result.validTotals).toEqual([
      { currency: 'COP', rows: 1, cents: 3_000 },
    ]);
  });
});
