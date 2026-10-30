import type { DocumentType } from '@prisma/client';
import {
  DOCUMENT_TYPES,
  GENERIC_DOC_TYPE_NAMES,
  documentTypeKey,
  type ClinicDocumentTypeNames,
} from '../../patients/domain/document-type';
import {
  LEGACY_DOC_TYPES,
  LEGACY_DOC_TYPE_SYNONYMS,
} from '../../patients/domain/legacy-doc-type';
import { toE164Digits } from '../../../shared/phone/e164';
import type { ResolvedMapping } from './column-mapping';
import type { ImportFieldKey, ImportPatientData } from './import-fields';
import { excelSerialToDate } from './xlsx-reader';
import type { TableRow } from './tabular-file';

/**
 * `MERGED` (DX-262): fila de la hoja de saldos que se suma a otra del mismo
 * paciente y moneda (un saldo migrado por paciente y moneda). No es un error.
 */
export type IssueKind =
  | 'ERROR'
  | 'DUPLICATE_FILE'
  | 'DUPLICATE_EXISTING'
  | 'MERGED'
  | 'EXISTING_BALANCE';

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
  /** Indicativo de los teléfonos sin «+» (la aplicación lo saca de la sede). */
  defaultCallingCode: string | null;
  /** Hoy, día civil AAAA-MM-DD (en la zona de la sede). */
  today: string;
  /** Nombres locales de los tipos de documento de la clínica (R16, R19). */
  clinicNames: ClinicDocumentTypeNames;
}

export interface ValidatedRow {
  rowNumber: number;
  data: ImportPatientData | null;
  issues: RowIssue[];
}

export const EXTRA_CELLS_MESSAGE =
  'La fila tiene más celdas que la cabecera: revisa el separador o las comillas de algún dato (p. ej. una dirección con «;»).';

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

/** Clave de comparación del documento (la misma que usa el alta manual). */
export { docKey } from '../../patients/domain/doc-key';

/**
 * Tipo de la celda (DX-327, R19), por `documentTypeKey` (sin mayúsculas, ni
 * tildes latinas, ni puntuación; en cualquier escritura) y en este orden:
 * los nombres locales de la clínica, los códigos y nombres genéricos y, por
 * último, los sinónimos anteriores, que dan su genérico sin etiqueta (Q3).
 */
export function parseDocType(
  raw: string,
  clinicNames: ClinicDocumentTypeNames,
): DocumentType | null {
  const key = documentTypeKey(raw);
  if (key === '') return null;
  for (const type of DOCUMENT_TYPES) {
    const local = Object.hasOwn(clinicNames, type) ? clinicNames[type] : null;
    if (local && documentTypeKey(local) === key) return type;
  }
  for (const type of DOCUMENT_TYPES) {
    if (GENERIC_DOC_TYPE_NAMES[type].includes(key)) return type;
  }
  for (const [code, synonyms] of LEGACY_DOC_TYPE_SYNONYMS) {
    if (synonyms.includes(key)) return LEGACY_DOC_TYPES[code];
  }
  return null;
}

/** «… no reconocido» con los genéricos y, si los tiene, los nombres de la clínica. */
function unknownDocTypeMessage(clinicNames: ClinicDocumentTypeNames): string {
  const base =
    'Tipo de documento no reconocido: usa NATIONAL_ID, PASSPORT, RESIDENCE_PERMIT, TAX_ID u OTHER, o su nombre (documento nacional, pasaporte, permiso de residencia, identificación fiscal, otro)';
  const locals = DOCUMENT_TYPES.map((type) =>
    Object.hasOwn(clinicNames, type) ? clinicNames[type] : null,
  ).filter((name): name is string => !!name);
  return locals.length === 0
    ? `${base}.`
    : `${base}, o uno de los nombres de tu clínica: ${locals.join(', ')}.`;
}

const SCIENTIFIC = /^\d+(?:[.,]\d+)?e\+?\d+$/i;

const DOC_NUMBER_ERROR =
  'Número de documento no válido: letras y dígitos (hasta 30), con separadores opcionales.';

/**
 * Número de documento normalizado, o el motivo del error. Una sola regla para
 * cualquier tipo y país (DX-327, R15): sin espacios, puntos, comas, guiones
 * ni barras, en mayúsculas, de 1 a 30 letras y dígitos. «V-12.345.678» →
 * «V12345678». Es la unión de las reglas por tipo anteriores: nada que
 * aceptaran se rechaza.
 */
