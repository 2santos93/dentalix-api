import { isQuoteExpired } from '../../treatment-plans/domain/quote-validity';

/**
 * DX-101-bis: el paciente acepta con su firma un presupuesto desde el portal.
 * Los textos que ve (sin decir nunca si el presupuesto estaba aceptado,
 * rechazado o vencido) y la regla de «se puede aceptar desde aquí».
 */

/** 404: el plan no existe o no es del paciente del enlace. */
export const PORTAL_QUOTE_NOT_FOUND_MESSAGE = 'No encontramos ese presupuesto.';

/** 403: el enlace no comparte los presupuestos. */
export const PORTAL_PLANS_SCOPE_REQUIRED_CODE = 'PATIENT_ACCESS_SCOPE_REQUIRED';
export const PORTAL_PLANS_SCOPE_REQUIRED_MESSAGE =
  'Este enlace no permite aceptar presupuestos.';

/**
 * 409 único para todo lo que impide aceptar: ya aceptado, rechazado,
 * cancelado, vencido, sin ítems, otra opción del grupo elegida, una hermana
 * cobrada o con trabajo hecho (DX-109) u otra aceptación simultánea.
 */
export const PORTAL_QUOTE_NOT_ACCEPTABLE_CODE = 'PORTAL_QUOTE_NOT_ACCEPTABLE';
export const PORTAL_QUOTE_NOT_ACCEPTABLE_MESSAGE =
  'Este presupuesto ya no se puede aceptar desde aquí. Contacta con la clínica.';

/** 409: el presupuesto vivo no es el que se mostró (otro `contentHash`). */
export const PORTAL_QUOTE_CHANGED_CODE = 'PORTAL_QUOTE_CHANGED';
export const PORTAL_QUOTE_CHANGED_MESSAGE =
  'El presupuesto ha cambiado. Recarga la página para ver la versión actual.';

/** Motivo del evento de auditoría (SIGN de TREATMENT_PLAN, PUBLIC_LINK). */
export const PORTAL_QUOTE_ACCEPTED_REASON = 'PORTAL_QUOTE_ACCEPTED';

/** Largo máximo del nombre de quien firma (tras recortar). */
export const PORTAL_SIGNER_NAME_MAX = 120;

/** Dentro de la transacción: no se puede aceptar (409 genérico). */
export class PortalQuoteNotAcceptableError extends Error {
  constructor() {
    super('El presupuesto no se puede aceptar desde el portal');
  }
}

/** Dentro de la transacción: el presupuesto vivo no es el mostrado. */
export class PortalQuoteChangedError extends Error {
  constructor() {
    super('El presupuesto cambió desde que se mostró en el portal');
  }
}

export interface PortalAcceptability {
  status: string;
  /** Ya tiene una aceptación firmada. */
  accepted: boolean;
  /** Otra opción de su grupo ya está aceptada o completada. */
  siblingChosen: boolean;
  itemCount: number;
  /** Último día válido guardado (`YYYY-MM-DD`) o null (no vence). */
  validUntil: string | null;
  /** Zona del día civil del vencimiento (la de la sede del plan). */
  timeZone: string | null;
}

/**
 * ¿Se puede aceptar desde el portal? Presentado, sin firmar, con ítems, sin
 * otra opción del grupo elegida y no vencido en el día de la sede del plan
 * (el portal nunca acepta un presupuesto vencido: eso se decide en la
 * clínica). Sin zona con la que decidir el día, no.
 */
export function isPortalQuoteAcceptable(
  plan: PortalAcceptability,
  now: Date,
): boolean {
  if (
    plan.status !== 'PRESENTED' ||
    plan.accepted ||
    plan.siblingChosen ||
    plan.itemCount === 0
  ) {
    return false;
  }
  if (plan.validUntil === null) return true;
  if (plan.timeZone === null) return false;
  return !isQuoteExpired(plan.validUntil, now, plan.timeZone);
}
