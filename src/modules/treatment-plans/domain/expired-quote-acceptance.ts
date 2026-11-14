import {
  ExpiredQuoteAcceptanceMode,
  ExpiredQuoteAcceptanceReason,
} from '@prisma/client';

/**
 * DX-379 (porción C): aceptar un presupuesto VENCIDO. Firmado en la clínica,
 * hay que elegir cómo: actualizar los precios antes de firmar (REPRICE, la
 * recotización de la porción B en la misma transacción) o aceptar con los
 * precios del presupuesto vencido indicando el motivo (ORIGINAL_PRICES). Sin
 * firma (PATCH de estado) o a distancia (DX-415) no se acepta un vencido.
 */

/** `code` del 409 de un presupuesto vencido (la web abre la elección). */
export const QUOTE_EXPIRED_CODE = 'QUOTE_EXPIRED';

/** Tope de la nota del motivo (como la del descuento, DX-204). */
export const EXPIRED_NOTE_MAX = 200;

/** Cómo lo dice la pantalla y el documento aceptado. */
export const EXPIRED_REASON_LABELS: Record<
  ExpiredQuoteAcceptanceReason,
  string
> = {
  CLINIC_DELAY: 'La clínica tardó en cerrarlo',
  PRICE_COMMITMENT: 'Se mantuvo el precio pactado',
  LOYALTY: 'Paciente habitual',
  FINANCIAL_HARDSHIP: 'Situación económica',
  OTHER: 'Otro',
};

/** 409 de la firma en la clínica sin elegir cómo (`day`: fecha ya formateada). */
export function quoteExpiredAcceptMessage(day: string): string {
  return `El presupuesto venció el ${day}. Actualiza los precios o acepta con los precios originales indicando el motivo.`;
}

/** 409 del PATCH de estado (sin firma): no hay dónde dejar el motivo. */
export function quoteExpiredStatusMessage(day: string): string {
  return `El presupuesto venció el ${day}: acéptalo con firma para elegir cómo.`;
}

/** 409 al enviar a firmar a distancia (DX-415) un presupuesto vencido. */
export function quoteExpiredRemoteMessage(day: string): string {
  return `El presupuesto venció el ${day}: actualiza sus precios antes de enviarlo a firmar a distancia.`;
}

export const EXPIRED_NOT_EXPIRED_MESSAGE =
  'El presupuesto no está vencido: acéptalo sin elegir cómo.';
export const EXPIRED_REASON_REQUIRED_MESSAGE =
  'Para aceptar con los precios originales, indica el motivo.';
export const EXPIRED_NOTE_REQUIRED_MESSAGE = `Con el motivo «Otro», escribe una nota (hasta ${EXPIRED_NOTE_MAX} caracteres).`;
export const EXPIRED_NOTE_TOO_LONG_MESSAGE = `La nota del motivo admite hasta ${EXPIRED_NOTE_MAX} caracteres.`;
export const EXPIRED_PREVIEW_REQUIRED_MESSAGE =
  'Para actualizar los precios antes de aceptar, revisa primero la vista previa del presupuesto actualizado.';
export const EXPIRED_REPRICE_NO_REASON_MESSAGE =
  'Al actualizar los precios no se indica motivo ni nota: el presupuesto deja de estar vencido.';
export const EXPIRED_ORIGINAL_NO_PREVIEW_MESSAGE =
  'Con los precios originales no se envía la vista previa de la actualización.';

/** Lo que llega del cliente (ya validado en tipos por el DTO). */
export interface ExpiredAcceptanceInput {
  mode: ExpiredQuoteAcceptanceMode;
  reason?: ExpiredQuoteAcceptanceReason | null;
  note?: string | null;
  repricePreviewHash?: string | null;
}

/** La elección, coherente. */
export type ExpiredAcceptanceChoice =
  | {
      mode: typeof ExpiredQuoteAcceptanceMode.ORIGINAL_PRICES;
      reason: ExpiredQuoteAcceptanceReason;
      /** Recortada; null sin nota. */
      note: string | null;
    }
  | {
      mode: typeof ExpiredQuoteAcceptanceMode.REPRICE;
      repricePreviewHash: string;
    };

/** Lo que se guarda en la aceptación (columnas fuera del contenido). */
export interface ExpiredAcceptanceRecord {
  /** Último día válido del presupuesto del plan al firmar (antes de recotizar). */
  quoteValidUntil: string | null;
  mode: ExpiredQuoteAcceptanceMode | null;
  reason: ExpiredQuoteAcceptanceReason | null;
  note: string | null;
  repricingId: string | null;
}

export class ExpiredAcceptanceInputError extends Error {}

/**
 * La elección coherente, o `ExpiredAcceptanceInputError` (400) con el texto
 * para la pantalla: ORIGINAL_PRICES exige motivo (y nota con OTHER) y no lleva
 * huella; REPRICE exige la huella de la vista previa y no lleva motivo ni nota.
 */
export function parseExpiredAcceptance(
  input: ExpiredAcceptanceInput,
): ExpiredAcceptanceChoice {
  const note = input.note?.trim() || null;
  if (input.mode === ExpiredQuoteAcceptanceMode.REPRICE) {
    if (input.reason || note) {
      throw new ExpiredAcceptanceInputError(EXPIRED_REPRICE_NO_REASON_MESSAGE);
    }
    if (!input.repricePreviewHash) {
      throw new ExpiredAcceptanceInputError(EXPIRED_PREVIEW_REQUIRED_MESSAGE);
    }
    return {
      mode: ExpiredQuoteAcceptanceMode.REPRICE,
      repricePreviewHash: input.repricePreviewHash.toLowerCase(),
    };
  }
  if (input.repricePreviewHash) {
    throw new ExpiredAcceptanceInputError(EXPIRED_ORIGINAL_NO_PREVIEW_MESSAGE);
  }
  if (!input.reason) {
    throw new ExpiredAcceptanceInputError(EXPIRED_REASON_REQUIRED_MESSAGE);
  }
  if (note !== null && note.length > EXPIRED_NOTE_MAX) {
    throw new ExpiredAcceptanceInputError(EXPIRED_NOTE_TOO_LONG_MESSAGE);
  }
  if (input.reason === ExpiredQuoteAcceptanceReason.OTHER && note === null) {
    throw new ExpiredAcceptanceInputError(EXPIRED_NOTE_REQUIRED_MESSAGE);
  }
  return {
    mode: ExpiredQuoteAcceptanceMode.ORIGINAL_PRICES,
    reason: input.reason,
    note,
  };
}

/** Código de auditoría de la firma de un presupuesto vencido. */
export function expiredAcceptanceAuditReason(
  mode: ExpiredQuoteAcceptanceMode,
): 'QUOTE_EXPIRED_ORIGINAL_PRICES' | 'QUOTE_EXPIRED_REPRICED' {
  return mode === ExpiredQuoteAcceptanceMode.REPRICE
    ? 'QUOTE_EXPIRED_REPRICED'
    : 'QUOTE_EXPIRED_ORIGINAL_PRICES';
}

/** Una aceptación sin presupuesto vencido y sin validez copiada. */
export const NO_EXPIRED_ACCEPTANCE: ExpiredAcceptanceRecord = Object.freeze({
  quoteValidUntil: null,
  mode: null,
  reason: null,
  note: null,
  repricingId: null,
});
