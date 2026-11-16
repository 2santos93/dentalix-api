import { ClinicRole } from '@prisma/client';
import { isValidFdiToothNumber } from '../../odontogram/application/use-cases/add-tooth-record.use-case';
import {
  civilDateIn,
  civilDaysInclusive,
} from '../../../shared/time/civil-day';

/**
 * DX-572: reglas puras de las órdenes de estudios y referencias a
 * especialistas externos. Sin Nest ni Prisma: devuelven mensajes en español
 * (listos para la pantalla) que el caso de uso traduce a 400/403/409. Un
 * solo formato para todas las clínicas: lo que varía (los días para «vencida»)
 * es un ajuste de la clínica, nunca del país.
 */

export type ExternalOrderKind = 'IMAGING' | 'LAB' | 'SPECIALIST' | 'OTHER';
export const EXTERNAL_ORDER_KINDS: readonly ExternalOrderKind[] = [
  'IMAGING',
  'LAB',
  'SPECIALIST',
  'OTHER',
];

export type ExternalOrderStatus = 'ISSUED' | 'RESULT_RECEIVED' | 'VOIDED';
export const EXTERNAL_ORDER_STATUSES: readonly ExternalOrderStatus[] = [
  'ISSUED',
  'RESULT_RECEIVED',
  'VOIDED',
];

/** Emiten: quien indica estudios o refiere (odontólogo) y ADMIN. */
export const EXTERNAL_ORDER_ISSUE_ROLES: readonly ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ADMIN,
];

/** Ven la nota clínica (y piden el PDF con ella): los roles clínicos. */
export const EXTERNAL_ORDER_NOTE_ROLES: readonly ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.ADMIN,
];

/** Límites de contenido (los mismos CHECK de la BD). */
export const RECIPIENT_MAX_LENGTH = 120;
export const ITEMS_MAX = 20;
export const ITEM_MAX_LENGTH = 200;
export const TEETH_MAX = 32;
export const CLINICAL_NOTE_MAX_LENGTH = 1000;
export const VOID_REASON_MIN_LENGTH = 5;
export const VOID_REASON_MAX_LENGTH = 500;

/** Ajuste de la clínica: días para «vencida» (CHECK 1..365). */
export const OVERDUE_DAYS_MIN = 1;
export const OVERDUE_DAYS_MAX = 365;
export const DEFAULT_OVERDUE_DAYS = 15;

/** Sugerencias de destinatario: las distintas de los últimos 12 meses. */
export const RECIPIENT_SUGGESTIONS_LIMIT = 10;
export const RECIPIENT_LOOKBACK_MONTHS = 12;
export const RECIPIENT_QUERY_MAX_LENGTH = 120;

/** Página de «Órdenes sin resultado». */
export const PENDING_PAGE_SIZE_DEFAULT = 50;
export const PENDING_PAGE_SIZE_MAX = 100;

export const EXTERNAL_ORDER_KIND_LABEL: Record<ExternalOrderKind, string> = {
  IMAGING: 'Imagen',
  LAB: 'Laboratorio clínico',
  SPECIALIST: 'Especialista',
  OTHER: 'Otro',
};

