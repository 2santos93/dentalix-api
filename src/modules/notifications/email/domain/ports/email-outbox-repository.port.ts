import { EmailTemplateName } from '../email-message';

export const EMAIL_OUTBOX_REPOSITORY = Symbol('EMAIL_OUTBOX_REPOSITORY');

export type EmailDeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';

/** Fila nueva: sin el email ni el token en claro (ver la migración). */
export interface NewOutboxEmail {
  /** `null` = email de plataforma. */
  tenantId: string | null;
  template: EmailTemplateName;
  toHash: string;
  toMasked: string;
  referenceId: string | null;
  /** Mensaje cifrado (AES-256-GCM). */
  payload: Buffer;
}

/** Envío reclamado por el despachador (ya en SENDING, con el intento sumado). */
export interface ClaimedOutboxEmail {
  id: string;
  tenantId: string | null;
  payload: Buffer | null;
  /** Intentos contando el que empieza ahora. */
  attempts: number;
}

export type OutboxSettlement =
  | { status: 'SENT' }
  | { status: 'PENDING'; nextAttemptAt: Date; lastError: string }
  | { status: 'FAILED'; lastError: string };

export interface EmailOutboxRepository {
  insert(row: NewOutboxEmail): Promise<{ id: string }>;

  /**
   * Reclama hasta `limit` envíos vencidos de cualquier clínica (FOR UPDATE
   * SKIP LOCKED), los pasa a SENDING y les da `leaseSeconds` de arriendo.
   */
  claimDue(limit: number, leaseSeconds: number): Promise<ClaimedOutboxEmail[]>;

  /** Cierra un intento reclamado. Devuelve si la fila seguía en SENDING. */
  settle(id: string, outcome: OutboxSettlement): Promise<boolean>;

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
