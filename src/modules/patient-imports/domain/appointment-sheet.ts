import { csv } from './import-csv';
import { HEADER_KEYS, IMPORT_FIELDS } from './import-fields';
import {
  EXTRA_CELLS_MESSAGE,
  MAX_ISSUE_VALUE_LENGTH,
  docKey,
  readCivilDate,
  type RowIssue,
} from './row-validation';
import { ImportFileError, type TableRow } from './tabular-file';
import {
  APPOINTMENT_TYPE_MAX_MINUTES,
  APPOINTMENT_TYPE_MIN_MINUTES,
} from '../../appointment-types/domain/appointment-type-rules';
import { INPUT_REASON_MAX } from '../../../shared/validation/input-limits';
import { addCivilDays } from '../../../shared/time/civil-day';

/*
 * Hoja de citas del importador (DX-263): las citas FUTURAS que la clínica ya
 * tenía dadas en su programa anterior. Cada fila es una cita: documento del
 * paciente, fecha, hora (en la zona de la sede), duración, profesional por su
 * email, sede (opcional: la del lote), tipo de cita (opcional) y motivo
 * (opcional). Aquí solo se lee y se valida la fila sola (formato y topes);
 * las reglas de la agenda (horario, bloqueos, festivos, solapes) se aplican
 * después con las de agendar a mano.
 */

export const APPOINTMENT_TEMPLATE_HEADERS = [
  'numero_documento',
  'fecha',
  'hora',
  'duracion_min',
  'email_profesional',
  'sede',
  'tipo_cita',
  'motivo',
] as const;

export type AppointmentColumnKey =
  | 'docNumber'
  | 'date'
  | 'time'
  | 'duration'
  | 'providerEmail'
  | 'location'
  | 'appointmentType'
  | 'reason';

const DOC_SYNONYMS =
  IMPORT_FIELDS.find((f) => f.key === 'docNumber')?.synonyms ?? [];

const APPOINTMENT_COLUMNS: readonly {
  key: AppointmentColumnKey;
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
    key: 'date',
    label: 'Fecha',
    required: true,
    synonyms: ['fecha', 'fechacita', 'fechadelacita', 'dia', 'diacita'],
  },
  {
    key: 'time',
    label: 'Hora',
    required: true,
    synonyms: [
      'hora',
      'horacita',
      'horadelacita',
      'horainicio',
      'horadeinicio',
      'inicio',
    ],
  },
  {
    key: 'duration',
    label: 'Duración (minutos)',
    required: false,
    synonyms: [
      'duracionmin',
      'duracionminutos',
      'duracion',
      'minutos',
      'duracionenminutos',
    ],
  },
  {
    key: 'providerEmail',
    label: 'Email del profesional',
    required: true,
    synonyms: [
      'emailprofesional',
      'correoprofesional',
      'emaildelprofesional',
      'correodelprofesional',
      'emailodontologo',
      'correoodontologo',
      'emaildoctor',
      'correodoctor',
      'profesional',
      'odontologo',
      'doctor',
    ],
  },
  {
    key: 'location',
    label: 'Sede',
    required: false,
    synonyms: ['sede', 'sucursal', 'consultorio', 'clinica', 'local'],
  },
  {
    key: 'appointmentType',
    label: 'Tipo de cita',
    required: false,
    synonyms: ['tipocita', 'tipodecita', 'tipo', 'servicio', 'tratamiento'],
  },
  {
    key: 'reason',
    label: 'Motivo',
    required: false,
    synonyms: [
      'motivo',
      'motivoconsulta',
      'motivodeconsulta',
      'motivocita',
      'descripcion',
      'observacion',
      'observaciones',
      'nota',
      'notas',
    ],
  },
];

export type AppointmentColumns = Partial<
  Record<AppointmentColumnKey, string>
> & {
  docNumber: string;
  date: string;
  time: string;
  providerEmail: string;
};

/** Citas por hoja: cada una se valida contra la agenda (varias consultas). */
export const MAX_APPOINTMENT_ROWS = 2_000;
/**
 * Tope de rango: hasta cuántos días por delante se importa una cita (la
 * agenda que trae un cambio de programa son semanas o meses, no años).
 */
export const MAX_APPOINTMENT_HORIZON_DAYS = 366;
/** Topes de las celdas de texto. */
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 200;

