/**
 * «A cuenta» neto de lo devuelto o traspasado (DX-399, DX-253). Regla ÚNICA que
 * comparten el informe «Cobrado sin imputar» y el detalle de un abono
 * (`GET /payments/:id/allocations`), para que cuadren por construcción.
 *
 * Un asiento de salida del saldo a favor del plan (devolución o traspaso de
 * salida) solo puede absorber abonos REGISTRADOS antes que él (`payment.createdAt
 * <= entry.createdAt`, instantes del servidor: `paidAt` es un día y puede ser
 * anterior), empezando por el de `paidAt` más reciente de esos (LIFO) y sin bajar de 0
 * lo que a cada abono le queda a cuenta. Los asientos se aplican en orden
 * cronológico. Lo que no encuentre abono al que restar se descarta (no es
 * dinero a cuenta de ningún abono). Todo en céntimos enteros.
 */
export interface NettingPayment {
  id: string;
  planId: string;
  paidAt: Date;
  /** Cuándo se registró el abono (instante del servidor). */
  createdAt: Date;
  /** Base menos imputado: lo que queda a cuenta ANTES de las salidas (> 0). */
  unallocatedCents: number;
}

export interface CreditOutEntry {
  planId: string;
  createdAt: Date;
  /** Lo que salió del saldo del plan, en positivo. */
  cents: number;
}

export interface NettedPayment {
  /** A cuenta tras las salidas (0 = ya no queda nada). */
  netCents: number;
  /** Lo devuelto o traspasado que se atribuye a este abono. */
  creditOutCents: number;
}

export function netUnallocated(
  payments: readonly NettingPayment[],
  entries: readonly CreditOutEntry[],
): Map<string, NettedPayment> {
  const result = new Map<string, NettedPayment>(
    payments.map((p) => [
      p.id,
      { netCents: p.unallocatedCents, creditOutCents: 0 },
    ]),
  );
  const byPlan = new Map<string, NettingPayment[]>();
  for (const p of payments) {
    byPlan.set(p.planId, [...(byPlan.get(p.planId) ?? []), p]);
  }
  const sortedEntries = [...entries].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  for (const entry of sortedEntries) {
    const candidates = (byPlan.get(entry.planId) ?? [])
      .filter((p) => p.createdAt.getTime() <= entry.createdAt.getTime())
      .sort(
        (a, b) =>
          b.paidAt.getTime() - a.paidAt.getTime() ||
          b.createdAt.getTime() - a.createdAt.getTime() ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
    let remaining = entry.cents;
    for (const p of candidates) {
      if (remaining <= 0) break;
      const state = result.get(p.id) as NettedPayment;
      const take = Math.min(state.netCents, remaining);
      state.netCents -= take;
      state.creditOutCents += take;
      remaining -= take;
    }
  }
  return result;
}
