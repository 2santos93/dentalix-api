import type { PatientImportFileFormat } from '@prisma/client';
import { csv } from './import-csv';
import { IMPORT_FIELDS, headerKey } from './import-fields';
import {
  MAX_ISSUE_VALUE_LENGTH,
  docKey,
  readCivilDate,
  type RowIssue,
} from './row-validation';
import { ImportFileError, type TableRow } from './tabular-file';
import { formatMoney } from '../../../shared/money/format-money';

/*
 * Hoja de saldos del importador (DX-262): un «Saldo migrado» por paciente y
 * moneda, que entra en el estado de cuenta (DX-011) y en la cartera por
 * antigüedad (DX-145). Columnas: documento del paciente, importe, moneda,
 * fecha de antigüedad (opcional) y concepto (opcional). El paciente se busca
 * por la clave del documento (`docKey`) en la clínica y en el archivo de
 * pacientes del mismo lote.
 */

export const BALANCE_TEMPLATE_HEADERS = [
  'numero_documento',
  'importe',
  'moneda',
  'fecha_antiguedad',
  'concepto',
] as const;

export type BalanceColumnKey =
  'docNumber' | 'amount' | 'currency' | 'asOfDate' | 'concept';

const DOC_SYNONYMS =
  IMPORT_FIELDS.find((f) => f.key === 'docNumber')?.synonyms ?? [];

const BALANCE_COLUMNS: readonly {
  key: BalanceColumnKey;
  label: string;
  required: boolean;
  synonyms: readonly string[];
}[] = [
  {
    key: 'docNumber',
    label: 'Número de documento',
    required: true,
    synonyms: ['numerodocumento', ...DOC_SYNONYMS],
  },
  {
    key: 'amount',
    label: 'Importe',
    required: true,
    synonyms: [
      'importe',
      'saldo',
      'monto',
      'valor',
      'deuda',
      'saldopendiente',
      'saldoinicial',
      'saldomigrado',
      'saldoanterior',
      'valoradeudado',
      'cartera',
      'total',
    ],
  },
  {
    key: 'currency',
    label: 'Moneda',
    required: true,
    synonyms: ['moneda', 'divisa', 'currency', 'codigomoneda'],
  },
  {
    key: 'asOfDate',
    label: 'Fecha de antigüedad',
    required: false,
    synonyms: [
      'fechaantiguedad',
      'fechadeantiguedad',
      'fechacorte',
      'fechadecorte',
      'fechadeuda',
      'fechasaldo',
      'fechavencimiento',
      'fechadevencimiento',
      'fecha',
    ],
  },
  {
    key: 'concept',
    label: 'Concepto',
    required: false,
    synonyms: [
      'concepto',
      'descripcion',
      'detalle',
      'observacion',
      'observaciones',
      'nota',
      'notas',
    ],
  },
];

export type BalanceColumns = Partial<Record<BalanceColumnKey, string>> & {
  docNumber: string;
  amount: string;
  currency: string;
};

/** Concepto por defecto y tope (la columna `concept` es ≤ 200). */
export const DEFAULT_BALANCE_CONCEPT = 'Saldo migrado';
export const MAX_CONCEPT_LENGTH = 200;
/** Decimal(14,2): menos de 10^12. */
const MAX_CENTS = 99_999_999_999_999;

const TEMPLATE_HINT =
  'Usa la plantilla: numero_documento, importe, moneda, fecha_antiguedad (opcional) y concepto (opcional).';

/** Cabeceras de la hoja → columna de cada dato (por sinónimos, sin tildes). */
export function resolveBalanceColumns(
  headers: readonly string[],
): BalanceColumns {
  const out: Partial<Record<BalanceColumnKey, string>> = {};
  const used = new Set<string>();
  for (const col of BALANCE_COLUMNS) {
    // El primer sinónimo que aparezca gana (el orden de la lista es la
    // preferencia): «fecha_corte» antes que una «fecha» suelta.
    for (const synonym of col.synonyms) {
      const header = headers.find(
        (h) => !used.has(h) && headerKey(h) === synonym,
      );
      if (header !== undefined) {
        out[col.key] = header;
        used.add(header);
        break;
      }
    }
    if (col.required && out[col.key] === undefined) {
      throw new ImportFileError(
        `A la hoja de saldos le falta la columna «${col.label}». ${TEMPLATE_HINT}`,
      );
    }
  }
  return out as BalanceColumns;
}

