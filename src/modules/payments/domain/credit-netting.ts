/**
 * «A cuenta» neto de lo devuelto o traspasado (DX-399, DX-253, DX-399-ter).
 * Regla ÚNICA del saldo a favor de un plan: la usan el informe «Cobrado sin
 * imputar», el detalle de un abono (`GET /payments/:id/allocations`), la
 * imputación automática y la manual (DX-399-bis), el «Sin imputar» del estado
 * de cuenta y de la pestaña Plan (`executeWithItems`) y el diagnóstico
 * `credit-netting:report`, para que cuadren por construcción.
 *
 * Fuentes del saldo a favor de un plan: lo que sus abonos tienen sin imputar a
 * ítems y lo que recibió por traspaso (asientos TRANSFER_IN). Salidas: las
 * devoluciones y los traspasos de salida (REFUND, TRANSFER_OUT).
 *
 * Orden de consumo (DX-399-ter). Los asientos de salida se aplican en orden
 * cronológico (`createdAt`); cada uno solo puede consumir fuentes REGISTRADAS
 * antes que él (`createdAt <= el del asiento`, instantes del servidor: `paidAt`
 * es un día y puede ser anterior), sin bajar ninguna de 0, en este orden:
 *   1. lo recibido por traspaso, del más reciente al más antiguo (`createdAt`
 *      y luego id);
 *   2. los abonos, del de `paidAt` más reciente al más antiguo (`createdAt` y
 *      luego id): el LIFO de DX-399, sin cambios.
 * Lo que no encuentre fuente se descarta (no es dinero a cuenta de ninguna).
 *
 * Por qué el traspaso recibido va primero y no un FIFO común: el saldo recibido
 * por traspaso no se puede imputar a ningún ítem, el excedente de un abono sí.
 * Gastar primero lo que no se imputa deja a los abonos todo lo que el plan aún
 * tiene, así que un ítem nuevo no queda «pendiente» con el saldo del plan en 0
 * (secuencia del ticket: excedente propio, traspaso recibido, devolución de 30,
 * ítem nuevo de 30). Con un FIFO por fecha la devolución saldría del abono, que
 * es más antiguo, y el ítem quedaría pendiente. Nunca se reparte dinero que ya
 * salió: lo que la regla deja a los abonos es como mucho Σ sin imputar −
 * (salidas − recibido por traspaso), que no pasa de lo que el plan tiene.
 * Un plan sin traspasos recibidos da exactamente lo de DX-399. Todo en
 * céntimos enteros.
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

/** Saldo a favor que el plan recibió por traspaso (asiento TRANSFER_IN). */
export interface CreditInEntry {
  id: string;
  planId: string;
  createdAt: Date;
  /** Lo que entró al saldo del plan, en positivo. */
  cents: number;
}

export interface NettedPayment {
  /** A cuenta tras las salidas (0 = ya no queda nada). */
  netCents: number;
  /** Lo devuelto o traspasado que se atribuye a este abono. */
  creditOutCents: number;
}

/** Cómo se repartieron las salidas de un plan entre sus fuentes. */
export interface NettedPlan {
  /** Σ salidas (devoluciones y traspasos de salida). */
  outCents: number;
  /** Lo que absorbió el saldo recibido por traspaso. */
  absorbedByTransfersInCents: number;
  /** Lo que se atribuye a abonos (Σ `creditOutCents` del plan). */
  absorbedByPaymentsCents: number;
  /** Lo que no encontró fuente (outCents − lo absorbido). */
  discardedCents: number;
}

export interface CreditNetting {
  byPayment: Map<string, NettedPayment>;
  /** Solo los planes con alguna salida. */
  byPlan: Map<string, NettedPlan>;
}

const byIdDesc = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

export function netCredit(
  payments: readonly NettingPayment[],
  entries: readonly CreditOutEntry[],
  transfersIn: readonly CreditInEntry[],
): CreditNetting {
  const byPayment = new Map<string, NettedPayment>(
    payments.map((p) => [
      p.id,
      { netCents: p.unallocatedCents, creditOutCents: 0 },
    ]),
  );
  const paymentsOf = new Map<string, NettingPayment[]>();
  for (const p of payments) {
    paymentsOf.set(p.planId, [...(paymentsOf.get(p.planId) ?? []), p]);
  }
  const inLeft = new Map<string, number>(
    transfersIn.map((t) => [t.id, t.cents]),
  );
  const transfersOf = new Map<string, CreditInEntry[]>();
  for (const t of transfersIn) {
    transfersOf.set(t.planId, [...(transfersOf.get(t.planId) ?? []), t]);
  }
  const byPlan = new Map<string, NettedPlan>();
  const sortedEntries = [...entries].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  for (const entry of sortedEntries) {
    const plan = byPlan.get(entry.planId) ?? {
      outCents: 0,
      absorbedByTransfersInCents: 0,
      absorbedByPaymentsCents: 0,
      discardedCents: 0,
    };
    byPlan.set(entry.planId, plan);
    plan.outCents += entry.cents;
    const before = (x: { createdAt: Date }) =>
      x.createdAt.getTime() <= entry.createdAt.getTime();
    let remaining = entry.cents;
    // 1. Lo recibido por traspaso, del más reciente al más antiguo.
    const transfers = (transfersOf.get(entry.planId) ?? [])
      .filter(before)
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || byIdDesc(a, b),
      );
    for (const t of transfers) {
      if (remaining <= 0) break;
      const left = inLeft.get(t.id) as number;
      const take = Math.min(left, remaining);
      inLeft.set(t.id, left - take);
      plan.absorbedByTransfersInCents += take;
      remaining -= take;
    }
    // 2. Los abonos, del de `paidAt` más reciente al más antiguo (DX-399).
    const candidates = (paymentsOf.get(entry.planId) ?? [])
      .filter(before)
      .sort(
        (a, b) =>
          b.paidAt.getTime() - a.paidAt.getTime() ||
          b.createdAt.getTime() - a.createdAt.getTime() ||
          byIdDesc(a, b),
      );
    for (const p of candidates) {
      if (remaining <= 0) break;
      const state = byPayment.get(p.id) as NettedPayment;
      const take = Math.min(state.netCents, remaining);
      state.netCents -= take;
      state.creditOutCents += take;
      plan.absorbedByPaymentsCents += take;
      remaining -= take;
    }
    plan.discardedCents += remaining;
  }
  return { byPayment, byPlan };
}

/** El resultado por abono de `netCredit`. */
export function netUnallocated(
  payments: readonly NettingPayment[],
  entries: readonly CreditOutEntry[],
  transfersIn: readonly CreditInEntry[],
): Map<string, NettedPayment> {
  return netCredit(payments, entries, transfersIn).byPayment;
}
