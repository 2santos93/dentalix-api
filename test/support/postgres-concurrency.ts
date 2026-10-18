import type { Prisma, PrismaClient } from '@prisma/client';

/** Señal explícita: nunca se deduce el avance de una pausa del scheduler. */
export function gate<T = void>(): {
  wait: Promise<T>;
  open: (value: T) => void;
} {
  let open!: (value: T) => void;
  const wait = new Promise<T>((resolve) => (open = resolve));
  return { wait, open };
}

export type Outcome<T> =
  { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

/** Engancha ambos manejadores ANTES de devolver el control al scheduler. */
export function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
}

/** XID exacto del holder; no cuenta esperas de otras suites ni pacientes. */
export async function transactionId(
  tx: Prisma.TransactionClient,
): Promise<string> {
  const [row] = await tx.$queryRaw<{ xid: string }[]>`
    SELECT pg_current_xact_id()::text AS xid`;
  return row.xid;
}

/** El intervalo solo limita el sondeo; la condición de avance es pg_locks. */
export async function waitForTransactionWaiters(
  observer: PrismaClient,
  xid: string,
  count = 1,
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const [row] = await observer.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_catalog.pg_locks
       WHERE locktype = 'transactionid' AND transactionid::text = ${xid}
         AND NOT granted`;
    if (row.waiting >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `no llegaron ${count} esperas al bloqueo de la transacción ${xid}`,
  );
}