/**
 * Plantilla CSV de la hoja de saldos (BOM, CRLF, una fila de ejemplo) con la
 * moneda de la sede del lote.
 */
export function balanceTemplateCsv(currency: string): string {
  return csv([
    [...BALANCE_TEMPLATE_HEADERS],
    [
      '1000000001',
      '150000',
      currency,
      '15/03/2026',
      'Fila de ejemplo: bórrala antes de importar',
    ],
  ]);
}

const SCIENTIFIC = /^\d+(?:[.,]\d+)?e[+-]?\d+$/i;

function digitsToCents(intPart: string, frac: string): number | null {
  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(frac)) return null;
  const cents = Number(intPart) * 100 + Number(frac.padEnd(2, '0') || '0');
  return Number.isSafeInteger(cents) ? cents : null;
}

/** «1.234.567» / «1,234,567»: grupos de 3 tras el primero (1 a 3 cifras). */
const grouped = (text: string, sep: '.' | ',') =>
  new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(text);

/**
 * Importe escrito en la celda → céntimos (entero exacto). Admite símbolo o
 * código de moneda delante, espacios y separadores de miles:
 * - con «.» y «,», el ÚLTIMO es el decimal («1.234,50» y «1,234.50»);
 * - con uno solo: si se repite, o va seguido de exactamente 3 cifras, es de
 *   miles («150.000», «1,500»); con 1 o 2 cifras detrás, decimal («1500,5»);
 * - en un XLSX, «1234.5» (así escribe el lector una celda numérica) es
 *   siempre decimal.
 * Negativo, entre paréntesis (contable) o 0: «debe ser mayor que 0».
 */
export function parseAmountCents(
  raw: string,
  format: PatientImportFileFormat,
): { cents: number } | { error: string } {
  const notNumber = {
    error: `El importe «${raw.trim().slice(0, 30)}» no es un número: escríbelo sin letras, p. ej. 150000 o 150.000,50.`,
  };
  let text = raw
    .trim()
    .replace(/^[A-Za-z]{3}\s*/, '')
    .replace(/[$€£\s]|S\/|R\$/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  if (SCIENTIFIC.test(text)) {
    return {
      error:
        'El importe quedó en notación científica: en Excel da a la columna formato Número sin decimales y vuelve a exportar.',
    };
  }
  if (!/^[\d.,]+$/.test(text) || !/\d/.test(text)) return notNumber;

  let intPart: string;
  let frac = '';
  if (format === 'XLSX' && /^\d+(\.\d+)?$/.test(text)) {
    [intPart, frac = ''] = text.split('.');
    // Una celda calculada con fórmula llega con ruido de coma flotante
    // («178500.00000000003»): si la diferencia con 2 decimales es solo eso,
    // se redondea (revisión M6). La tolerancia es relativa (revisión N2):
    // en COP, `=0,1*3*1000000000` llega como 300000000.00000006. Son 16 ULP
    // del valor (≈ 1e-6 en 3·10⁸), no |x|·1e-12, que en 2·10⁹ ya tragaría un
    // tercer decimal real; ese (≥ 0,001) sigue siendo error.
    if (frac.length > 2) {
      const value = Number(text);
      const cents = Math.round(value * 100);
      if (
        Math.abs(value - cents / 100) <=
          Math.max(1e-9, Math.abs(value) * Number.EPSILON * 16) &&
        Number.isSafeInteger(cents)
      ) {
        intPart = String(Math.trunc(cents / 100));
        frac = String(cents % 100).padStart(2, '0');
      }
    }
  } else {
    const lastDot = text.lastIndexOf('.');
    const lastComma = text.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      const decimalSep = lastDot > lastComma ? '.' : ',';
      const thousandSep = decimalSep === '.' ? ',' : '.';
      const at = text.lastIndexOf(decimalSep);
      intPart = text.slice(0, at);
      frac = text.slice(at + 1);
      if (!grouped(intPart, thousandSep)) return notNumber;
      intPart = intPart.split(thousandSep).join('');
    } else if (lastDot >= 0 || lastComma >= 0) {
      const sep = lastDot >= 0 ? '.' : ',';
      const parts = text.split(sep);
      if (parts.length > 2 || parts[1].length === 3) {
        if (!grouped(text, sep)) return notNumber;
        intPart = parts.join('');
      } else {
        [intPart, frac] = parts;
      }
    } else {
      intPart = text;
    }
  }
  if (intPart === '') return notNumber;
  if (frac.length > 2) return { error: 'El importe tiene más de 2 decimales.' };
  const cents = digitsToCents(intPart, frac);
  if (cents === null) return notNumber;
  if (negative || cents === 0) {
    return { error: 'El importe debe ser mayor que 0.' };
  }
  if (cents > MAX_CENTS) {
    return {
      error:
        'El importe es demasiado grande (máximo 999.999.999.999,99): revisa la celda.',
    };
  }
  return { cents };
}

