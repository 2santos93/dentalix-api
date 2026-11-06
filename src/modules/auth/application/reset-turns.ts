/** Por qué no hubo turno: la cola estaba llena o se esperó demasiado. */
export type TurnRefusal = 'QUEUE_FULL' | 'QUEUE_EXPIRED';

interface Waiter {
  since: number;
  resolve: (refusal: TurnRefusal | null) => void;
}

/**
 * DX-149-quater: turnos del restablecimiento de contraseña en un proceso.
 * Como el semáforo de OPS-056 (FIFO, la plaza pasa directa al siguiente),
 * pero con la cola ACOTADA: el endpoint es público y lo que espera ocupa
 * memoria. No se comparte con nadie más (OPS-056 sigue igual).
 *
 * - `acquire()` da turno (`null`) si hay plaza; si no, espera en cola; si la
 *   cola ya tiene `maxQueue`, `QUEUE_FULL` al momento, sin esperar.
 * - Al soltar una plaza, el siguiente que lleve más de `maxWaitMs` en cola
 *   recibe `QUEUE_EXPIRED` y la plaza pasa al siguiente.
 */
export class ResetTurns {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueue: number,
    private readonly maxWaitMs: number,
    private readonly now: () => number,
  ) {}

  /** Cuántos esperan turno ahora. */
  get waiting(): number {
    return this.queue.length;
  }

  acquire(): Promise<TurnRefusal | null> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(null);
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.resolve('QUEUE_FULL');
    }
    return new Promise((resolve) =>
      this.queue.push({ since: this.now(), resolve }),
    );
  }

  /** Suelta la plaza: al siguiente que aún no caducó, o queda libre. */
  release(): void {
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      if (this.now() - next.since > this.maxWaitMs) {
        next.resolve('QUEUE_EXPIRED');
        continue;
      }
      next.resolve(null);
      return;
    }
    this.active--;
  }
}
