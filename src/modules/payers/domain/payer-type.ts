/**
 * Tipo de pagador (DX-326). Cinco tipos genéricos, válidos para cualquier
 * clínica y cualquier sede.
 */
export const PAYER_TYPES = [
  'INSURER',
  'PREPAID_PLAN',
  'PUBLIC_SYSTEM',
  'EMPLOYER',
  'OTHER',
] as const;

export type PayerType = (typeof PAYER_TYPES)[number];

const EXTERNAL: Readonly<Record<PayerType, boolean>> = {
  INSURER: true,
  PREPAID_PLAN: true,
  PUBLIC_SYSTEM: true,
  EMPLOYER: true,
  OTHER: false,
};

/**
 * SEC-047/SEC-049: externo = lo respalda alguien de fuera; OTHER es interno
 * (cortesía, empleados). Lanza con cualquier valor que no sea una clave propia
 * de la tabla, también con `constructor`, `toString` o `__proto__`.
 */
export function isExternalPayer(type: PayerType): boolean {
  const result: unknown = Object.hasOwn(EXTERNAL, type)
    ? EXTERNAL[type]
    : undefined;
  if (typeof result !== 'boolean') {
    throw new Error(`Tipo de pagador desconocido: ${String(type)}`);
  }
  return result;
}

export function isPayerType(value: unknown): value is PayerType {
  return typeof value === 'string' && Object.hasOwn(EXTERNAL, value);
}