export interface BalanceRowContext {
  /** Hoy, día civil AAAA-MM-DD en la zona de la sede del lote. */
  today: string;
  /** Monedas admitidas (las del catálogo de la clínica, en mayúsculas). */
  currencies: ReadonlySet<string>;
  format: PatientImportFileFormat;
}

/** Una fila válida de la hoja (antes de buscar al paciente). */
export interface BalanceCandidate {
  rowNumber: number;
  docKey: string;
  /** Tal como venía (para los mensajes). */
  docNumber: string;
  cents: number;
  currency: string;
  /** AAAA-MM-DD, o null: se usará el día de la importación (aproximado). */
  asOfDate: string | null;
  concept: string | null;
}

export interface ValidatedBalanceRow {
  candidate: BalanceCandidate | null;
  /** Importe y moneda legibles aunque la fila tenga otro error (total del archivo). */
  counted: { currency: string; cents: number } | null;
  issues: RowIssue[];
}

const clip = (value: string) => value.slice(0, MAX_ISSUE_VALUE_LENGTH);

export function validateBalanceRow(
  row: TableRow,
  cols: BalanceColumns,
  ctx: BalanceRowContext,
  headers: readonly string[],
): ValidatedBalanceRow {
  const cell = (key: BalanceColumnKey): string => {
    const header = cols[key];
    const i = header === undefined ? -1 : headers.indexOf(header);
    return i < 0 ? '' : (row.cells[i] ?? '').trim();
  };
  const issues: RowIssue[] = [];
  const issue = (key: BalanceColumnKey, message: string, value: string) =>
    issues.push({
      row: row.rowNumber,
      column: cols[key] ?? null,
      kind: 'ERROR',
      message,
      value: value === '' ? null : clip(value),
    });

  const docRaw = cell('docNumber');
  const key = docKey(docRaw);
  if (docRaw === '' || key === '') {
    issue('docNumber', 'Falta el número de documento del paciente.', docRaw);
  } else if (SCIENTIFIC.test(docRaw.replace(/\s/g, ''))) {
    issue(
      'docNumber',
      `El número de documento quedó en notación científica (${docRaw.slice(0, 30)}): en Excel da a la columna formato Texto y vuelve a exportar.`,
      docRaw,
    );
  }

  const amountRaw = cell('amount');
  let cents: number | null = null;
  if (amountRaw === '') issue('amount', 'Falta el importe.', amountRaw);
  else {
    const parsed = parseAmountCents(amountRaw, ctx.format);
    if ('error' in parsed) issue('amount', parsed.error, amountRaw);
    else cents = parsed.cents;
  }

  const currencyRaw = cell('currency');
  const currency = currencyRaw.toUpperCase();
  let currencyOk = false;
  if (currencyRaw === '') {
    issue(
      'currency',
      'Falta la moneda (código de 3 letras, p. ej. COP).',
      currencyRaw,
    );
  } else if (!ctx.currencies.has(currency)) {
    issue(
      'currency',
      `La moneda «${currencyRaw.slice(0, 10)}» no está admitida en la clínica. Admitidas: ${[...ctx.currencies].sort().join(', ')}.`,
      currencyRaw,
    );
  } else currencyOk = true;

  const dateRaw = cell('asOfDate');
  let asOfDate: string | null = null;
  if (dateRaw !== '') {
    const read = readCivilDate(dateRaw);
    if ('error' in read) {
      issue(
        'asOfDate',
        read.error === 'TWO_DIGIT_YEAR'
          ? 'El año de la fecha de antigüedad tiene 2 cifras: escríbelo con 4 (DD/MM/AAAA).'
          : read.error === 'NOT_IN_CALENDAR'
            ? 'La fecha de antigüedad no existe en el calendario.'
            : 'La fecha de antigüedad no se reconoce: usa DD/MM/AAAA o AAAA-MM-DD.',
        dateRaw,
      );
    } else if (read.value > ctx.today) {
      issue('asOfDate', 'La fecha de antigüedad es futura.', dateRaw);
    } else if (read.value < '1900-01-01') {
      issue('asOfDate', 'La fecha de antigüedad es anterior a 1900.', dateRaw);
    } else asOfDate = read.value;
  }

  const conceptRaw = cell('concept');
  if (conceptRaw.length > MAX_CONCEPT_LENGTH) {
    issue(
      'concept',
      `El concepto tiene más de ${MAX_CONCEPT_LENGTH} caracteres.`,
      conceptRaw,
    );
  }

  const counted = cents !== null && currencyOk ? { currency, cents } : null;
  if (issues.length > 0) return { candidate: null, counted, issues };
  return {
    candidate: {
      rowNumber: row.rowNumber,
      docKey: key,
      docNumber: docRaw,
      cents: cents as number,
      currency,
      asOfDate,
      concept: conceptRaw === '' ? null : conceptRaw,
    },
    counted,
    issues,
  };
}

