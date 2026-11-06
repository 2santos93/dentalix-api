import { AsyncLocalStorage } from 'node:async_hooks';

/** Plazas libres y quién espera una, en orden de llegada. */
class Semaphore {
  private readonly waiting: (() => void)[] = [];

  constructor(private free: number) {}

  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** La plaza pasa a la siguiente en cola, o vuelve a quedar libre. */
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free++;
  }
}

interface BudgetStore {
  semaphore: Semaphore;
  /** Este flujo ya está dentro de una transacción con plaza. */
  holding: boolean;
}

const budgets = new AsyncLocalStorage<BudgetStore>();

/**
 * OPS-056: acota a `limit` las transacciones tenant-scoped (`runWithTenant`,
 * una conexión del pool cada una) que tiene abiertas A LA VEZ todo lo que
 * `fn` arranca, aunque lo haga con `Promise.all`: la siguiente espera a que se
 * cierre una. Es para una petición que reúne muchas lecturas (`GET
 * /work-queues/summary`) y no debe ocupar ella sola el `connection_limit` de
 * la réplica.
 *
 * - Fuera de un presupuesto, `runWithTenant` no cambia (el resto de la API).
 * - Un presupuesto dentro de otro usa el de fuera: nunca suma plazas.
 * - Una transacción abierta desde DENTRO de otra no espera plaza (esperarla
 *   con todas las plazas ocupadas por quienes la abren sería un
 *   interbloqueo); esa sí suma una conexión, como hoy.
 * - La espera por la plaza no cuenta para `TENANT_TX_MAX_WAIT_MS`: Prisma
 *   empieza a contar al pedir la conexión, ya con la plaza.
 */
export function withTransactionBudget<T>(
  limit: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(
      `El presupuesto de transacciones debe ser un entero ≥ 1 (${limit})`,
    );
  }
  if (budgets.getStore()) return fn();
  return budgets.run({ semaphore: new Semaphore(limit), holding: false }, fn);
}

/** Abre `open` (una transacción) con una plaza del presupuesto en curso. */
export async function withinTransactionBudget<T>(
  open: () => Promise<T>,
): Promise<T> {
  const store = budgets.getStore();
  if (!store || store.holding) return open();
  await store.semaphore.acquire();
  try {
    return await budgets.run(
      { semaphore: store.semaphore, holding: true },
      open,
    );
  } finally {
    store.semaphore.release();
  }
}