export const EXTERNAL_ORDER_MESSAGES = {
  notFound: 'Orden no encontrada.',
  appointmentNotFound: 'La cita no existe o no es de este paciente.',
  appointmentLocation:
    'La cita es de otra sede: la orden se emite en la sede de la cita.',
  patientArchived:
    'El paciente está archivado: no se emiten documentos nuevos a su nombre.',
  issueForbidden:
    'Solo un odontólogo o un administrador emiten órdenes de estudios y referencias.',
  noteForbidden:
    'La nota clínica de la orden solo la ven los roles clínicos: pide el PDF sin la nota.',
  voidForbidden:
    'Solo quien emitió la orden o un administrador pueden anularla.',
  unlinkForbidden:
    'Solo los roles clínicos o quien ligó el resultado pueden desligarlo.',
  alreadyVoided: 'La orden ya está anulada.',
  voidNotIssued:
    'La orden ya tiene su resultado ligado: desliga el resultado antes de anularla.',
  linkNotIssued:
    'Solo se liga el resultado de una orden emitida sin resultado.',
  linkVoided: 'La orden está anulada: no se le liga un resultado.',
  unlinkNotReceived: 'La orden no tiene un resultado ligado.',
  resultDocumentNotFound: 'El documento no existe o no es de este paciente.',
  resultDocumentVoided: 'El documento está anulado: elige otro.',
  issuerMissing: 'No eres miembro de esta clínica.',
  templateNotFound: 'La plantilla no existe en esta clínica.',
  templateInactive:
    'La plantilla está desactivada: actívala en Ajustes › Órdenes externas o elige otra.',
  overdueDays: `Los días para considerar vencida una orden deben ser un número entero entre ${OVERDUE_DAYS_MIN} y ${OVERDUE_DAYS_MAX}.`,
  voidReason: `Indica el motivo de la anulación (entre ${VOID_REASON_MIN_LENGTH} y ${VOID_REASON_MAX_LENGTH} caracteres).`,
  settingsForbidden:
    'Solo un administrador puede cambiar los ajustes de las órdenes externas.',
  templatesForbidden:
    'Solo un administrador puede crear o cambiar las plantillas de órdenes externas.',
} as const;

const codePoints = (value: string): number => Array.from(value).length;

export function canIssueExternalOrder(role: ClinicRole): boolean {
  return EXTERNAL_ORDER_ISSUE_ROLES.includes(role);
}

/** ¿Ve la nota clínica? Los roles clínicos (recepción, nunca). */
export function canSeeClinicalNote(role: ClinicRole): boolean {
  return EXTERNAL_ORDER_NOTE_ROLES.includes(role);
}

/** ¿Puede anularla? ADMIN, o quien la emitió con un rol que aún emite. */
export function canVoidExternalOrder(
  actor: { userId: string; role: ClinicRole },
  order: { issuedById: string },
): boolean {
  if (actor.role === ClinicRole.ADMIN) return true;
  return actor.userId === order.issuedById && canIssueExternalOrder(actor.role);
}

/** ¿Puede desligar el resultado? Un rol clínico o quien lo ligó. */
export function canUnlinkResult(
  actor: { userId: string; role: ClinicRole },
  order: { resultLinkedById: string | null },
): boolean {
  return (
    canSeeClinicalNote(actor.role) || actor.userId === order.resultLinkedById
  );
}

export interface ExternalOrderContentInput {
  kind?: unknown;
  recipient?: unknown;
  items?: unknown;
  toothNumbers?: unknown;
  clinicalNote?: unknown;
}

export interface ExternalOrderContent {
  kind: ExternalOrderKind;
  recipient: string;
  items: string[];
  toothNumbers: string[];
  clinicalNote: string | null;
}

export type ContentCheck =
  { ok: true; value: ExternalOrderContent } | { ok: false; errors: string[] };

/** Recorta y valida una lista de líneas (estudios); null si no es válida. */
export function normalizeLines(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] | null {
  if (!Array.isArray(value)) return null;
  const lines: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return null;
    const line = raw.trim();
    if (line === '') continue;
    if (codePoints(line) > maxLength) return null;
    lines.push(line);
  }
  return lines.length >= 1 && lines.length <= maxItems ? lines : null;
}

/** Texto recortado de 1..max, o null si no es válido. */
export function normalizeText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const length = codePoints(text);
  return length >= 1 && length <= max ? text : null;
}

/**
 * Valida el contenido de una orden y dice TODO lo que falta o sobra (un 400
 * que nombra cada problema): tipo, destinatario (1–120), de 1 a 20 estudios
 * de hasta 200 caracteres, hasta 32 dientes FDI sin repetir y la nota
 * opcional (hasta 1000).
 */