/** Un saldo listo para importar: uno por paciente y moneda. */
export interface PreparedBalance {
  /** Primera fila del archivo que lo forma. */
  rowNumber: number;
  docKey: string;
  currency: string;
  cents: number;
  /** La más antigua de sus filas; null si ninguna traía fecha. */
  asOfDate: string | null;
  concept: string | null;
  /** Filas del archivo sumadas en él. */
  sourceRows: number;
}

export interface CurrencyTotal {
  currency: string;
  rows: number;
  cents: number;
}

/** Cómo está cada documento: un paciente, ninguno o varios con esa clave. */
export type DocLookup = ReadonlyMap<string, 'FOUND' | 'AMBIGUOUS'>;

/**
 * Saldos migrados VIVOS que el paciente ya tiene en una moneda, de OTROS
 * lotes (QA D1). Clave: `docKey\u0000moneda`.
 */
export interface ExistingBalance {
  count: number;
  /** Σ de sus importes originales. */
  cents: number;
  /** El más reciente, para el mensaje. */
  latest: {
    cents: number;
    asOfDate: string;
    fileName: string;
    /** Día civil (zona de la clínica) en que se importó. */
    importedOn: string;
  };
}
export type ExistingBalanceLookup = ReadonlyMap<string, ExistingBalance>;

/** Rótulo de la casilla de la web que deja añadir otro saldo (QA D1). */
export const ADD_TO_EXISTING_LABEL = 'Añadir aunque ya tenga saldo migrado';

const ddmmyyyy = (day: string): string => day.split('-').reverse().join('/');

function existingDescription(e: ExistingBalance, currency: string): string {
  const where = `lote «${e.latest.fileName}» del ${ddmmyyyy(e.latest.importedOn)}, corte ${ddmmyyyy(e.latest.asOfDate)}`;
  return e.count === 1
    ? `Este paciente ya tiene un saldo migrado vivo de ${formatMoney(e.cents / 100, currency)} (${where})`
    : `Este paciente ya tiene ${e.count} saldos migrados vivos en ${currency} por ${formatMoney(e.cents / 100, currency)} (el último, ${formatMoney(e.latest.cents / 100, currency)} del ${where})`;
}

export interface AggregatedBalances {
  prepared: PreparedBalance[];
  issues: RowIssue[];
  /** Filas sumadas a otra (aviso, no error). */
  mergedRows: number;
  /** Filas con documento inexistente o ambiguo. */
  errorRows: number;
  /** Lo que se importará, por moneda (sin mezclar monedas). */
  validTotals: CurrencyTotal[];
}