const TEMPLATE_HINT =
  'Usa la plantilla: numero_documento, fecha, hora, duracion_min, email_profesional, sede (opcional), tipo_cita (opcional) y motivo (opcional).';

export const TOO_MANY_APPOINTMENTS_MESSAGE = `La hoja de citas tiene más de ${MAX_APPOINTMENT_ROWS} filas: divídela en varios lotes.`;

/** Cabeceras de la hoja → columna de cada dato (por sinónimos, sin tildes). */
export function resolveAppointmentColumns(
  headers: readonly string[],
): AppointmentColumns {
  const out: Partial<Record<AppointmentColumnKey, string>> = {};
  const used = new Set<string>();
  for (const col of APPOINTMENT_COLUMNS) {
    search: for (const key of HEADER_KEYS) {
      for (const synonym of col.synonyms) {
        const header = headers.find((h) => !used.has(h) && key(h) === synonym);
        if (header !== undefined) {
          out[col.key] = header;
          used.add(header);
          break search;
        }
      }
    }
    if (col.required && out[col.key] === undefined) {
      throw new ImportFileError(
        `A la hoja de citas le falta la columna «${col.label}». ${TEMPLATE_HINT}`,
      );
    }
  }
  return out as AppointmentColumns;
}

/**
 * Plantilla CSV de la hoja de citas (BOM, CRLF, una fila de ejemplo) con una
 * fecha de la semana próxima en la sede del lote (`today`, AAAA-MM-DD).
 */
export function appointmentTemplateCsv(today: string): string {
  const [y, m, d] = addCivilDays(today, 7).split('-');
  return csv([
    [...APPOINTMENT_TEMPLATE_HEADERS],
    [
      'DOC-1000001',
      `${d}/${m}/${y}`,
      '09:30',
      '30',
      'odontologa@example.com',
      '',
      '',
      'Fila de ejemplo: bórrala antes de importar',
    ],
  ]);
}

/**
 * Hora escrita en una celda → minutos desde las 00:00 (0–1439). Admite
 * «9:30», «09:30:00», «9:30 pm», «9:30 p. m.», «14h30» y la fracción de día
 * con la que un .xlsx guarda una celda con formato de hora («0.395833…»).
 */
