import { AppointmentStatus, ClinicRole } from '@prisma/client';
import { addCivilDays, parseCivilDate } from '../../../shared/time/civil-day';

/**
 * DX-306: reglas puras de los certificados del paciente. Sin Nest ni Prisma:
 * devuelven mensajes en español (listos para la pantalla) que el caso de uso
 * traduce a 400/403/409. Un solo formato para todas las clínicas: lo que
 * varía (días máximos de reposo, si imprime el diagnóstico) son ajustes de la
 * clínica, nunca del país.
 */

export type CertificateKind = 'ATTENDANCE' | 'REST';
export const CERTIFICATE_KINDS: readonly CertificateKind[] = [
  'ATTENDANCE',
  'REST',
];

/** De dónde salen las horas del justificante. */
export type CertificateTimesSource = 'ACTUAL' | 'SCHEDULED';

/** Justificante: recepción, los roles clínicos y ADMIN. */
export const ATTENDANCE_ISSUE_ROLES: readonly ClinicRole[] = [
  ClinicRole.RECEPTION,
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.ADMIN,
];

/** Reposo: quien diagnostica (odontólogo) y ADMIN, con registro profesional. */
export const REST_ISSUE_ROLES: readonly ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ADMIN,
];

/** Ven el diagnóstico del reposo: los roles clínicos (y quien lo emitió). */
export const DIAGNOSIS_VIEW_ROLES: readonly ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.ADMIN,
];

/** Ajustes de la clínica: límites de la BD (CHECK) y valores de plataforma. */
export const REST_MAX_DAYS_MIN = 1;
export const REST_MAX_DAYS_LIMIT = 365;
export const DEFAULT_REST_MAX_DAYS = 30;
/** Hasta cuántos días después de la atención puede empezar el reposo. */
export const REST_START_MAX_OFFSET_DAYS = 30;
export const DIAGNOSIS_MAX_LENGTH = 500;
export const VOID_REASON_MIN_LENGTH = 3;
export const VOID_REASON_MAX_LENGTH = 500;

export const CERTIFICATE_LABEL: Record<CertificateKind, string> = {
  ATTENDANCE: 'justificante de asistencia',
  REST: 'certificado de reposo',
};

export const CERTIFICATE_MESSAGES = {
  notFound: 'Certificado no encontrado.',
  appointmentNotFound: 'La cita no existe o no es de este paciente.',
  patientArchived:
    'El paciente está archivado: no se emiten documentos nuevos a su nombre.',
  restRoleForbidden:
    'El certificado de reposo solo lo emiten un odontólogo o un administrador.',
  diagnosisHidden:
    'El certificado de reposo lleva diagnóstico: solo lo ven los roles clínicos y quien lo emitió.',
  voidForbidden:
    'Solo quien emitió el certificado o un administrador pueden anularlo.',
  alreadyVoided: 'El certificado ya está anulado.',
  providerMissing:
    'El profesional de la cita ya no es miembro de la clínica: no se puede emitir el justificante.',
  issuerMissing: 'No eres miembro de esta clínica.',
  restMaxDays: `El máximo de días de reposo debe ser un número entero entre ${REST_MAX_DAYS_MIN} y ${REST_MAX_DAYS_LIMIT}.`,
  printDiagnosis: 'Indica si el certificado de reposo imprime el diagnóstico.',
  voidReason: `Indica el motivo de la anulación (entre ${VOID_REASON_MIN_LENGTH} y ${VOID_REASON_MAX_LENGTH} caracteres).`,
} as const;

const STATUS_TEXT: Record<AppointmentStatus, string> = {
  SCHEDULED: 'agendada',
  CONFIRMED: 'confirmada',
  COMPLETED: 'atendida',
  CANCELLED: 'cancelada',
  NO_SHOW: 'marcada como inasistencia',
  ARRIVED: 'en sala de espera',
  IN_CHAIR: 'en el sillón',
  READY_FOR_CHECKOUT: 'lista para cobrar',
};

/** ¿Puede este rol emitir este tipo? */
export function canIssue(kind: CertificateKind, role: ClinicRole): boolean {
  return (kind === 'REST' ? REST_ISSUE_ROLES : ATTENDANCE_ISSUE_ROLES).includes(
    role,
  );
}

/**
 * Una cita es «atendida» cuando recepción cerró la salida (COMPLETED). Si
 * no, el mensaje del 409 con su estado; si sí, null.
 */
export function notAttendedMessage(status: AppointmentStatus): string | null {
  if (status === AppointmentStatus.COMPLETED) return null;
  return `Solo se emite para una cita atendida: esta cita está ${STATUS_TEXT[status]}.`;
}

export interface AppointmentTimes {
  start: Date;
  end: Date;
  arrivedAt: Date | null;
  completedAt: Date | null;
}

export interface CertificateTimes {
  from: Date;
  until: Date;
  source: CertificateTimesSource;
}

/**
 * Horas del justificante: llegada (`arrivedAt`) y salida (`completedAt`)
 * reales si constan las dos y en orden; si no, el inicio y el fin de la cita,
 * marcadas como programadas.
 */
