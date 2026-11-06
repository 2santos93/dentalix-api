import type { Prisma } from '@prisma/client';
import { EmailTemplateName } from '../email-message';

export const EMAIL_OUTBOX_REPOSITORY = Symbol('EMAIL_OUTBOX_REPOSITORY');

export type EmailDeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';

/** Fila nueva de PLATAFORMA (sin clínica): sin el email ni el token en claro. */
export interface NewPlatformOutboxEmail {
  template: EmailTemplateName;
  toHash: string;
  toMasked: string;
  referenceId: string | null;
  /** Mensaje cifrado (AES-256-GCM). */
  payload: Buffer;
}

/** Fila nueva de una clínica (se inserta bajo su RLS). */
export interface NewOutboxEmail extends NewPlatformOutboxEmail {
  tenantId: string;
}

/**
 * Tope por destinatario de los emails de plataforma (DX-144): como mucho uno
 * cada `recipientCooldownSeconds` y `recipientDaily` en 24 h al mismo hash.
 */
export interface PlatformRecipientQuota {
  recipientCooldownSeconds: number;
  recipientDaily: number;
}

/** Envío reclamado por el despachador (ya en SENDING, con el intento sumado). */
export interface ClaimedOutboxEmail {
  id: string;
  tenantId: string | null;
  payload: Buffer | null;
  /** Intentos contando el que empieza ahora. */
  attempts: number;
}

/**
 * PENDING lleva la ESPERA, no la hora: el próximo intento lo fija la BD
 * (`now() + espera`), con el mismo reloj con que lo reclama (DX-355).
 */
export type OutboxSettlement =
  | { status: 'SENT' }
  | { status: 'PENDING'; retryDelayMs: number; lastError: string }
  | { status: 'FAILED'; lastError: string };

/** Envíos recientes de una clínica, para sus topes anti-abuso (DX-088). */
export interface RecentSends {
  tenant: number;
  recipient: number;
  secondsSinceLastToRecipient: number | null;
}

/**
 * DX-149-bis: decide sobre el recuento hecho DENTRO de la transacción del
 * insert, con el candado de la clínica y del destinatario ya tomado. Lanza
 * para no insertar (la transacción se deshace).
 */
export type OutboxQuotaGuard = (sends: RecentSends) => void;

/**
 * DX-149-ter: qué candados toma un insert con `guard` (ver email-quota-lock.ts).
 * - `recipient-and-tenant` (por defecto): el del destinatario y el de la
 *   clínica; ninguno de los topes se salta con peticiones a la vez.
 * - `recipient`: solo el del destinatario. Para un endpoint PÚBLICO (el
 *   restablecimiento de contraseña): una inundación contra una clínica no
 *   pone en cola conexiones del pool detrás de su candado. DX-149-quater: esa
 *   plantilla ya no gasta ni respeta el tope diario de la clínica
 *   (`TENANT_DAILY_BUDGET`), así que no le hace falta su candado.
 */
export type QuotaLockScope = 'recipient-and-tenant' | 'recipient';

export interface EmailOutboxRepository {
  /**
   * Con `guard` (DX-149-bis), en la misma transacción: toma el candado de los
   * topes de la clínica del contexto y del destinatario, cuenta y, si `guard`
   * no lanza, inserta. Sin `guard`, inserta sin contar ni esperar. `scope`:
   * qué candados (DX-149-ter); sin él, los dos.
   */
  insert(
    row: NewOutboxEmail,
    guard?: OutboxQuotaGuard,
    scope?: QuotaLockScope,
  ): Promise<{ id: string }>;

  /**
   * DX-463: como `insert`, pero dentro de la transacción de quien llama (ya
   * bajo la RLS de la clínica): el email y lo que lo motiva confirman o se
   * deshacen juntos. `guard` como en `insert`: el candado dura hasta el
   * COMMIT de esa transacción. Con `guard`: UN insert así por transacción
   * (dos podrían esperarse en ciclo) y solo en READ COMMITTED (con otra
   * isolation lanza; ver email-quota-lock.ts).
   */
  insertInTx(
    tx: Prisma.TransactionClient,
    row: NewOutboxEmail,
    guard?: OutboxQuotaGuard,
    scope?: QuotaLockScope,
  ): Promise<{ id: string }>;