export function parseTimeOfDay(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (/^0?\.\d+$/.test(text) || /^0,\d+$/.test(text)) {
    const fraction = Number(text.replace(',', '.'));
    if (!(fraction >= 0 && fraction < 1)) return null;
    const minute = Math.floor(fraction * 24 * 60 + 0.5);
    return minute >= 24 * 60 ? null : minute;
  }
  const match =
    /^(\d{1,2})\s*[:h.]\s*(\d{2})(?:\s*:\s*(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?$/.exec(
      text,
    );
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (minute > 59 || second > 59) return null;
  const meridiem = match[4]?.replace(/[\s.]/g, '');
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    return null;
  }
  return hour * 60 + minute;
}

/** «30», «30 min», «45 minutos» → minutos; otra cosa, null. */
export function parseDurationMinutes(raw: string): number | null {
  const match = /^(\d{1,4})\s*(?:min|mins|minutos|minuto|m)?\.?$/i.exec(
    raw.trim(),
  );
  return match ? Number(match[1]) : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Clave de comparación de un nombre (sede, tipo): sin tildes ni mayúsculas. */
export function nameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface AppointmentRowContext {
  /** Hoy en la zona de la sede del lote (AAAA-MM-DD). */
  today: string;
}

/** Una fila leída y con formato válido, aún sin resolver contra la clínica. */
export interface AppointmentCandidate {
  rowNumber: number;
  docKey: string;
  /** Tal como venía (para los mensajes). */
  docNumber: string;
  /** Día civil AAAA-MM-DD en la zona de la sede de la cita. */
  date: string;
  /** Minutos desde las 00:00 (hora de pared de la sede). */
  minute: number;
  /** null: la del tipo de cita. */
  durationMinutes: number | null;
  /** En minúsculas. */
  providerEmail: string;
  /** null: la sede del lote. */
  locationName: string | null;
  typeName: string | null;
  reason: string | null;
}

export interface ValidatedAppointmentRow {
  candidate: AppointmentCandidate | null;
  issues: RowIssue[];
}

const clip = (value: string) => value.slice(0, MAX_ISSUE_VALUE_LENGTH);

/** Valida el formato de una fila de la hoja de citas (sin la base de datos). */
export function validateAppointmentRow(
  row: TableRow,
  cols: AppointmentColumns,
  ctx: AppointmentRowContext,
  headers: readonly string[],
): ValidatedAppointmentRow {
  const cell = (key: AppointmentColumnKey): string => {
    const header = cols[key];
    const i = header === undefined ? -1 : headers.indexOf(header);
    return i < 0 ? '' : (row.cells[i] ?? '').trim();
  };
  const issues: RowIssue[] = [];
  const issue = (
    key: AppointmentColumnKey | null,
    message: string,
    value: string,
  ) =>
    issues.push({
      row: row.rowNumber,
      column: key === null ? null : (cols[key] ?? null),
      kind: 'ERROR',
      message,
      value: value === '' ? null : clip(value),
    });

  if (row.extraCells) issue(null, EXTRA_CELLS_MESSAGE, '');

  const docRaw = cell('docNumber');
  const key = docKey(docRaw);
  if (docRaw === '' || key === '') {
    issue('docNumber', 'Falta el número de documento del paciente.', docRaw);
  } else if (/^\d+(?:[.,]\d+)?e[+-]?\d+$/i.test(docRaw.replace(/\s/g, ''))) {
    issue(
      'docNumber',
      `El número de documento quedó en notación científica (${docRaw.slice(0, 30)}): en Excel da a la columna formato Texto y vuelve a exportar.`,
      docRaw,
    );
  } else if (key.length > 30) {
    issue(
      'docNumber',
      'El número de documento tiene más de 30 letras o cifras.',
      docRaw,
    );
  }

  const dateRaw = cell('date');
  let date: string | null = null;
  if (dateRaw === '') issue('date', 'Falta la fecha de la cita.', dateRaw);
  else {
    const read = readCivilDate(dateRaw);
    if ('error' in read) {
      issue(
        'date',
        read.error === 'TWO_DIGIT_YEAR'
          ? 'El año de la fecha tiene 2 cifras: escríbelo con 4 (DD/MM/AAAA).'
          : read.error === 'NOT_IN_CALENDAR'
            ? 'La fecha de la cita no existe en el calendario.'
            : 'La fecha de la cita no se reconoce: usa DD/MM/AAAA o AAAA-MM-DD.',
        dateRaw,
      );
    } else if (read.value < ctx.today) {
      issue(
        'date',
        'La cita ya pasó: solo se importan citas futuras.',
        dateRaw,
      );
    } else if (
      read.value > addCivilDays(ctx.today, MAX_APPOINTMENT_HORIZON_DAYS)
    ) {
      issue(
        'date',
        `La cita es a más de ${MAX_APPOINTMENT_HORIZON_DAYS} días: solo se importan las citas del próximo año.`,
        dateRaw,
      );
    } else date = read.value;
  }

  const timeRaw = cell('time');
  let minute: number | null = null;
  if (timeRaw === '') issue('time', 'Falta la hora de la cita.', timeRaw);
  else {
    minute = parseTimeOfDay(timeRaw);
    if (minute === null) {
      issue(
        'time',
        'La hora no se reconoce: usa HH:MM en formato de 24 horas (p. ej. 09:30 o 15:00).',
        timeRaw,
      );
    }
  }

  const durationRaw = cell('duration');
  let durationMinutes: number | null = null;
  if (durationRaw !== '') {
    durationMinutes = parseDurationMinutes(durationRaw);
    if (
      durationMinutes === null ||
      durationMinutes < APPOINTMENT_TYPE_MIN_MINUTES ||
      durationMinutes > APPOINTMENT_TYPE_MAX_MINUTES
    ) {
      issue(
        'duration',
        `La duración debe ser un número entero de minutos entre ${APPOINTMENT_TYPE_MIN_MINUTES} y ${APPOINTMENT_TYPE_MAX_MINUTES}.`,
        durationRaw,
      );
      durationMinutes = null;
    }
  }

  const emailRaw = cell('providerEmail');
  if (emailRaw === '') {
    issue(
      'providerEmail',
      'Falta el email del profesional que atiende la cita.',
      emailRaw,
    );
  } else if (emailRaw.length > MAX_EMAIL_LENGTH || !EMAIL.test(emailRaw)) {
    issue(
      'providerEmail',
      'El email del profesional no es válido (p. ej. nombre@clinica.com).',
      emailRaw,
    );
  }

  const locationRaw = cell('location');
  if (locationRaw.length > MAX_NAME_LENGTH) {
    issue(
      'location',
      `El nombre de la sede tiene más de ${MAX_NAME_LENGTH} caracteres.`,
      locationRaw,
    );
  }
  const typeRaw = cell('appointmentType');
  if (typeRaw.length > MAX_NAME_LENGTH) {
    issue(
      'appointmentType',
      `El tipo de cita tiene más de ${MAX_NAME_LENGTH} caracteres.`,
      typeRaw,
    );
  }
  const reasonRaw = cell('reason');
  if (reasonRaw.length > INPUT_REASON_MAX) {
    issue(
      'reason',
      `El motivo tiene más de ${INPUT_REASON_MAX} caracteres.`,
      reasonRaw,
    );
  }
  if (durationRaw === '' && typeRaw === '') {
    issue(
      'duration',
      'Falta la duración: escribe los minutos o un tipo de cita (que la trae).',
      '',
    );
  }

  if (issues.length > 0) return { candidate: null, issues };
  return {
    candidate: {
      rowNumber: row.rowNumber,
      docKey: key,
      docNumber: docRaw,
      date: date as string,
      minute: minute as number,
      durationMinutes,
      providerEmail: emailRaw.toLowerCase(),
      locationName: locationRaw === '' ? null : locationRaw,
      typeName: typeRaw === '' ? null : typeRaw,
      reason: reasonRaw === '' ? null : reasonRaw,
    },
    issues,
  };
}

/** Una cita ya resuelta y validada contra la agenda, lista para el lote. */
export interface ResolvedAppointment {
  rowNumber: number;
  docKey: string;
  /** null: el paciente lo creará el archivo de pacientes del lote. */
  patientId: string | null;
  providerId: string;
  locationId: string;
  appointmentTypeId: string | null;
  start: Date;
  end: Date;
  reason: string | null;
}

/**
 * Solapes DENTRO de la hoja (la base de datos aún no las tiene): dos citas
 * del mismo profesional, o del mismo paciente (por su documento), que se
 * pisan. Intervalos semiabiertos [inicio, fin), como la EXCLUDE de la BD.
 * Gana la fila anterior del archivo; la otra sale con su motivo. Devuelve
 * las que quedan y los errores, en el orden del archivo.
 */
export function rejectInFileOverlaps(rows: readonly ResolvedAppointment[]): {
  kept: ResolvedAppointment[];
  issues: RowIssue[];
} {
  const kept: ResolvedAppointment[] = [];
  const issues: RowIssue[] = [];
  const byProvider = new Map<string, ResolvedAppointment[]>();
  const byPatient = new Map<string, ResolvedAppointment[]>();
  const overlaps = (a: ResolvedAppointment, b: ResolvedAppointment) =>
    a.start < b.end && b.start < a.end;
  for (const row of [...rows].sort((a, b) => a.rowNumber - b.rowNumber)) {
    const sameProvider = (byProvider.get(row.providerId) ?? []).find((o) =>
      overlaps(o, row),
    );
    const samePatient = sameProvider
      ? undefined
      : (byPatient.get(row.docKey) ?? []).find((o) => overlaps(o, row));
    const clash = sameProvider ?? samePatient;
    if (clash) {
      issues.push({
        row: row.rowNumber,
        column: null,
        kind: 'ERROR',
        message: sameProvider
          ? `Se solapa con la cita de la fila ${clash.rowNumber} del archivo: el profesional ya tiene una cita a esa hora.`
          : `Se solapa con la cita de la fila ${clash.rowNumber} del archivo: el paciente ya tiene una cita a esa hora.`,
        value: null,
      });
      continue;
    }
    kept.push(row);
    byProvider.set(row.providerId, [
      ...(byProvider.get(row.providerId) ?? []),
      row,
    ]);
    byPatient.set(row.docKey, [...(byPatient.get(row.docKey) ?? []), row]);
  }
  return { kept, issues };
}

/** Festivo de la sede (DX-316): fecha exacta o, si es recurrente, mes y día. */
export function isLocationHoliday(
  day: string,
  holidays: readonly { date: string; recurring: boolean }[],
): boolean {
  return holidays.some((h) =>
    h.recurring ? h.date.slice(5) === day.slice(5) : h.date === day,
  );
}

export const HOLIDAY_MESSAGE =
  'Ese día la sede está cerrada por festivo: elige otro día.';