export function attendanceTimes(
  appointment: AppointmentTimes,
): CertificateTimes {
  const { arrivedAt, completedAt } = appointment;
  if (
    arrivedAt !== null &&
    completedAt !== null &&
    completedAt.getTime() >= arrivedAt.getTime()
  ) {
    return { from: arrivedAt, until: completedAt, source: 'ACTUAL' };
  }
  return {
    from: appointment.start,
    until: appointment.end,
    source: 'SCHEDULED',
  };
}

/** ¿Quien pide ve el diagnóstico de este certificado? */
export function canSeeDiagnosis(
  viewer: { userId: string; role: ClinicRole },
  certificate: { issuedById: string },
): boolean {
  return (
    DIAGNOSIS_VIEW_ROLES.includes(viewer.role) ||
    viewer.userId === certificate.issuedById
  );
}

/** ¿Puede anularlo? Quien lo emitió (con un rol que aún lo emite) o ADMIN. */
export function canVoid(
  actor: { userId: string; role: ClinicRole },
  certificate: { issuedById: string; kind: CertificateKind },
): boolean {
  if (actor.role === ClinicRole.ADMIN) return true;
  return (
    actor.userId === certificate.issuedById &&
    canIssue(certificate.kind, actor.role)
  );
}

export function isValidRestMaxDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= REST_MAX_DAYS_MIN &&
    value <= REST_MAX_DAYS_LIMIT
  );
}

const codePoints = (value: string): number => Array.from(value).length;

/** Motivo de anulación recortado y válido, o null. */
export function normalizeVoidReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  const length = codePoints(reason);
  return length >= VOID_REASON_MIN_LENGTH && length <= VOID_REASON_MAX_LENGTH
    ? reason
    : null;
}

export interface RestInput {
  restDays?: unknown;
  /** 'YYYY-MM-DD'; ausente = el día de la atención. */
  restStartDate?: unknown;
  diagnosis?: unknown;
}

export interface RestRuleContext {
  /** Ajustes de la clínica. */
  maxDays: number;
  printDiagnosis: boolean;
  /** Día civil de la atención en la zona de la sede ('YYYY-MM-DD'). */
  attentionDay: string;
  /** Registro profesional de quien emite (del perfil), o null. */
  professionalLicense: string | null;
}

export interface RestValue {
  restDays: number;
  restStartDate: string;
  restEndDate: string;
  diagnosis: string | null;
}

export type RestCheck =
  { ok: true; value: RestValue } | { ok: false; errors: string[] };

/**
 * Valida un certificado de reposo y dice TODO lo que falta (un 400 que nombra
 * cada problema): registro profesional, días entre 1 y el máximo de la
 * clínica, inicio no anterior a la atención (ni más de 30 días después) y el
 * diagnóstico solo si la clínica lo imprime.
 */
export function checkRest(input: RestInput, ctx: RestRuleContext): RestCheck {
  const errors: string[] = [];
  if (!ctx.professionalLicense?.trim()) {
    errors.push(
      'falta tu número de registro profesional (lo añade un administrador en Personal)',
    );
  }

  const days = input.restDays;
  const validDays =
    typeof days === 'number' &&
    Number.isInteger(days) &&
    days >= 1 &&
    days <= ctx.maxDays;
  if (!validDays) {
    errors.push(
      `los días de reposo deben ser un número entero entre 1 y ${ctx.maxDays}`,
    );
  }

  let start = ctx.attentionDay;
  if (input.restStartDate !== undefined && input.restStartDate !== null) {
    const parsed =
      typeof input.restStartDate === 'string'
        ? parseCivilDate(input.restStartDate.trim())
        : null;
    const latest = addCivilDays(ctx.attentionDay, REST_START_MAX_OFFSET_DAYS);
    if (parsed === null) {
      errors.push('la fecha de inicio del reposo no es válida (AAAA-MM-DD)');
    } else if (parsed < ctx.attentionDay) {
      errors.push('el reposo no puede empezar antes del día de la atención');
    } else if (parsed > latest) {
      errors.push(
        `el reposo debe empezar como mucho ${REST_START_MAX_OFFSET_DAYS} días después de la atención`,
      );
    } else {
      start = parsed;
    }
  }

  let diagnosis: string | null = null;
  if (input.diagnosis !== undefined && input.diagnosis !== null) {
    if (typeof input.diagnosis !== 'string') {
      errors.push('el diagnóstico debe ser un texto');
    } else {
      const text = input.diagnosis.trim();
      if (text !== '') {
        if (!ctx.printDiagnosis) {
          errors.push(
            'la clínica no imprime el diagnóstico en el certificado de reposo: déjalo vacío',
          );
        } else if (codePoints(text) > DIAGNOSIS_MAX_LENGTH) {
          errors.push(
            `el diagnóstico admite como mucho ${DIAGNOSIS_MAX_LENGTH} caracteres`,
          );
        } else {
          diagnosis = text;
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const restDays = days as number;
  return {
    ok: true,
    value: {
      restDays,
      restStartDate: start,
      restEndDate: addCivilDays(start, restDays - 1),
      diagnosis,
    },
  };
}

/** El 400 con todos los problemas, en una frase. */
export function restErrorMessage(errors: readonly string[]): string {
  return `No se puede emitir el certificado de reposo: ${errors.join('; ')}.`;
}

/** Nº impreso: 6 cifras como mínimo (000123). */
export function formatCertificateNumber(number: number): string {
  return String(number).padStart(6, '0');
}
