import { boundedInt } from '../storage/storage-config';

/**
 * DX-431 (OPS-012): topes de las transacciones interactivas de Prisma
 * (`runWithTenant` y cualquier `$transaction(async (tx) => …)`), por entorno:
 *
 * - `TENANT_TX_TIMEOUT_MS` (5000, el default de Prisma): pasado, Prisma
 *   deshace la transacción y la petición sale con 503 `TRANSACTION_TIMEOUT`
 *   (PrismaExceptionFilter). Una transacción colgada no retiene su conexión
 *   del pool más que esto.
 * - `TENANT_TX_MAX_WAIT_MS` (2000, el default de Prisma): espera máxima por
 *   una conexión libre del pool para EMPEZAR la transacción; agotada, el mismo
 *   503.
 *
 * Una llamada que pasa su propio `timeout`/`maxWait` (los lotes acotados de
 * la importación, DX-107) sigue mandando. El `statement_timeout` de
 * `dentalix_app` (15 s, docker/prod/create-app-role.sql) acota además cada
 * sentencia, también dentro de esos lotes.
 */
export interface TransactionConfig {
  timeoutMs: number;
  maxWaitMs: number;
}

export const DEFAULT_TENANT_TX_TIMEOUT_MS = 5_000;
export const DEFAULT_TENANT_TX_MAX_WAIT_MS = 2_000;

export const TRANSACTION_LIMITS = {
  TENANT_TX_TIMEOUT_MS: [500, 120_000],
  TENANT_TX_MAX_WAIT_MS: [100, 60_000],
} as const satisfies Record<string, readonly [number, number]>;

type TransactionKey = keyof typeof TRANSACTION_LIMITS;
type Get = (key: string) => string | undefined;

const valueOf = (get: Get, key: TransactionKey): number | null =>
  boundedInt(get(key), TRANSACTION_LIMITS[key]);

export function loadTransactionConfig(get: Get): TransactionConfig {
  return {
    timeoutMs:
      valueOf(get, 'TENANT_TX_TIMEOUT_MS') ?? DEFAULT_TENANT_TX_TIMEOUT_MS,
    maxWaitMs:
      valueOf(get, 'TENANT_TX_MAX_WAIT_MS') ?? DEFAULT_TENANT_TX_MAX_WAIT_MS,
  };
}

/**
 * Problemas de configuración para `validateEnv`. `shutdownTimeoutMs` es el
 * tope del apagado ordenado (`SHUTDOWN_TIMEOUT_MS`): una transacción en vuelo
 * tiene que poder terminar dentro de él.
 */
export function transactionConfigProblems(
  get: Get,
  shutdownTimeoutMs: number,
): string[] {
  const problems: string[] = [];
  for (const [key, [min, max]] of Object.entries(TRANSACTION_LIMITS)) {
    const raw = get(key);
    if (raw == null || raw.trim() === '') continue;
    if (valueOf(get, key as TransactionKey) === null) {
      problems.push(`${key} debe ser un entero entre ${min} y ${max} (ms).`);
    }
  }
  if (problems.length > 0) return problems;

  const { timeoutMs } = loadTransactionConfig(get);
  if (timeoutMs >= shutdownTimeoutMs) {
    problems.push(
      `TENANT_TX_TIMEOUT_MS (${timeoutMs}) debe ser menor que SHUTDOWN_TIMEOUT_MS (${shutdownTimeoutMs}): el apagado ordenado tiene que esperar a las transacciones en vuelo.`,
    );
  }
  return problems;
}