  /**
   * Encola un email de plataforma SOLO si cabe en el tope de su destinatario
   * (`toHash`), comprobado y escrito en la misma operación de la BD (atómico
   * entre réplicas). `null` si el tope lo frenó.
   */
  insertPlatform(
    row: NewPlatformOutboxEmail,
    quota: PlatformRecipientQuota,
  ): Promise<{ id: string } | null>;

  /** ¿Cabe ahora otro email de plataforma a `toHash`? (sin escribir nada). */
  /**
   * DX-021-bis: correo de seguridad de plataforma (`mfa-notice`,
   * `mfa-enrollment-code`): fuera del tope por destinatario, como mucho uno de
   * esa plantilla y `referenceId` por `minIntervalSeconds`. `null` si ya salió
   * uno en ese plazo.
   */
  insertPlatformSecurity(
    row: NewPlatformOutboxEmail,
    minIntervalSeconds: number,
  ): Promise<{ id: string } | null>;
  platformRecipientAllowed(
    toHash: string,
    quota: PlatformRecipientQuota,
  ): Promise<boolean>;

  /**
   * Reclama hasta `limit` envíos vencidos de cualquier clínica (FOR UPDATE
   * SKIP LOCKED), los pasa a SENDING y les da `leaseSeconds` de arriendo.
   */
  claimDue(limit: number, leaseSeconds: number): Promise<ClaimedOutboxEmail[]>;

  /**
   * Cierra el intento número `attempts` de una fila reclamada. Devuelve si la
   * fila seguía en SENDING en ESE intento (si otra réplica la reclamó tras
   * vencer el arriendo, el cierre tardío no la pisa).
   */
  settle(
    id: string,
    attempts: number,
    outcome: OutboxSettlement,
  ): Promise<boolean>;

  /**
   * Envíos de la clínica de las últimas 24 h (todos los estados), en total o
   * solo al destinatario `toHash`, y los segundos desde el más reciente a ese
   * destinatario. Para los topes anti-abuso. Las 24 h y los segundos se
   * cuentan con el reloj de la BD, el mismo que fija "createdAt" (DX-355).
   */
  recentSends(tenantId: string, toHash: string): Promise<RecentSends>;

  /**
   * ¿Puede el despachador trabajar? Las funciones existen, este rol puede
   * ejecutarlas y su owner ve todas las filas de email_outbox (su rol NOLOGIN
   * con política propia, DX-113; o un owner superusuario o con BYPASSRLS).
   */
  dispatcherAccess(): Promise<{
    executable: boolean;
    ownerSeesAllRows: boolean;
  }>;

  /**
   * DX-476: ¿el email `outboxId` es el enlace público de un paciente que ya
   * está archivado? Se pregunta justo antes de enviar, con la fila de la
   * clínica `tenantId` bajo RLS. Solo mira las plantillas que llevan un enlace
   * a un paciente (oferta de hueco, firma/presupuesto a distancia, copia del
   * PDF firmado); el resto, `false`.
   */
  patientArchivedFor(tenantId: string, outboxId: string): Promise<boolean>;

  /**
   * Cancela (FAILED, sin mensaje) los envíos aún PENDING de esa referencia en
   * la clínica `tenantId`: p. ej. el email con el enlace viejo al reenviar o
   * revocar una invitación. Devuelve cuántos canceló.
   */
  supersedePending(
    tenantId: string,
    referenceId: string,
    template: EmailTemplateName,
  ): Promise<number>;

  /**
   * DX-149-bis: `supersedePending` dentro de la transacción de quien llama (la
   * del reenvío de una invitación), bajo la RLS de su clínica.
   */
  supersedePendingInTx(
    tx: Prisma.TransactionClient,
    referenceId: string,
    template: EmailTemplateName,
  ): Promise<number>;

  /** Marca de la clínica (tabla global `tenants`), o `null` si no existe. */
  findBrand(tenantId: string): Promise<{
    name: string;
    logoUrl: string | null;
    primaryColor: string | null;
  } | null>;
}
