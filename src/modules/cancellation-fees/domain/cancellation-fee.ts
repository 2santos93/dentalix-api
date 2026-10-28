import type {
  AppointmentStatus,
  CancellationFeeStatus,
  ClinicRole,
} from '@prisma/client';
import { decimalPlaces } from '../../../shared/validation/bounded-decimal';

/**
 * Cargo por inasistencia o cancelación tardía (DX-291, porción 2 de DX-279).
 * Reglas puras: las usan los casos de uso (403/409/400 en español) y los
 * tests. El cargo es un ítem DONE del plan «Cargos administrativos» del
 * paciente en la moneda de la política, y se cobra con el abono y el recibo
 * de siempre (DX-136): no hay otra contabilidad.
 */

/** `optionLabel` del plan donde van los cargos (uno ACCEPTED por moneda). */
export const ADMIN_FEES_PLAN_LABEL = 'Cargos administrativos';
/** Procedimiento del catálogo de la clínica que nombra el ítem del cargo. */
export const FEE_CATALOG_CODE = 'ADM-CANCELACION';
export const FEE_CATALOG_LABEL = 'Cargo por inasistencia o cancelación tardía';
/** Un cargo administrativo no es de ningún diente. */
export const FEE_TOOTH_NUMBER = '';

export const WAIVE_REASON_MIN = 3;
export const WAIVE_REASON_MAX = 500;

export const CANCELLATION_FEE_MESSAGES = {
  forbidden:
    'Solo un administrador (o recepción, si la política de la sede lo permite) puede generar o condonar el cargo.',
  appointmentNotFound: 'Cita no encontrada',
  notEligible:
    'Solo se cobra una inasistencia o una cancelación tardía del paciente.',
  notInformed: 'No consta que el paciente fuera informado de la política.',
  noFee:
    'La política comunicada al paciente no tiene importe de cargo: no hay nada que cobrar.',
  alreadyCharged: 'Esta cita ya tiene su cargo generado.',
  alreadyWaived: 'El cargo de esta cita ya se condonó.',
  amount: 'El importe debe ser mayor que 0 y con 2 decimales como mucho.',
  amountAboveSuggested: (max: string) =>
    `El importe no puede superar el sugerido por la política comunicada (${max}).`,
  waiveReason: `Indica el motivo de la condonación (entre ${WAIVE_REASON_MIN} y ${WAIVE_REASON_MAX} caracteres).`,
  voidReason: `Indica el motivo de la anulación (entre ${WAIVE_REASON_MIN} y ${WAIVE_REASON_MAX} caracteres).`,
  notCharged: 'Esta cita no tiene un cargo generado que anular.',
  alreadyVoided: 'El cargo de esta cita ya se anuló.',
  voidPaid:
    'El cargo ya está cobrado: los abonos de «Cargos administrativos» lo cubren. Anula antes el abono y después el cargo.',
} as const;

/**
 * SEC-050: el ítem de un cargo vigente no se toca desde el plan (ni su precio,
 * descuento o estado, ni «Quitar»), sea cual sea el rol: se anula con su
 * acción, con motivo y auditada.
 */
export const FEE_ITEM_LOCKED_MESSAGE =
  'Este ítem es el cargo por inasistencia o cancelación tardía de una cita: su precio, descuento y estado no se cambian ni se quita del plan. Para anularlo usa «Anular cargo» en la cita (con motivo).';
/** SEC-050: el plan que lo lleva no se cancela ni cambia de moneda. */
export const FEE_PLAN_LOCKED_MESSAGE =
  'Este plan lleva un cargo por inasistencia o cancelación tardía vigente: no se cancela ni cambia de moneda. Anula antes el cargo desde la cita (con motivo).';

/** Por qué no se puede generar el cargo de una cita (o `null` si se puede). */
export type FeeBlockReason =
  | 'NOT_ELIGIBLE'
  | 'NOT_INFORMED'
  | 'NO_FEE'
  | 'ALREADY_CHARGED'
  | 'ALREADY_WAIVED';

/** La cita tal como la mira el cargo. */
export interface FeeAppointment {
  status: AppointmentStatus;
  lateCancellation: boolean | null;
  /** Versión de la política comunicada al paciente (DX-279/291). */
  policyVersionId: string | null;
}

/** Lo que pide la decisión de cobrar, además de la cita. */
export interface FeeChargeFacts {
  appointment: FeeAppointment;
  /** Importe sugerido y moneda de la versión COMUNICADA (`null` = sin importe). */
  communicated: { suggestedFee: number | null; currency: string | null } | null;
  existing: CancellationFeeStatus | null;
}

