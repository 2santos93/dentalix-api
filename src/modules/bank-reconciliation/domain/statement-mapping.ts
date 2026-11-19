/**
 * DX-571: el mapeo de columnas del extracto de un banco. Se guarda en la
 * cuenta (`bank_accounts.columnMapping`) al confirmar una importación y se
 * propone en la siguiente si sus cabeceras siguen en el fichero.
 *
 * El importe puede venir en UNA columna con signo (`amount`: entradas > 0,
 * salidas < 0) o en dos (`credit` y, opcional, `debit`). Solo se guardan las
 * ENTRADAS; las salidas se cuentan como ignoradas.
 */

export const DATE_ORDERS = ['DMY', 'MDY', 'YMD'] as const;
export type DateOrder = (typeof DATE_ORDERS)[number];

export const DECIMAL_SEPARATORS = [',', '.'] as const;
export type DecimalSeparator = (typeof DECIMAL_SEPARATORS)[number];

export const STATEMENT_FIELDS = [
  'date',
  'reference',
  'amount',
  'credit',
  'debit',
  'description',
] as const;
export type StatementField = (typeof STATEMENT_FIELDS)[number];

export interface StatementColumnMapping {
  date: string;
  reference: string;
  amount?: string;
  credit?: string;
  debit?: string;
  description?: string;
  dateOrder: DateOrder;
  decimalSeparator: DecimalSeparator;
}

export class StatementMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementMappingError';
  }
}

const MAX_HEADER = 200;

/**
 * Valida un mapeo (del cliente o guardado) contra las cabeceras del fichero.
 * `headers` null = sin fichero (al leer el guardado): solo la forma.
 */
export function validateMapping(
  raw: unknown,
  headers: readonly string[] | null,
): StatementColumnMapping {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new StatementMappingError(
      'El mapeo de columnas no es válido: debe ser un JSON con la cabecera de cada dato.',
    );
  }
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (
      !(STATEMENT_FIELDS as readonly string[]).includes(key) &&
      key !== 'dateOrder' &&
      key !== 'decimalSeparator'
    ) {
      throw new StatementMappingError(
        `El dato «${key}» no existe en el extracto.`,
      );
    }
  }
  const column = (field: StatementField): string | undefined => {
    const v = value[field];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || v.length > MAX_HEADER) {
      throw new StatementMappingError(
        'El mapeo de columnas no es válido: cada dato es el nombre de una cabecera.',
      );
    }
    if (headers && !headers.includes(v)) {
      throw new StatementMappingError(
        `La columna «${v}» no está en el archivo.`,
      );
    }
    return v;
  };
  const date = column('date');
  const reference = column('reference');
  const amount = column('amount');
  const credit = column('credit');
  const debit = column('debit');
  const description = column('description');
  if (!date) throw new StatementMappingError('Elige la columna de la fecha.');
  if (!reference) {
    throw new StatementMappingError('Elige la columna de la referencia.');
  }
  if (amount && (credit || debit)) {
    throw new StatementMappingError(
      'Elige una columna de importe con signo o las columnas de crédito y débito, no las dos cosas.',
    );
  }
  if (!amount && !credit) {
    throw new StatementMappingError(
      'Elige la columna del importe (o la de los créditos).',
    );
  }
  const used = [date, reference, amount, credit, debit, description].filter(
    (c): c is string => c !== undefined,
  );
  if (new Set(used).size !== used.length) {
    throw new StatementMappingError(
      'Cada columna del archivo puede usarse para un solo dato.',
    );
  }
  const dateOrder = value.dateOrder ?? 'DMY';
  if (!(DATE_ORDERS as readonly unknown[]).includes(dateOrder)) {
    throw new StatementMappingError('El orden de la fecha no es válido.');
  }
  const decimalSeparator = value.decimalSeparator ?? ',';
  if (!(DECIMAL_SEPARATORS as readonly unknown[]).includes(decimalSeparator)) {
    throw new StatementMappingError('El separador decimal no es válido.');
  }
  return {
    date,
    reference,
    ...(amount ? { amount } : {}),
    ...(credit ? { credit } : {}),
    ...(debit ? { debit } : {}),
    ...(description ? { description } : {}),
    dateOrder: dateOrder as DateOrder,
    decimalSeparator: decimalSeparator as DecimalSeparator,
  };
}

/** El mapeo guardado de la cuenta, o null si no hay o ya no tiene forma. */
export function readStoredMapping(raw: unknown): StatementColumnMapping | null {
  if (raw === null || raw === undefined) return null;
  try {
    return validateMapping(raw, null);
  } catch {
    return null;
  }
}

const SYNONYMS: Record<Exclude<StatementField, 'amount'> | 'amount', RegExp> = {
  date: /^(fecha|date|f\.?\s*valor|fecha\s+(valor|operaci[oó]n|transacci[oó]n|movimiento))/,
  reference:
    /(referencia|^ref\b|^ref\.|n[uú]mero\s+de\s+referencia|reference|comprobante|n[uú]mero\s+de\s+operaci[oó]n|^operaci[oó]n$|documento)/,
  amount: /^(monto|importe|amount|valor)$/,
  credit: /(cr[eé]dito|abono|haber|ingreso|entrada|credit|deposit)/,
  debit: /(d[eé]bito|cargo|debe|egreso|salida|debit|withdrawal)/,
  description:
    /(descripci[oó]n|concepto|detalle|description|glosa|observaci[oó]n)/,
};

function fold(header: string): string {
  return header.trim().toLowerCase();
}

/**
 * El mapeo para un fichero: el guardado de la cuenta si TODAS sus columnas
 * siguen en el fichero; si no, uno sugerido por el nombre de las cabeceras
 * (lo que no se reconoce queda sin elegir).
 */
export function suggestMapping(
  headers: readonly string[],
  stored: StatementColumnMapping | null,
): Partial<StatementColumnMapping> & {
  dateOrder: DateOrder;
  decimalSeparator: DecimalSeparator;
} {
  if (stored) {
    try {
      return validateMapping(stored, headers);
    } catch {
      // Otras cabeceras: se sugiere de nuevo, con el formato guardado.
    }
  }
  const out: Partial<Record<StatementField, string>> = {};
  const taken = new Set<string>();
  const order: StatementField[] = [
    'date',
    'reference',
    'credit',
    'debit',
    'amount',
    'description',
  ];
  for (const field of order) {
    const match = headers.find(
      (h) => !taken.has(h) && SYNONYMS[field].test(fold(h)),
    );
    if (match) {
      out[field] = match;
      taken.add(match);
    }
  }
  if (out.amount && (out.credit || out.debit)) delete out.amount;
  if (out.debit && !out.credit && !out.amount) delete out.debit;
  return {
    ...out,
    dateOrder: stored?.dateOrder ?? 'DMY',
    decimalSeparator: stored?.decimalSeparator ?? ',',
  };
}
