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
      resolveBalanceColumns(['Cédula', 'Saldo', 'Divisa', 'Fecha de corte']),
    ).toEqual({
      docNumber: 'Cédula',
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
    const csv = balanceTemplateCsv();
    expect(csv.startsWith('﻿"numero_documento","importe","moneda"')).toBe(true);
    expect(csv).toContain('Fila de ejemplo: bórrala antes de importar');
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
