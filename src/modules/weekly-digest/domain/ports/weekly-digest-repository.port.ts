import type { ClinicRole } from '@prisma/client';
import type { HourCycle } from '../../../../shared/format/regional-format';
import type {
  AuditRequestContext,
  AuditRequestMeta,
} from '../../../audit/domain/audit-request-context';
import type { PreparedEmail } from '../../../notifications/email/application/email-outbox.service';
import type { ReceivablesSnapshot } from '../weekly-digest';

export const WEEKLY_DIGEST_REPOSITORY = Symbol('WEEKLY_DIGEST_REPOSITORY');
export const WEEKLY_DIGEST_CLOCK = Symbol('WEEKLY_DIGEST_CLOCK');
export type WeeklyDigestClock = () => Date;

/** Lo que el ADMIN elige en Ajustes › Resumen semanal. */
export interface WeeklyDigestSettings {
  enabled: boolean;
  weekday: number;
  hour: number;
  recipientMembershipIds: string[];
}

/** Un ADMIN activo de la clínica (candidato a destinatario). */
export interface DigestAdmin {
  membershipId: string;
  userId: string;
  fullName: string;
  email: string;
  verified: boolean;
}

/** La clínica y su sede principal (zona y formato del resumen). */
export interface DigestClinic {
  name: string;
  enabled: boolean;
  weekday: number;
  hour: number;
  principal: {
    id: string;
    timeZone: string;
    locale: string | null;
    hourCycle: HourCycle | null;
  };
}

export interface DigestLocation {
  id: string;
  name: string;
  timeZone: string;
}

/** Turno de caja abierto (solo sede y apertura; nada de importes). */
export interface OpenCashSession {
  locationId: string;
  openedAt: Date;
}

/** Una entrega preparada fuera de la transacción (id, token y email). */
export interface PreparedDelivery {
  id: string;
  membershipId: string;
  tokenHash: string;
  expiresAt: Date;
  email: PreparedEmail;
}

export type SendRunOutcome =
  | {
      kind: 'SENT';
      runId: string;
      sent: number;
      skipped: number;
      /** Las entregas que de verdad se guardaron (y encolaron su email). */
      deliveryIds: string[];
    }
  | { kind: 'SKIPPED'; runId: string; skipped: number }
  /** Ya lo envió otro trabajo (o un intento anterior): no se envía nada. */
  | { kind: 'ALREADY_DONE' };

/** Lo que guarda el envío semanal (en UNA transacción). */
export interface SendRunInput {
  weekStart: string;
  snapshot: ReceivablesSnapshot;
  deliveries: PreparedDelivery[];
  /** Filas de destinatarios guardadas (para contar las omitidas). */
  configuredRecipients: number;
}

/** La entrega de un enlace de baja vigente. */
export interface DigestUnsubscribeLink {
  deliveryId: string;
  membershipId: string;
  userId: string;
  role: ClinicRole;
  /** ¿Sigue entre los destinatarios? */
  subscribed: boolean;
}

export interface WeeklyDigestRepository {
  // --- Ajustes (clínica del contexto) ---
  getSettings(): Promise<WeeklyDigestSettings>;
  /** ADMIN activos (membresía y usuario vivos), por nombre. */
  activeAdmins(): Promise<DigestAdmin[]>;
  /**
   * Guarda los ajustes y los destinatarios en UNA transacción con la fila de
   * la clínica bloqueada, comprueba ahí que cada membresía sea ADMIN activa
   * (devuelve las que no) y escribe el evento de auditoría si algo cambió.
   */
  setSettings(
    next: WeeklyDigestSettings,
    ctx: AuditRequestContext,
  ): Promise<
    | { ok: true; before: WeeklyDigestSettings; after: WeeklyDigestSettings }
    | { ok: false; invalidMembershipIds: string[] }
  >;

  // --- Barrido (sin clínica en el contexto) ---
  /** Clínicas vivas con el resumen activado. */
  enabledTenantIds(): Promise<string[]>;
  /** ¿Ya hay envío de esa semana (cualquier estado)? */
  runExists(tenantId: string, weekStart: string): Promise<boolean>;

  // --- Envío (clínica del contexto) ---
  /** null si la clínica no existe o no tiene sede principal con zona. */
  clinic(): Promise<DigestClinic | null>;
  /** Sedes activas (la principal primero, como Reportes). */
  activeLocations(): Promise<DigestLocation[]>;
  openCashSessions(): Promise<OpenCashSession[]>;
  /** La foto del saldo vencido del envío de esa semana (si lo hubo). */
  snapshotOf(weekStart: string): Promise<ReceivablesSnapshot | null>;
  /** El envío de la semana ya terminó (SENT o SKIPPED). */
  runDone(weekStart: string): Promise<boolean>;
  /** Destinatarios guardados que pueden recibirlo ahora (ADMIN, vivo, verificado). */
  eligibleRecipients(): Promise<{
    eligible: DigestAdmin[];
    configured: number;
  }>;
  /**
   * En UNA transacción: crea el envío (ON CONFLICT DO NOTHING) y lo bloquea;
   * si ya no está en SENDING, termina sin enviar. Si no, vuelve a comprobar
   * cada destinatario bajo la transacción, inserta su entrega y encola su
   * email (mismo commit) y cierra el envío.
   */
  sendRun(input: SendRunInput): Promise<SendRunOutcome>;

  // --- Prueba (clínica del contexto) ---
  /** Segundos que faltan para otra prueba de esta persona (0 = puede). */
  testCooldownRemaining(
    userId: string,
    cooldownSeconds: number,
    now: Date,
  ): Promise<number>;
  /**
   * Encola el email de prueba y su evento de auditoría en UNA transacción,
   * con la persona serializada (candado) y solo si no pidió otra en los
   * últimos `cooldownSeconds`. Si sí, los segundos que faltan.
   */
  recordTestSend(
    email: PreparedEmail,
    ctx: AuditRequestContext,
    cooldownSeconds: number,
    now: Date,
  ): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }>;

  // --- Baja pública (clínica del host) ---
  clinicName(): Promise<string | null>;
  findUnsubscribeLink(
    tokenHash: string,
    at: Date,
  ): Promise<DigestUnsubscribeLink | null>;
  /**
   * Quita a la membresía de los destinatarios, marca el enlace usado y audita
   * (solo si de verdad estaba). `null` si el enlace ya no vale.
   */
  unsubscribe(
    deliveryId: string,
    at: Date,
    meta: AuditRequestMeta,
  ): Promise<{ removed: boolean } | null>;
}
