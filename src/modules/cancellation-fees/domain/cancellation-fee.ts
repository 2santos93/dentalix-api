import type {
  AppointmentStatus,
  CancellationFeeStatus,
  ClinicCountry,
  ClinicRole,
  PayerType,
} from '@prisma/client';
import { coverageStatus } from '../../patient-coverages/domain/coverage-rules';

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
  epsCo:
    'No se puede cobrar: el paciente tiene una cobertura activa de EPS y la sede es de Colombia (Ley 1438 de 2011, art. 55).',
  alreadyCharged: 'Esta cita ya tiene su cargo generado.',
  alreadyWaived: 'El cargo de esta cita ya se condonó.',
  amount: 'El importe debe ser mayor que 0 y con 2 decimales como mucho.',
  amountAboveSuggested: (max: string) =>
    `El importe no puede superar el sugerido por la política comunicada (${max}).`,
  waiveReason: `Indica el motivo de la condonación (entre ${WAIVE_REASON_MIN} y ${WAIVE_REASON_MAX} caracteres).`,
} as const;

/** Por qué no se puede generar el cargo de una cita (o `null` si se puede). */
export type FeeBlockReason =
  | 'NOT_ELIGIBLE'
  | 'NOT_INFORMED'
  | 'NO_FEE'
  | 'EPS_CO'
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
  locationCountry: ClinicCountry;
  /** El paciente tiene hoy (día civil de la sede) una cobertura EPS_CO vigente. */
  hasActiveEpsCo: boolean;
  /** Bloqueo por EPS_CO activado por la plataforma (variable de entorno). */
  epsCoBlockEnabled: boolean;
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
    facts.epsCoBlockEnabled &&
    facts.locationCountry === 'CO' &&
    facts.hasActiveEpsCo
  )
    return 'EPS_CO';
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
    case 'EPS_CO':
      return CANCELLATION_FEE_MESSAGES.epsCo;
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
    Math.round(requested * 100) !== requested * 100
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

/** Una cobertura del paciente tal como la mira el bloqueo por EPS. */
export interface FeeCoverage {
  payerType: PayerType;
  validFrom: string | null;
  validTo: string | null;
}

/** ¿Alguna cobertura EPS_CO vigente el día civil `today` (YYYY-MM-DD)? */
export function hasActiveEpsCoverage(
  coverages: readonly FeeCoverage[],
  today: string,
): boolean {
  return coverages.some(
    (c) => c.payerType === 'EPS_CO' && coverageStatus(c, today) === 'ACTIVE',
  );
}

/**
 * Bloqueo por EPS_CO: lo decide la plataforma, no la clínica
 * (`CANCELLATION_FEE_BLOCK_EPS_CO`, por defecto activado). Solo `false`
 * (sin distinguir mayúsculas) lo desactiva.
 */
export function epsCoBlockEnabled(raw: string | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() !== 'false';
}
