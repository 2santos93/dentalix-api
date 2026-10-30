import type { PaymentMethod } from '@prisma/client';

/** Medio de pago de un abono, tal como lo muestran la caja y el estado de cuenta. */
export interface PaymentMethodRef {
  id: string;
  name: string;
}

/**
 * DX-377/DX-395: los medios de la clínica, para nombrar el de cada abono y
 * contar un abono de una réplica anterior (sin medio) en el medio inicial de
 * su método. Lo usan la caja y el estado de cuenta, con el catálogo leído
 * bajo RLS en la misma transacción que los abonos.
 */
export interface MethodCatalog {
  byId: Map<string, PaymentMethodRef>;
  byLegacy: Map<PaymentMethod, PaymentMethodRef>;
}

export function catalogOf(
  rows: readonly {
    id: string;
    name: string;
    legacyMethod: PaymentMethod | null;
  }[],
): MethodCatalog {
  const byId = new Map<string, PaymentMethodRef>();
  const byLegacy = new Map<PaymentMethod, PaymentMethodRef>();
  for (const row of rows) {
    const ref = { id: row.id, name: row.name };
    byId.set(row.id, ref);
    if (row.legacyMethod) byLegacy.set(row.legacyMethod, ref);
  }
  return { byId, byLegacy };
}

/** El medio del abono; sin medio, el inicial de su método; sin método, `null`. */
export function methodRefOf(
  catalog: MethodCatalog,
  paymentMethodId: string | null,
  method: PaymentMethod | null,
): PaymentMethodRef | null {
  if (paymentMethodId) return catalog.byId.get(paymentMethodId) ?? null;
  return method ? (catalog.byLegacy.get(method) ?? null) : null;
}