export function checkExternalOrderContent(
  input: ExternalOrderContentInput,
): ContentCheck {
  const errors: string[] = [];
  const kind = EXTERNAL_ORDER_KINDS.includes(input.kind as ExternalOrderKind)
    ? (input.kind as ExternalOrderKind)
    : null;
  if (kind === null) {
    errors.push('el tipo es IMAGING, LAB, SPECIALIST u OTHER');
  }
  const recipient = normalizeText(input.recipient, RECIPIENT_MAX_LENGTH);
  if (recipient === null) {
    errors.push(
      `indica el centro o el especialista (hasta ${RECIPIENT_MAX_LENGTH} caracteres)`,
    );
  }
  const items = normalizeLines(input.items, ITEMS_MAX, ITEM_MAX_LENGTH);
  if (items === null) {
    errors.push(
      `indica de 1 a ${ITEMS_MAX} estudios o motivos, de hasta ${ITEM_MAX_LENGTH} caracteres cada uno`,
    );
  }
  let toothNumbers: string[] = [];
  if (input.toothNumbers !== undefined && input.toothNumbers !== null) {
    const teeth = Array.isArray(input.toothNumbers) ? input.toothNumbers : null;
    if (
      teeth === null ||
      !teeth.every((t) => isValidFdiToothNumber(t)) ||
      new Set(teeth).size !== teeth.length ||
      teeth.length > TEETH_MAX
    ) {
      errors.push(
        `los dientes van con la numeración FDI (11 a 48 y 51 a 85), sin repetir y como mucho ${TEETH_MAX}`,
      );
    } else {
      toothNumbers = teeth;
    }
  }
  let clinicalNote: string | null = null;
  if (input.clinicalNote !== undefined && input.clinicalNote !== null) {
    if (typeof input.clinicalNote !== 'string') {
      errors.push('la nota clínica debe ser un texto');
    } else if (input.clinicalNote.trim() !== '') {
      clinicalNote = normalizeText(
        input.clinicalNote,
        CLINICAL_NOTE_MAX_LENGTH,
      );
      if (clinicalNote === null) {
        errors.push(
          `la nota clínica admite como mucho ${CLINICAL_NOTE_MAX_LENGTH} caracteres`,
        );
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      kind: kind as ExternalOrderKind,
      recipient: recipient as string,
      items: items as string[],
      toothNumbers,
      clinicalNote,
    },
  };
}

/** El 400 con todos los problemas, en una frase. */
export function contentErrorMessage(errors: readonly string[]): string {
  return `No se puede emitir la orden: ${errors.join('; ')}.`;
}

/** Motivo de anulación recortado y válido (5–500), o null. */
export function normalizeVoidReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  const length = codePoints(reason);
  return length >= VOID_REASON_MIN_LENGTH && length <= VOID_REASON_MAX_LENGTH
    ? reason
    : null;
}

export function isValidOverdueDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= OVERDUE_DAYS_MIN &&
    value <= OVERDUE_DAYS_MAX
  );
}

/**
 * Días civiles de la SEDE desde la emisión: 0 el mismo día, 1 al día
 * siguiente (aunque hayan pasado minutos), nunca negativo.
 */
export function externalOrderAgeDays(
  issuedAt: Date,
  now: Date,
  timeZone: string,
): number {
  const days =
    civilDaysInclusive(
      civilDateIn(issuedAt, timeZone),
      civilDateIn(now, timeZone),
    ) - 1;
  return Math.max(0, days);
}

/** Vencida: más de N días civiles sin resultado. */
export function isOverdue(ageDays: number, overdueDays: number): boolean {
  return ageDays > overdueDays;
}

/** Nº impreso: 6 cifras como mínimo (000123). */
export function formatExternalOrderNumber(number: number): string {
  return String(number).padStart(6, '0');
}
