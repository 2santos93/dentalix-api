import { randomBytes } from 'node:crypto';
import { parseMailEncryptionKey } from './email-payload-cipher';

export const MAIL_CONFIG = Symbol('MAIL_CONFIG');

export type MailTransport = 'console' | 'smtp' | 'file';

export interface MailConfig {
  transport: MailTransport;
  smtpUrl: string | null;
  /** Carpeta del FileMailer (MAIL_TRANSPORT=file, solo dev y e2e). */
  fileDir: string | null;
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
  /** NODE_ENV=production: un despachador sin acceso aborta el arranque. */
  production: boolean;
  /** Topes anti-abuso por clínica (DX-088, revisión B1). */
  quotas: {
    /** Emails de una clínica en 24 h (MAIL_TENANT_DAILY_LIMIT). */
    tenantDaily: number;
    /** Emails al mismo destinatario de una clínica en 24 h (MAIL_RECIPIENT_DAILY_LIMIT). */
    recipientDaily: number;
    /** Segundos mínimos entre dos emails al mismo destinatario (MAIL_RECIPIENT_COOLDOWN_SECONDS). */
    recipientCooldownSeconds: number;
  };
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
const DEFAULT_TENANT_DAILY = 50;
const DEFAULT_RECIPIENT_DAILY = 5;
const DEFAULT_RECIPIENT_COOLDOWN_S = 60;

function intOr(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : fallback;
}

/**
 * Configuración del email (DX-088) a partir del entorno ya validado por
 * `validateEnv` (env.validation.ts).
 *
 * - `MAIL_TRANSPORT`: `console` (default fuera de producción) | `smtp` |
 *   `file` (DX-010: deja cada email en `MAIL_FILE_DIR`; solo dev y e2e, la
 *   validación del arranque lo prohíbe en producción).
 * - `SMTP_URL`, `MAIL_FROM`: el proveedor (obligatorios con smtp).
 * - `MAIL_ENCRYPTION_KEY`: 32 bytes hex/base64; cifra los pendientes.
 * - `MAIL_DISPATCH_INTERVAL_MS`: barrido periódico; default 30 s, y 0 con
 *   `NODE_ENV=test` (los tests disparan el despachador a mano).
 * - `MAIL_RETRY_BASE_MS`: base del backoff (default 60 s).
 * - Topes: `MAIL_TENANT_DAILY_LIMIT` (50/24 h por clínica),
 *   `MAIL_RECIPIENT_DAILY_LIMIT` (5/24 h al mismo destinatario) y
 *   `MAIL_RECIPIENT_COOLDOWN_SECONDS` (60 s entre dos al mismo destinatario).
 */
export function loadMailConfig(
  get: (key: string) => string | undefined,
): MailConfig {
  const requested = get('MAIL_TRANSPORT')?.trim().toLowerCase();
  const transport: MailTransport =
    requested === 'smtp' || requested === 'file' ? requested : 'console';
  const configuredKey = parseMailEncryptionKey(get('MAIL_ENCRYPTION_KEY'));
  const isTest = get('NODE_ENV') === 'test';
  return {
    transport,
    smtpUrl: get('SMTP_URL')?.trim() || null,
    fileDir: get('MAIL_FILE_DIR')?.trim() || null,
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
    production: get('NODE_ENV') === 'production',
    quotas: {
      tenantDaily: Math.max(
        1,
        intOr(get('MAIL_TENANT_DAILY_LIMIT'), DEFAULT_TENANT_DAILY),
      ),
      recipientDaily: Math.max(
        1,
        intOr(get('MAIL_RECIPIENT_DAILY_LIMIT'), DEFAULT_RECIPIENT_DAILY),
      ),
      recipientCooldownSeconds: intOr(
        get('MAIL_RECIPIENT_COOLDOWN_SECONDS'),
        DEFAULT_RECIPIENT_COOLDOWN_S,
      ),
    },
    ephemeralKey: configuredKey === null,
  };
}