/** Una inasistencia o una cancelación tardía (la única que se cobra). */
export function isFeeEligible(appointment: FeeAppointment): boolean {
  return (
    appointment.status === 'NO_SHOW' ||
    (appointment.status === 'CANCELLED' &&
      appointment.lateCancellation === true)
  );
}

/**
 * Primer motivo por el que NO se puede generar el cargo, en el orden en que
 * se le explica al personal; `null` si se puede.
 */
export function chargeBlockReason(
  facts: FeeChargeFacts,
): FeeBlockReason | null {
  if (facts.existing === 'CHARGED') return 'ALREADY_CHARGED';
  if (facts.existing === 'WAIVED') return 'ALREADY_WAIVED';
  if (!isFeeEligible(facts.appointment)) return 'NOT_ELIGIBLE';
  if (!facts.appointment.policyVersionId || !facts.communicated)
    return 'NOT_INFORMED';
  if (
    facts.communicated.suggestedFee === null ||
    facts.communicated.suggestedFee <= 0 ||
    facts.communicated.currency === null
  )
    return 'NO_FEE';
  return null;
}

/** Motivo por el que NO se puede condonar (o `null`). */
export function waiveBlockReason(
  appointment: FeeAppointment,
  existing: CancellationFeeStatus | null,
): FeeBlockReason | null {
  if (existing === 'CHARGED') return 'ALREADY_CHARGED';
  if (existing === 'WAIVED') return 'ALREADY_WAIVED';
  if (!isFeeEligible(appointment)) return 'NOT_ELIGIBLE';
  return null;
}

/** Mensaje en español de cada bloqueo (409). */
export function blockMessage(reason: FeeBlockReason): string {
  switch (reason) {
    case 'NOT_ELIGIBLE':
      return CANCELLATION_FEE_MESSAGES.notEligible;
    case 'NOT_INFORMED':
      return CANCELLATION_FEE_MESSAGES.notInformed;
    case 'NO_FEE':
      return CANCELLATION_FEE_MESSAGES.noFee;
    case 'ALREADY_CHARGED':
      return CANCELLATION_FEE_MESSAGES.alreadyCharged;
    case 'ALREADY_WAIVED':
      return CANCELLATION_FEE_MESSAGES.alreadyWaived;
  }
}

/**
 * Importe del cargo: el sugerido si no se indica; editable A LA BAJA, nunca
 * por encima (400). Mayor que 0 y con 2 decimales como mucho. Devuelve el
 * importe o el mensaje del error.
 */
export function resolveChargeAmount(
  requested: number | undefined,
  suggested: number,
  formatMax: (value: number) => string,
): { ok: true; amount: number } | { ok: false; message: string } {
  if (requested === undefined) return { ok: true, amount: suggested };
  if (
    !Number.isFinite(requested) ||
    requested <= 0 ||
    decimalPlaces(requested) > 2
  ) {
    return { ok: false, message: CANCELLATION_FEE_MESSAGES.amount };
  }
  if (requested > suggested) {
    return {
      ok: false,
      message: CANCELLATION_FEE_MESSAGES.amountAboveSuggested(
        formatMax(suggested),
      ),
    };
  }
  return { ok: true, amount: requested };
}

/**
 * Por qué no se puede anular el cargo (SEC-050), o `null`: solo un cargo
 * generado (CHARGED) y una vez.
 */
export function voidBlockMessage(
  fee: { status: CancellationFeeStatus; voidedAt: Date | null } | null,
): string | null {
  if (!fee || fee.status !== 'CHARGED')
    return CANCELLATION_FEE_MESSAGES.notCharged;
  if (fee.voidedAt) return CANCELLATION_FEE_MESSAGES.alreadyVoided;
  return null;
}

/** Motivo de la condonación ya recortado, o `null` si no vale. */
export function normalizeWaiveReason(raw: string | undefined): string | null {
  const reason = (raw ?? '').trim();
  return reason.length >= WAIVE_REASON_MIN && reason.length <= WAIVE_REASON_MAX
    ? reason
    : null;
}

/**
 * ADMIN siempre; RECEPTION solo si la política vigente de la sede lo permite
 * (`receptionCanCharge`). El resto de roles no llega (403 del guard).
 */
export function canManageFee(
  role: ClinicRole,
  receptionCanCharge: boolean,
): boolean {
  return role === 'ADMIN' || (role === 'RECEPTION' && receptionCanCharge);
}
