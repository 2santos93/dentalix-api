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

/** PID de la conexión que ejecuta `tx` (la que sostiene sus bloqueos). */
export async function backendPid(
  tx: Prisma.TransactionClient,
): Promise<number> {
  const [row] = await tx.$queryRaw<{ pid: number }[]>`
    SELECT pg_backend_pid()::int AS pid`;
  return row.pid;
}

/**
 * Espera a que haya `count` sesiones esperando un bloqueo que tienen los
 * `holderPids` del test, directa o detrás de otra espera (`pg_blocking_pids`): no cuenta las esperas de otra
 * suite, de otra clínica ni de un barrido que corra a la vez en la misma BD.
 */
export async function waitForLockWaiters(
  observer: PrismaClient,
  holderPids: number[],
  count = 1,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // Transitivo: una espera detrás de otra espera del mismo bloqueo (p. ej.
    // la que pide el plan que tiene otra que ya espera el ítem) también cuenta.
    const [row] = await observer.$queryRaw<{ waiting: number }[]>`
      WITH RECURSIVE chain(pid) AS (
        SELECT a.pid FROM pg_catalog.pg_stat_activity a
         WHERE a.datname = current_database()
           AND a.wait_event_type = 'Lock'
           AND pg_blocking_pids(a.pid) && ${holderPids}::int[]
        UNION
        SELECT a.pid FROM pg_catalog.pg_stat_activity a
          JOIN chain c ON c.pid = ANY (pg_blocking_pids(a.pid))
         WHERE a.datname = current_database()
           AND a.wait_event_type = 'Lock'
      )
      SELECT count(*)::int AS waiting FROM chain`;
    if (row.waiting >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `no llegaron ${count} esperas a un bloqueo de los pid ${holderPids.join(',')}`,
  );
}

/** Una pausa dentro de una transacción: `reached` al llegar, sigue con `release`. */
export interface SqlStop {
  /** Cuándo parar: la sentencia (texto SQL de un `$queryRaw`) que lo cumple. */
  match: RegExp;
  /** Se abre con el PID de la conexión una vez ejecutada la sentencia. */
  reached: ReturnType<typeof gate<number>>;
  release: ReturnType<typeof gate<void>>;
}

export const sqlStop = (match: RegExp): SqlStop => ({
  match,
  reached: gate<number>(),
  release: gate<void>(),
});

type RunWithTenant = (...args: unknown[]) => Promise<unknown>;

/**
 * Envuelve CADA `runWithTenant` de `prisma` para que, la primera vez que una
 * transacción ejecute (con `$queryRaw`) una sentencia que cumpla `stop.match`,
 * se pare DESPUÉS de ella —con sus bloqueos ya tomados— hasta `release`.
 * Cada parada se dispara una sola vez. Devuelve la función que lo deshace.
 */
export function pauseAfterSql(
  prisma: { runWithTenant: unknown },
  stops: SqlStop[],
): () => void {
  const target = prisma as { runWithTenant: RunWithTenant };
  const original = target.runWithTenant.bind(prisma);
  const fired = new Set<SqlStop>();
  target.runWithTenant = (...args: unknown[]) => {
    const index = args.findIndex((a) => typeof a === 'function');
    const fn = args[index] as (
      tx: Prisma.TransactionClient,
    ) => Promise<unknown>;
    const wrapped = (tx: Prisma.TransactionClient) =>
      fn(
        new Proxy(tx, {
          get(inner, prop) {
            if (prop !== '$queryRaw')
              return Reflect.get(inner, prop) as unknown;
            return async (first: unknown, ...rest: unknown[]) => {
              const call = inner.$queryRaw as (
                ...a: unknown[]
              ) => Promise<unknown>;
              const result = await call.call(inner, first, ...rest);
              const text = sqlText(first);
              const stop = stops.find(
                (s) => !fired.has(s) && s.match.test(text),
              );
              if (stop) {
                fired.add(stop);
                stop.reached.open(await backendPid(inner));
                await stop.release.wait;
              }
              return result;
            };
          },
        }),
      );
    const next = [...args];
    next[index] = wrapped;
    return original(...next);
  };
  return () => {
    delete (target as { runWithTenant?: unknown }).runWithTenant;
    // Nunca deja una transacción pausada reteniendo bloqueos si el caso falló.
    for (const stop of stops) stop.release.open();
  };
}

function sqlText(first: unknown): string {
  if (Array.isArray(first)) return first.join(' ');
  const strings = (first as { strings?: string[] } | null)?.strings;
  return strings ? strings.join(' ') : String(first);
}

/**
 * `stop.reached` con tope: si la petición pausada termina antes de llegar a la
 * parada (p. ej. un 4xx/5xx) o no llega en `ms`, falla con un mensaje claro en
 * vez de esperar al timeout de jest.
 */
export async function reachedWithin(
  stop: SqlStop,
  request: Promise<Outcome<unknown>>,
  label: string,
  ms = 5000,
): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      stop.reached.wait,
      request.then((outcome) => {
        throw new Error(
          `${label}: la petición terminó sin llegar a la pausa: ${JSON.stringify(
            outcome.status === 'fulfilled'
              ? { status: (outcome.value as { status?: number }).status }
              : String(outcome.reason),
          )}`,
        );
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: no llegó a la pausa en ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Las sentencias que esperan ahora un bloqueo de los `holderPids`. */
export async function waitingQueries(
  observer: PrismaClient,
  holderPids: number[],
): Promise<string[]> {
  const rows = await observer.$queryRaw<{ query: string }[]>`
    SELECT a.query FROM pg_catalog.pg_stat_activity a
     WHERE a.datname = current_database()
       AND a.wait_event_type = 'Lock'
       AND pg_blocking_pids(a.pid) && ${holderPids}::int[]`;
  return rows.map((r) => r.query);
}

/** Un bloqueo retenido por una transacción propia hasta `release()`. */
export interface HeldLock {
  /** PID de la conexión que lo retiene: lo que mira `waitForLockWaiters`. */
  pid: number;
  /** Suelta el bloqueo (la transacción termina; con `finish` hace sus cambios). */
  release: () => void;
  /** La transacción del holder; espérala tras `release()`. */
  done: Promise<void>;
}

/**
 * DX-450: `acquire` toma el bloqueo en una transacción del `owner` (SELECT …
 * FOR UPDATE, FOR NO KEY UPDATE…) y se queda con él hasta `release()`. El
 * `timeout` de la transacción es mayor que cualquier espera del test. Si
 * `afterRelease` existe, se ejecuta con el bloqueo aún puesto, justo antes del
 * COMMIT (p. ej. el cambio que la otra conexión debe ver al entrar).
 */
export async function holdLock(
  owner: PrismaClient,
  acquire: (tx: Prisma.TransactionClient) => Promise<unknown>,
  afterRelease?: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<HeldLock> {
  const holdOpen = gate<void>();
  const locked = gate<number>();
  const done = owner.$transaction(
    async (tx) => {
      await acquire(tx);
      locked.open(await backendPid(tx));
      await holdOpen.wait;
      if (afterRelease) await afterRelease(tx);
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  // Si `acquire` falla, el test lo ve en `done` en vez de quedarse esperando.
  const pid = await Promise.race([
    locked.wait,
    done.then(() => {
      throw new Error('holdLock: la transacción terminó sin tomar el bloqueo');
    }),
  ]);
  return { pid, release: () => holdOpen.open(), done };
}
