import { randomBytes } from 'node:crypto';
import { parseMailEncryptionKey } from './email-payload-cipher';

export const MAIL_CONFIG = Symbol('MAIL_CONFIG');

export interface MailConfig {
  transport: 'console' | 'smtp';
  smtpUrl: string | null;
  from: string;
  /** Cada cuánto barre el despachador; 0 = sin barrido (tests). */
  dispatchIntervalMs: number;
  /** Base del backoff exponencial entre intentos. */
  retryBaseMs: number;
  /** Arriendo de una fila reclamada: tras él, otra réplica puede reclamarla. */
  leaseSeconds: number;
  /** Filas por reclamo. */
  batchSize: number;
  encryptionKey: Buffer;
  /**
   * La clave se generó al arrancar porque MAIL_ENCRYPTION_KEY no venía (solo
   * fuera de producción: la validación del arranque la exige allí). Los
   * pendientes de un arranque anterior no se podrán descifrar y quedan FAILED.
   */
  ephemeralKey: boolean;
}

const DEFAULT_FROM = 'Dentalix <no-reply@dentalix.local>';
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 60_000;
/** Holgado frente al timeout del socket SMTP (60 s): no hay doble envío. */
const LEASE_SECONDS = 300;
const BATCH_SIZE = 20;

function intOr(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : fallback;
}

/**
 * Configuración del email (DX-088) a partir del entorno ya validado por
 * `validateEnv` (env.validation.ts).
 *
 * - `MAIL_TRANSPORT`: `console` (default fuera de producción) | `smtp`.
 * - `SMTP_URL`, `MAIL_FROM`: el proveedor (obligatorios con smtp).
 * - `MAIL_ENCRYPTION_KEY`: 32 bytes hex/base64; cifra los pendientes.
 * - `MAIL_DISPATCH_INTERVAL_MS`: barrido periódico; default 30 s, y 0 con
 *   `NODE_ENV=test` (los tests disparan el despachador a mano).
 * - `MAIL_RETRY_BASE_MS`: base del backoff (default 60 s).
 */
export function loadMailConfig(
  get: (key: string) => string | undefined,
): MailConfig {
  const transport =
    get('MAIL_TRANSPORT')?.trim().toLowerCase() === 'smtp' ? 'smtp' : 'console';
  const configuredKey = parseMailEncryptionKey(get('MAIL_ENCRYPTION_KEY'));
  const isTest = get('NODE_ENV') === 'test';
  return {
    transport,
    smtpUrl: get('SMTP_URL')?.trim() || null,
    from: get('MAIL_FROM')?.trim() || DEFAULT_FROM,
    dispatchIntervalMs: intOr(
      get('MAIL_DISPATCH_INTERVAL_MS'),
      isTest ? 0 : DEFAULT_INTERVAL_MS,
    ),
    retryBaseMs: Math.max(
      1,
      intOr(get('MAIL_RETRY_BASE_MS'), DEFAULT_RETRY_BASE_MS),
    ),
    leaseSeconds: LEASE_SECONDS,
    batchSize: BATCH_SIZE,
    encryptionKey: configuredKey ?? randomBytes(32),
    ephemeralKey: configuredKey === null,
  };
}