/** Σ por moneda, ordenado por código. */
export function totalsByCurrency(
  items: readonly { currency: string; cents: number; rows?: number }[],
): CurrencyTotal[] {
  const map = new Map<string, CurrencyTotal>();
  for (const item of items) {
    const t = map.get(item.currency) ?? {
      currency: item.currency,
      rows: 0,
      cents: 0,
    };
    t.rows += item.rows ?? 1;
    t.cents += item.cents;
    map.set(item.currency, t);
  }
  return [...map.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * Busca a cada paciente y junta las filas del mismo paciente y moneda en un
 * solo saldo (suma exacta en céntimos; la fecha más antigua; el primer
 * concepto). Un documento sin paciente, o con varios, es error de la fila.
 *
 * Subir dos veces la misma hoja no duplica la deuda (QA D1): si el paciente
 * ya tiene un saldo migrado vivo en esa moneda de otro lote, cada fila es un
 * error que dice cuál, salvo que la administradora marque «Añadir aunque ya
 * tenga saldo migrado» (`addToExisting`); entonces se crea y se avisa.
 */
export function aggregateBalances(
  candidates: readonly BalanceCandidate[],
  docs: DocLookup,
  docColumn: string,
  existing: ExistingBalanceLookup = new Map(),
  addToExisting = false,
): AggregatedBalances {
  const issues: RowIssue[] = [];
  const byKey = new Map<string, PreparedBalance>();
  let mergedRows = 0;
  let errorRows = 0;
  for (const c of candidates) {
    const status = docs.get(c.docKey);
    if (status !== 'FOUND') {
      errorRows += 1;
      const shown = c.docNumber.slice(0, 30);
      issues.push({
        row: c.rowNumber,
        column: docColumn,
        kind: 'ERROR',
        message:
          status === 'AMBIGUOUS'
            ? `Hay más de un paciente con el documento «${shown}» en la clínica: corrígelo desde sus fichas antes de importar su saldo.`
            : `No hay ningún paciente con el documento «${shown}» en la clínica ni en el archivo de pacientes.`,
        value: clip(c.docNumber),
      });
      continue;
    }
    const k = `${c.docKey}\u0000${c.currency}`;
    const already = existing.get(k);
    if (already && !addToExisting) {
      errorRows += 1;
      issues.push({
        row: c.rowNumber,
        column: docColumn,
        kind: 'ERROR',
        message: `${existingDescription(already, c.currency)}: no se crea otro. Si es otra deuda, marca «${ADD_TO_EXISTING_LABEL}» y vuelve a subir la hoja.`,
        value: clip(c.docNumber),
      });
      continue;
    }
    const prev = byKey.get(k);
    if (!prev && already) {
      issues.push({
        row: c.rowNumber,
        column: docColumn,
        kind: 'EXISTING_BALANCE',
        message: `${existingDescription(already, c.currency)}: se añadirá otro porque marcaste «${ADD_TO_EXISTING_LABEL}».`,
        value: clip(c.docNumber),
      });
    }
    if (!prev) {
      byKey.set(k, {
        rowNumber: c.rowNumber,
        docKey: c.docKey,
        currency: c.currency,
        cents: c.cents,
        asOfDate: c.asOfDate,
        concept: c.concept,
        sourceRows: 1,
      });
      continue;
    }
    if (prev.cents + c.cents > MAX_CENTS) {
      // La suma no cabe en DECIMAL(14,2) (revisión M2): la fila es un error.
      errorRows += 1;
      issues.push({
        row: c.rowNumber,
        column: docColumn,
        kind: 'ERROR',
        message: `Con esta fila, el saldo de este paciente en ${c.currency} pasaría de 999.999.999.999,99: revisa los importes.`,
        value: clip(c.docNumber),
      });
      continue;
    }
    mergedRows += 1;
    prev.cents += c.cents;
    prev.sourceRows += 1;
    if (
      c.asOfDate !== null &&
      (prev.asOfDate === null || c.asOfDate < prev.asOfDate)
    ) {
      prev.asOfDate = c.asOfDate;
    }
    prev.concept ??= c.concept;
    issues.push({
      row: c.rowNumber,
      column: docColumn,
      kind: 'MERGED',
      message: `Mismo paciente y moneda que la fila ${prev.rowNumber}: se suman en un solo saldo migrado.`,
      value: clip(c.docNumber),
    });
  }
  const prepared = [...byKey.values()].sort(
    (a, b) => a.rowNumber - b.rowNumber || a.currency.localeCompare(b.currency),
  );
  return {
    prepared,
    issues,
    mergedRows,
    errorRows,
    validTotals: totalsByCurrency(
      prepared.map((p) => ({
        currency: p.currency,
        cents: p.cents,
        rows: p.sourceRows,
      })),
    ),
  };
}
