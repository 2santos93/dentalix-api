import { PaymentMethod, PaymentMethodKind } from '@prisma/client';

/**
 * DX-377: reglas del catálogo de medios de pago de la clínica y de la
 * referencia del pagador. Funciones puras: las usan los casos de uso del
 * catálogo y el alta del abono.
 */

export const PAYMENT_METHOD_NAME_MAX = 60;
export const REFERENCE_MAX = 60;
export const DUPLICATE_REFERENCE_REASON_MAX = 300;
/** Ventana, a cada lado del pago, en la que una referencia igual avisa. */
export const DUPLICATE_REFERENCE_WINDOW_DAYS = 90;

/** Código estable del 409 de referencia repetida. */
export const PAYMENT_REFERENCE_DUPLICATE = 'PAYMENT_REFERENCE_DUPLICATE';

export const PAYMENT_METHOD_NOT_FOUND_MESSAGE =
  'Medio de pago no encontrado en esta clínica.';
export const PAYMENT_METHOD_INACTIVE_MESSAGE =
  'Ese medio de pago está desactivado: elige uno activo.';
export const DUPLICATE_PAYMENT_METHOD_NAME_MESSAGE =
  'Ya existe un medio de pago con ese nombre.';
export const PAYMENT_METHODS_ADMIN_MESSAGE =
  'Solo un administrador puede gestionar los medios de pago.';
/**
 * Un medio inicial (con `legacyMethod`) es el que reciben los clientes y las
 * réplicas anteriores que solo mandan `method`: su tipo base no puede cambiar,
 * o un abono «en efectivo» de un cliente anterior se guardaría con otro
 * método (el del tipo nuevo) y la caja lo contaría donde no es.
 */
export const INITIAL_KIND_LOCKED_MESSAGE =
  'El tipo base de un medio inicial no se puede cambiar. Crea un medio nuevo con ese tipo y desactiva este si ya no lo usas.';
export const REFERENCE_REQUIRED_MESSAGE =
  'Este medio de pago pide la referencia del pago.';
export const REFERENCE_TOO_LONG_MESSAGE = `La referencia admite como mucho ${REFERENCE_MAX} caracteres.`;
export const DUPLICATE_REFERENCE_REASON_TOO_LONG_MESSAGE = `El motivo admite como mucho ${DUPLICATE_REFERENCE_REASON_MAX} caracteres.`;

/**
 * Los 4 medios iniciales de toda clínica, uno por método antiguo: los rellena
 * la migración 20261103120100 en las existentes y el alta en las nuevas.
 */
export const INITIAL_PAYMENT_METHODS: ReadonlyArray<{
  name: string;
  kind: PaymentMethodKind;
  legacyMethod: PaymentMethod;
}> = [
  { name: 'Efectivo', kind: 'CASH', legacyMethod: 'CASH' },
  { name: 'Tarjeta', kind: 'CARD', legacyMethod: 'CARD' },
  { name: 'Transferencia', kind: 'TRANSFER', legacyMethod: 'TRANSFER' },
  { name: 'Otro', kind: 'OTHER', legacyMethod: 'OTHER' },
];

/**
 * El método antiguo que se sigue escribiendo en el abono (réplicas anteriores
 * e informes por método). DIGITAL (billeteras, pagos desde el móvil) mueve
 * dinero entre cuentas y se concilia con el extracto como una transferencia:
 * se guarda como TRANSFER, no como OTHER.
 */
export function legacyPaymentMethodOf(kind: PaymentMethodKind): PaymentMethod {
  switch (kind) {
    case 'CASH':
      return 'CASH';
    case 'CARD':
      return 'CARD';
    case 'TRANSFER':
    case 'DIGITAL':
      return 'TRANSFER';
    case 'OTHER':
      return 'OTHER';
  }
}

export function paymentMethodNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return 'El nombre del medio de pago es obligatorio.';
  }
  if (trimmed.length > PAYMENT_METHOD_NAME_MAX) {
    return `El nombre del medio de pago admite como mucho ${PAYMENT_METHOD_NAME_MAX} caracteres.`;
  }
  return null;
}

/** Para comparar: sin ningún espacio y en mayúsculas; vacía es `null`. */
export function normalizeReference(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const normalized = raw.replace(/\s+/g, '').toUpperCase();
  return normalized === '' ? null : normalized;
}

/** El error de la referencia tecleada para un medio, o `null` si vale. */
export function referenceError(
  raw: string | null | undefined,
  requiresReference: boolean,
): string | null {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '' || normalizeReference(trimmed) === null) {
    return requiresReference ? REFERENCE_REQUIRED_MESSAGE : null;
  }
  return trimmed.length > REFERENCE_MAX ? REFERENCE_TOO_LONG_MESSAGE : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Los abonos con `paidAt` en esta ventana cuentan como repetidos. */
export function duplicateReferenceWindow(paidAt: Date): {
  from: Date;
  to: Date;
} {
  const span = DUPLICATE_REFERENCE_WINDOW_DAYS * DAY_MS;
  return {
    from: new Date(paidAt.getTime() - span),
    to: new Date(paidAt.getTime() + span),
  };
}
