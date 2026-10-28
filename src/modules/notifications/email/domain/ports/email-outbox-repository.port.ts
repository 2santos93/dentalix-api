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

export interface EmailOutboxRepository {
  insert(row: NewOutboxEmail): Promise<{ id: string }>;

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
   * Envíos de la clínica creados desde `since` (todos los estados), en total o
   * solo al destinatario `toHash`, y el más reciente a ese destinatario. Para
   * los topes anti-abuso.
   */
  recentSends(
    tenantId: string,
    toHash: string,
    since: Date,
  ): Promise<{
    tenant: number;
    recipient: number;
    lastToRecipient: Date | null;
  }>;

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
   * Cancela (FAILED, sin mensaje) los envíos aún PENDING de esa referencia en
   * la clínica `tenantId`: p. ej. el email con el enlace viejo al reenviar o
   * revocar una invitación. Devuelve cuántos canceló.
   */
  supersedePending(
    tenantId: string,
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
