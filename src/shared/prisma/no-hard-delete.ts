import { Prisma } from '@prisma/client';

/**
 * Guardia en tiempo de ejecución contra el borrado duro.
 *
 * En Dentalix ningún dato de negocio se borra: se retira marcando `deletedAt`.
 * Esa convención se sostenía sólo por disciplina en cada repositorio — nada
 * impedía que un `.delete()` se colara en la siguiente PR y se llevara filas
 * por delante sin dejar rastro. Esta guardia la vuelve estructural: envuelve el
 * cliente de transacción de `runWithTenant` y lanza si alguien llama `delete` o
 * `deleteMany` sobre un modelo que no esté en la allowlist.
 *
 * Alcance, para no venderla como más de lo que es:
 * - CUBRE todo lo que pasa por `runWithTenant`, que es donde vive el 100% de
 *   los datos con RLS (pacientes, citas, planes, abonos, inventario, horarios…).
 * - NO cubre el SQL crudo (`$executeRaw`) ni las tablas globales que se tocan
 *   con el cliente base fuera de transacción (`revoked_tokens`). Para eso está
 *   la regla de ESLint `no-restricted-syntax` en `eslint.config.mjs`, que marca
 *   cualquier `.delete(`/`.deleteMany(` en `src/` en tiempo de revisión.
 */

/**
 * Modelos donde un borrado duro es legítimo dentro de una transacción de tenant.
 *
 * Está vacío a propósito. Cada entrada aquí es una decisión de diseño explícita
 * (dato derivado, caché, o housekeeping con TTL), nunca un atajo para no añadir
 * la columna `deletedAt`.
 */
const HARD_DELETE_ALLOWLIST: ReadonlySet<string> = new Set<string>();

const FORBIDDEN_OPERATIONS: ReadonlySet<string> = new Set([
  'delete',
  'deleteMany',
]);

export class HardDeleteForbiddenError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
  ) {
    super(
      `Borrado duro prohibido: ${model}.${operation}(). En Dentalix los datos ` +
        `se retiran en blando — usa update/updateMany con { deletedAt: new Date() } ` +
        `y filtra { deletedAt: null } en las lecturas. Si este modelo de verdad ` +
        `debe poder borrarse (dato derivado o housekeeping con TTL), añádelo a ` +
        `HARD_DELETE_ALLOWLIST en src/shared/prisma/no-hard-delete.ts con el ` +
        `motivo escrito.`,
    );
    this.name = 'HardDeleteForbiddenError';
  }
}

type UnknownFn = (...args: unknown[]) => unknown;

/** Lee la propiedad conservando el `this` del delegate original. */
function readBound(
  target: object,
  prop: string | symbol,
  receiver: unknown,
): unknown {
  const value: unknown = Reflect.get(target, prop, receiver);
  return typeof value === 'function'
    ? (value as UnknownFn).bind(target)
    : value;
}

function wrapDelegate(model: string, delegate: object): object {
  return new Proxy(delegate, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && FORBIDDEN_OPERATIONS.has(prop)) {
        return () => {
          throw new HardDeleteForbiddenError(model, prop);
        };
      }
      return readBound(target, prop, receiver);
    },
  });
}

/**
 * Devuelve un `tx` equivalente en el que `delete`/`deleteMany` lanzan para todo
 * modelo fuera de la allowlist. Los `$`-métodos (`$executeRaw`, `$queryRaw`) y
 * todo lo demás pasan intactos.
 */
export function guardHardDeletes(
  tx: Prisma.TransactionClient,
): Prisma.TransactionClient {
  const delegateCache = new Map<string, object>();

  return new Proxy(tx, {
    get(target, prop, receiver) {
      // `$transaction`, `$executeRaw`, símbolos internos: sin tocar.
      if (typeof prop !== 'string' || prop.startsWith('$')) {
        return readBound(target, prop, receiver);
      }

      const value: unknown = Reflect.get(target, prop, receiver);
      // Sólo los delegates de modelo son objetos; el resto se devuelve tal cual.
      if (typeof value !== 'object' || value === null) {
        return readBound(target, prop, receiver);
      }
      if (HARD_DELETE_ALLOWLIST.has(prop)) {
        return value;
      }

      // Un delegate estable por modelo: el Proxy se crea una vez, no en cada
      // acceso, para que `tx.patient` siga siendo comparable consigo mismo.
      const cached = delegateCache.get(prop);
      if (cached) return cached;
      const wrapped = wrapDelegate(prop, value);
      delegateCache.set(prop, wrapped);
      return wrapped;
    },
  });
}