export function normalizeDocNumber(
  raw: string,
): { value: string } | { error: string } {
  const compact = raw.replace(/\s/g, '');
  if (SCIENTIFIC.test(compact)) {
    // El valor es el de la fila (QA 2026-10-23, D2), nunca un ejemplo fijo.
    return {
      error: `El número de documento quedó en notación científica (${compact.slice(0, 30)}): en Excel da a la columna formato Texto y vuelve a exportar.`,
    };
  }
  const value = raw.toUpperCase().replace(/[\s.,/-]/g, '');
  return /^[0-9A-Z]{1,30}$/.test(value)
    ? { value }
    : { error: DOC_NUMBER_ERROR };
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
 * Día civil escrito en una celda: AAAA-MM-DD (o con /), DD/MM/AAAA (o con - o
 * .; día primero, como en LATAM y España) o un número de serie de Excel. Con
 * hora detrás («1990-05-03 00:00:00»), se ignora la hora. Año de 2 cifras:
 * error (¿1925 o 2025?). La usan la fecha de nacimiento (DX-107) y la de
 * antigüedad del saldo migrado (DX-262), cada una con sus mensajes.
 */
export function readCivilDate(
  raw: string,
):
  | { value: string }
  | { error: 'UNRECOGNIZED' | 'TWO_DIGIT_YEAR' | 'NOT_IN_CALENDAR' } {
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
    if (!iso) return { error: 'UNRECOGNIZED' };
    [y, m, d] = iso.split('-').map(Number);
  } else if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2}$/.test(text)) {
    return { error: 'TWO_DIGIT_YEAR' };
  } else {
    return { error: 'UNRECOGNIZED' };
  }
  if (!isRealDate(y, m, d)) return { error: 'NOT_IN_CALENDAR' };
  return { value: `${y}-${pad(m)}-${pad(d)}` };
}

/** Fecha de nacimiento (ver `readCivilDate`): ni anterior a 1900 ni futura. */
export function parseBirthDate(
  raw: string,
  today: string,
): { value: string } | { error: string } {
  const read = readCivilDate(raw);
  if ('error' in read) {
    switch (read.error) {
      case 'TWO_DIGIT_YEAR':
        return {
          error:
            'El año de la fecha de nacimiento tiene 2 cifras: escríbelo con 4 (DD/MM/AAAA).',
        };
      case 'NOT_IN_CALENDAR':
        return { error: 'La fecha de nacimiento no existe en el calendario.' };
      default:
        return /^\s*\d{4,5}(\.\d+)?\s*$/.test(raw)
          ? { error: 'Fecha de nacimiento no reconocida.' }
          : {
              error:
                'Fecha de nacimiento no reconocida: usa DD/MM/AAAA o AAAA-MM-DD.',
            };
    }
  }
  const { value } = read;
  if (value < '1900-01-01') {
    return { error: 'La fecha de nacimiento es anterior a 1900.' };
  }
  if (value > today) return { error: 'La fecha de nacimiento es futura.' };
  return { value };
}

export function parseSex(
  raw: string,
): { value: 'M' | 'F' | 'OTHER' | null } | null {
  const key = documentTypeKey(raw);
  for (const [sex, aliases] of SEX_ALIASES) {
    if (aliases.includes(key)) return { value: sex };
  }
  return null;
}

/**
 * Teléfono: si es un número plausible con el indicativo por defecto (o con
 * «+»/«00»), en E.164 (`+` con indicativo y número, la regla del botón de WhatsApp,
 * DX-005); un fijo corto que no lo es, tal cual (7 a 15 dígitos).
 */
export function normalizePhone(
  raw: string,
  defaultCallingCode: string | null,
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
  const e164 = toE164Digits(text, defaultCallingCode);
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

  if (row.extraCells) {
    issues.push({
      row: row.rowNumber,
      column: null,
      kind: 'ERROR',
      message: EXTRA_CELLS_MESSAGE,
      value: null,
    });
  }
  const firstName = text('firstName', 'Nombres', true);
  const lastName = text('lastName', 'Apellidos', true);

  let docType: DocumentType | null = mapping.defaultDocType;
  const rawType = clean(cell('docType'));
  if (rawType !== '') {
    docType = parseDocType(rawType, ctx.clinicNames);
    if (!docType) {
      fail(
        'docType',
        'Tipo de documento',
        unknownDocTypeMessage(ctx.clinicNames),
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
    const doc = normalizeDocNumber(rawDoc);
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
    const phone = normalizePhone(raw, ctx.defaultCallingCode);
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
