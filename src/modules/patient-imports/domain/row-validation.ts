import { DocType } from '@prisma/client';
import { toWhatsAppNumber } from '../../appointment-confirmations/application/whatsapp-phone';
import type { ResolvedMapping } from './column-mapping';
import type { ImportFieldKey, ImportPatientData } from './import-fields';
import { excelSerialToDate } from './xlsx-reader';
import type { TableRow } from './tabular-file';

export type IssueKind = 'ERROR' | 'DUPLICATE_FILE' | 'DUPLICATE_EXISTING';

/** Un problema de una fila, tal como sale en la pantalla y en errors.csv. */
export interface RowIssue {
  row: number;
  /** Cabecera del fichero (o el nombre del campo si no venía en el fichero). */
  column: string | null;
  kind: IssueKind;
  message: string;
  /** Lo que traía la celda, recortado; null si no aplica. */
  value: string | null;
}

export interface RowContext {
  /** País de la sede del lote (ISO-2): indicativo de los teléfonos sin «+». */
  countryCode: string | null;
  /** Hoy, día civil AAAA-MM-DD (en la zona de la sede). */
  today: string;
}

export interface ValidatedRow {
  rowNumber: number;
  data: ImportPatientData | null;
  issues: RowIssue[];
}

/** Lo que se copia de la celda en el informe. */
export const MAX_ISSUE_VALUE_LENGTH = 80;

const LIMITS = {
  firstName: 100,
  lastName: 100,
  address: 300,
  occupation: 100,
  emergencyContactName: 150,
  notes: 2000,
} as const;

const DOC_TYPE_ALIASES: ReadonlyArray<[DocType, readonly string[]]> = [
  [
    'CC',
    [
      'cc',
      'cedula',
      'ceduladeciudadania',
      'cedulaciudadania',
      'cedulaciudadana',
    ],
  ],
  ['TI', ['ti', 'tarjetadeidentidad', 'tarjetaidentidad']],
  ['CE', ['ce', 'cedulaextranjeria', 'ceduladeextranjeria', 'extranjeria']],
  ['PASSPORT', ['pa', 'pas', 'pp', 'pasaporte', 'passport']],
  [
    'OTHER',
    [
      'otro',
      'other',
      'rc',
      'registrocivil',
      'nuip',
      'pep',
      'ppt',
      'dni',
      'nit',
      'cv',
      'ms',
      'as',
    ],
  ],
];

const SEX_ALIASES: ReadonlyArray<
  ['M' | 'F' | 'OTHER' | null, readonly string[]]
> = [
  ['M', ['m', 'h', 'masculino', 'hombre', 'male', 'varon']],
  ['F', ['f', 'femenino', 'mujer', 'female']],
  ['OTHER', ['o', 'otro', 'other', 'x', 'nobinario', 'intersexual']],
  [
    null,
    ['nd', 'na', 'sindato', 'noreporta', 'noinforma', 'indeterminado', 'u'],
  ],
];

