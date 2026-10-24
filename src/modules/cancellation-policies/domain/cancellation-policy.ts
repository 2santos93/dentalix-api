import type {
  CancellationByKind,
  CancellationReasonCode,
} from '@prisma/client';

/**
 * Política de cancelación de una sede (DX-279). Mismos límites que los CHECK
 * de `cancellation_policy_versions`; los mensajes son los que ve el ADMIN.
 */
export const NOTICE_HOURS_MIN = 0;
/** 7 días. */
export const NOTICE_HOURS_MAX = 168;
export const PATIENT_TEXT_MAX = 1000;
/** Texto libre opcional del motivo de una cancelación. */
export const CANCEL_REASON_TEXT_MAX = 500;

export const CANCELLATION_POLICY_MESSAGES = {
  noticeHours: `Las horas de aviso deben ser un número entero entre ${NOTICE_HOURS_MIN} y ${NOTICE_HOURS_MAX} (7 días).`,
  fee: 'El importe sugerido no puede ser negativo y admite como mucho 2 decimales.',
  currencyRequired: 'Indica la moneda del importe sugerido.',
  feeRequired: 'Indica el importe sugerido o quita la moneda.',
  currency: 'La moneda no es un código ISO 4217 disponible.',
  patientText: `El texto para el paciente admite como mucho ${PATIENT_TEXT_MAX} caracteres.`,
  receptionCanCharge: 'Indica si recepción puede generar el cargo (sí o no).',
  forbidden:
    'Solo un administrador puede ver y cambiar la política de cancelación.',
  locationNotFound: 'Sede no encontrada',
  invalidLocationId: 'El identificador de la sede no es válido.',
} as const;

/** Una versión guardada (inalterable) de la política de una sede. */
export interface CancellationPolicyVersion {
  id: string;
  locationId: string;
  version: number;
  noticeHours: number;
  /** Importe sugerido del cargo (DX-291); `null` = sin importe. */
  suggestedFee: number | null;
  currency: string | null;
  patientText: string;
  receptionCanCharge: boolean;
  createdAt: Date;
  createdById: string;
  /** Nombre de quien la guardó; `null` si ya no es resoluble. */
  createdByName: string | null;
}

/** Lo que hace falta de la política vigente para calcular el aviso. */
export interface CurrentPolicyRef {
  id: string;
  version: number;
  noticeHours: number;
}

/** Lo que el ADMIN guarda como versión siguiente. */
export interface CancellationPolicyInput {
  noticeHours: number;
  suggestedFee: number | null;
  currency: string | null;
  patientText: string;
  receptionCanCharge?: boolean;
}

/** El primer problema de la política, en español; `null` si es válida. */
export function policyInputError(
  input: Omit<CancellationPolicyInput, 'receptionCanCharge'>,
): string | null {
  if (
    !Number.isInteger(input.noticeHours) ||
    input.noticeHours < NOTICE_HOURS_MIN ||
    input.noticeHours > NOTICE_HOURS_MAX
  ) {
    return CANCELLATION_POLICY_MESSAGES.noticeHours;
  }
  if (
    input.suggestedFee !== null &&
    (!Number.isFinite(input.suggestedFee) || input.suggestedFee < 0)
  ) {
    return CANCELLATION_POLICY_MESSAGES.fee;
  }
  if (input.suggestedFee !== null && input.currency === null) {
    return CANCELLATION_POLICY_MESSAGES.currencyRequired;
  }
  if (input.suggestedFee === null && input.currency !== null) {
    return CANCELLATION_POLICY_MESSAGES.feeRequired;
  }
  if (input.patientText.length > PATIENT_TEXT_MAX) {
    return CANCELLATION_POLICY_MESSAGES.patientText;
  }
  return null;
}

/** Orígenes que el personal elige al cancelar desde la agenda. */
export const STAFF_CANCELLATION_KINDS = [
  'STAFF_FOR_PATIENT',
  'CLINIC',
] as const satisfies readonly CancellationByKind[];
export type StaffCancellationKind = (typeof STAFF_CANCELLATION_KINDS)[number];

/** Catálogo cerrado del motivo (mismo orden que el selector de la web). */
export const CANCELLATION_REASON_CODES = [
  'ILLNESS',
  'FORGOT',
  'COST',
  'TRANSPORT',
  'WORK',
  'CLINIC_RESCHEDULE',
  'OTHER',
] as const satisfies readonly CancellationReasonCode[];

export const CANCELLATION_MESSAGES = {
  byKindRequired:
    'Indica quién cancela: el paciente (lo comunica al personal) o la clínica.',
  reasonRequired: 'Indica el motivo de la cancelación.',
  reasonText: `El detalle del motivo admite como mucho ${CANCEL_REASON_TEXT_MAX} caracteres.`,
  cancelAndMove:
    'No se puede cancelar y mover la cita a la vez: cancélala o muévela.',
} as const;

export interface CancellationNotice {
  /** Minutos enteros entre la cancelación y el inicio (0 si ya empezó). */
  noticeMinutes: number;
  /** Menos aviso que el que pide la política vigente de la sede. */
  lateCancellation: boolean;
}

/**
 * Aviso de una cancelación (DX-279), con instantes UTC: el tiempo real que
 * faltaba, así un cambio de hora no lo altera (24 h de pared pueden ser 23 o
 * 25 reales). Minutos enteros hacia abajo; nunca negativos (cancelar con la
 * cita empezada es aviso 0). Es tardía si el aviso es MENOR que el de la
 * política (exactamente las horas pedidas no lo es). Sin política en la sede,
 * si cancela la clínica o si el paciente ya vino (`attended`: la cita estaba
 * en la clínica o completada), nunca es tardía. Una cita agendada que ya pasó
 * y se cancela después sí cuenta (aviso 0): el paciente no vino ni avisó.
 */
export function computeCancellationNotice(input: {
  start: Date;
  cancelledAt: Date;
  byKind: CancellationByKind;
  /** Horas de la política vigente de la sede; `null` = sin política. */
  noticeHours: number | null;
  /**
   * El paciente ya vino (la cita estaba en la clínica) o la cita estaba
   * completada: cancelarla corrige el registro, nunca es una cancelación
   * tardía del paciente.
   */
  attended?: boolean;
}): CancellationNotice {
  const noticeMinutes = Math.max(
    0,
    Math.floor((input.start.getTime() - input.cancelledAt.getTime()) / 60_000),
  );
  const lateCancellation =
    input.noticeHours !== null &&
    input.byKind !== 'CLINIC' &&
    !input.attended &&
    noticeMinutes < input.noticeHours * 60;
  return { noticeMinutes, lateCancellation };
}