function aliasKey(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Clave de comparación de un documento: mayúsculas, solo letras y dígitos. */
export function docKey(docNumber: string): string {
  return docNumber.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function parseDocType(raw: string): DocType | null {
  const key = aliasKey(raw);
  for (const [type, aliases] of DOC_TYPE_ALIASES) {
    if (aliases.includes(key)) return type;
  }
  return null;
}

const SCIENTIFIC = /^\d+(?:[.,]\d+)?e\+?\d+$/i;

/** Número de documento normalizado según su tipo, o el motivo del error. */
export function normalizeDocNumber(
  type: DocType,
  raw: string,
): { value: string } | { error: string } {
  if (SCIENTIFIC.test(raw.replace(/\s/g, ''))) {
    return {
      error:
        'El número de documento quedó en notación científica (1,02E+09): en Excel da a la columna formato Texto y vuelve a exportar.',
    };
  }
  const upper = raw.toUpperCase();
  switch (type) {
    case 'CC':
    case 'TI': {
      const digits = upper.replace(/[\s.,-]/g, '');
      return /^\d{3,15}$/.test(digits)
        ? { value: digits }
        : {
            error: `Número de documento no válido para ${type}: solo dígitos (de 3 a 15).`,
          };
    }
    case 'CE': {
      const value = upper.replace(/[\s.,-]/g, '');
      return /^[0-9A-Z]{3,15}$/.test(value)
        ? { value }
        : {
            error:
              'Número de documento no válido para CE: letras y dígitos (de 3 a 15).',
          };
    }
    case 'PASSPORT': {
      const value = upper.replace(/[\s-]/g, '');
      return /^[0-9A-Z]{3,20}$/.test(value)
        ? { value }
        : {
            error:
              'Número de pasaporte no válido: letras y dígitos (de 3 a 20).',
          };
    }
    default: {
      const value = upper.replace(/[\s.]/g, '');
      return /^[0-9A-Z-]{1,30}$/.test(value) && /[0-9A-Z]/.test(value)
        ? { value }
        : {
            error:
              'Número de documento no válido: letras, dígitos y guiones (hasta 30).',
          };
    }
  }
}

function isRealDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Fecha de nacimiento: AAAA-MM-DD (o con /), DD/MM/AAAA (o con - o .; día
 * primero, como en LATAM y España) o un número de serie de Excel. Con hora
 * detrás («1990-05-03 00:00:00»), se ignora la hora. Año de 2 cifras: error
 * (¿1925 o 2025?).
 */
export function parseBirthDate(
  raw: string,
  today: string,
): { value: string } | { error: string } {
  const text = raw.trim().replace(/[T ]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/i, '');
  let y: number;
  let m: number;
  let d: number;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text))) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if (/^\d{4,5}(\.\d+)?$/.test(text)) {
    const iso = excelSerialToDate(Number(text));
    if (!iso) return { error: 'Fecha de nacimiento no reconocida.' };
    [y, m, d] = iso.split('-').map(Number);
  } else if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2}$/.test(text)) {
    return {
      error:
        'El año de la fecha de nacimiento tiene 2 cifras: escríbelo con 4 (DD/MM/AAAA).',
    };
  } else {
    return {
      error: 'Fecha de nacimiento no reconocida: usa DD/MM/AAAA o AAAA-MM-DD.',
    };
  }
  if (!isRealDate(y, m, d)) {
    return { error: 'La fecha de nacimiento no existe en el calendario.' };
  }
  const value = `${y}-${pad(m)}-${pad(d)}`;
  if (value < '1900-01-01') {
    return { error: 'La fecha de nacimiento es anterior a 1900.' };
  }
  if (value > today) return { error: 'La fecha de nacimiento es futura.' };
  return { value };
}

export function parseSex(
  raw: string,
): { value: 'M' | 'F' | 'OTHER' | null } | null {
  const key = aliasKey(raw);
  for (const [sex, aliases] of SEX_ALIASES) {
    if (aliases.includes(key)) return { value: sex };
  }
  return null;
}

/**
 * Teléfono: si es un número plausible con el indicativo de la sede (o con
 * «+»/«00»), en E.164 (`+573101234567`, la regla del botón de WhatsApp,
 * DX-005); un fijo corto que no lo es, tal cual (7 a 15 dígitos).
 */
export function normalizePhone(
  raw: string,
  countryCode: string | null,
): { value: string } | { error: string } {
  const text = raw.trim().replace(/\s+/g, ' ');
  const digits = text.replace(/\D/g, '');
  if (/[a-z]/i.test(text.replace(/\b(ext|extension|ext\.)\b.*$/i, ''))) {
    return {
      error:
        'Teléfono no válido: solo dígitos, espacios, guiones, paréntesis y «+».',
    };
  }
  if (/[/;,|]|\sy\s/i.test(text) && digits.length > 15) {
    return {
      error:
        'Hay más de un teléfono en la celda: deja uno (el otro puede ir en Notas).',
    };
  }
  // Con indicativo y número nacional completo (≥ 10 dígitos en total) va en
  // E.164; un fijo local corto («234 5678») se deja como lo escribieron.
  const e164 = toWhatsAppNumber(text, countryCode);
  if (e164 && e164.length >= 10) return { value: `+${e164}` };
  if (digits.length >= 7 && digits.length <= 15) return { value: text };
  return { error: 'Teléfono no válido: debe tener entre 7 y 15 dígitos.' };
}

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Quita caracteres de control (salvo el salto de línea en las notas). */
function clean(raw: string, multiline = false): string {
  /* eslint-disable no-control-regex -- quitar controles es justo lo que se quiere */
  const stripped = multiline
    ? raw.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    : raw.replace(/[\u0000-\u001f\u007f]/g, ' ');
  /* eslint-enable no-control-regex */
  return multiline ? stripped.trim() : stripped.replace(/\s+/g, ' ').trim();
}

function excerpt(value: string): string {
  return value.length > MAX_ISSUE_VALUE_LENGTH
    ? `${value.slice(0, MAX_ISSUE_VALUE_LENGTH - 1)}…`
    : value;
}

/**
 * Valida y normaliza una fila con el mapeo elegido. Cada problema sale como
 * un error de la fila (fila, columna, motivo en español); con alguno, la fila
 * no se importa (`data` null).
 */
export function validateRow(
  row: TableRow,
  mapping: ResolvedMapping,
  ctx: RowContext,
): ValidatedRow {
  const issues: RowIssue[] = [];
  const cell = (key: ImportFieldKey): string => {
    const index = mapping.indexes[key];
    return index === undefined ? '' : (row.cells[index] ?? '');
  };
  const column = (key: ImportFieldKey, fallback: string): string =>
    mapping.headers[key] ?? fallback;
  const fail = (
    key: ImportFieldKey,
    fallback: string,
    message: string,
    raw: string,
  ) =>
    issues.push({
      row: row.rowNumber,
      column: column(key, fallback),
      kind: 'ERROR',
      message,
      value: raw === '' ? null : excerpt(raw),
    });

  const text = (
    key: keyof typeof LIMITS,
    label: string,
    required: boolean,
  ): string | undefined => {
    const raw = cell(key);
    const value = clean(raw, key === 'notes');
    if (value === '') {
      if (required) fail(key, label, `Falta «${label}».`, raw);
      return undefined;
    }
    if (value.length > LIMITS[key]) {
      fail(
        key,
        label,
        `${label}: demasiado largo (máximo ${LIMITS[key]} caracteres).`,
        raw,
      );
      return undefined;
    }
    return value;
  };

  const firstName = text('firstName', 'Nombres', true);
  const lastName = text('lastName', 'Apellidos', true);

  let docType: DocType | null = mapping.defaultDocType;
  const rawType = clean(cell('docType'));
  if (rawType !== '') {
    docType = parseDocType(rawType);
    if (!docType) {
      fail(
        'docType',
        'Tipo de documento',
        'Tipo de documento no reconocido: usa CC, TI, CE, PASAPORTE u OTRO.',
        rawType,
      );
    }
  } else if (!docType) {
    fail('docType', 'Tipo de documento', 'Falta el tipo de documento.', '');
  }

  let docNumber: string | undefined;
  const rawDoc = clean(cell('docNumber'));
  if (rawDoc === '') {
    fail(
      'docNumber',
      'Número de documento',
      'Falta el número de documento.',
      '',
    );
  } else if (docType) {
    const doc = normalizeDocNumber(docType, rawDoc);
    if ('error' in doc)
      fail('docNumber', 'Número de documento', doc.error, rawDoc);
    else docNumber = doc.value;
  }

  const data: Partial<ImportPatientData> = {};
  const rawBirth = clean(cell('birthDate'));
  if (rawBirth !== '') {
    const birth = parseBirthDate(rawBirth, ctx.today);
    if ('error' in birth)
      fail('birthDate', 'Fecha de nacimiento', birth.error, rawBirth);
    else data.birthDate = birth.value;
  }
  const rawSex = clean(cell('sex'));
  if (rawSex !== '') {
    const sex = parseSex(rawSex);
    if (!sex) {
      fail('sex', 'Sexo', 'Sexo no reconocido: usa M, F u Otro.', rawSex);
    } else if (sex.value) {
      data.sex = sex.value;
    }
  }
  for (const [key, label] of [
    ['phone', 'Teléfono'],
    ['emergencyContactPhone', 'Teléfono de emergencia'],
  ] as const) {
    const raw = clean(cell(key));
    if (raw === '') continue;
    const phone = normalizePhone(raw, ctx.countryCode);
    if ('error' in phone) fail(key, label, phone.error, raw);
    else data[key] = phone.value;
  }
  const rawEmail = clean(cell('email'));
  if (rawEmail !== '') {
    const email = rawEmail.toLowerCase();
    if (email.length > 254 || !EMAIL.test(email)) {
      fail(
        'email',
        'Correo electrónico',
        'Correo electrónico no válido.',
        rawEmail,
      );
    } else {
      data.email = email;
    }
  }
  const address = text('address', 'Dirección', false);
  const occupation = text('occupation', 'Ocupación', false);
  const emergencyContactName = text(
    'emergencyContactName',
    'Contacto de emergencia',
    false,
  );
  const notes = text('notes', 'Notas', false);

  if (issues.length > 0 || !firstName || !lastName || !docType || !docNumber) {
    return { rowNumber: row.rowNumber, data: null, issues };
  }
  return {
    rowNumber: row.rowNumber,
    issues,
    data: {
      docType,
      docNumber,
      firstName,
      lastName,
      ...data,
      ...(address ? { address } : {}),
      ...(occupation ? { occupation } : {}),
      ...(emergencyContactName ? { emergencyContactName } : {}),
      ...(notes ? { notes } : {}),
    },
  };
}
