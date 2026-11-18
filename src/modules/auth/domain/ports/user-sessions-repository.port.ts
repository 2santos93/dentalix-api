import type { ClinicRole } from '@prisma/client';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';

export const USER_SESSIONS_REPOSITORY = Symbol('USER_SESSIONS_REPOSITORY');

/** Una familia de refresh recién emitida (el login o una reemisión). */
export interface OpenSessionInput {
  sid: string;
  userId: string;
  /** `jti`/`exp` del refresh emitido: el token VIGENTE de la familia. */
  jti: string;
  expiresAt: Date;
  /** `tv` del refresh emitido. */
  tokenVersion: number;
  /** Ya resumido (navegador y sistema). */
  deviceLabel: string;
  /** Ya truncada. */
  ipPrefix: string | null;
  /** Clínica del host (`null` = sesión de plataforma: sin fila de clínica). */
  tenantId: string | null;
}

/** Lo que se sabe de una huella al decidir si se avisa del login. */
export interface KnownDeviceState {
  /** Última vez que se vio ESTA huella (`null` = nunca). */
  lastSeenAt: Date | null;
  /** ¿Tiene el usuario alguna OTRA huella registrada? */
  hasOtherKnownDevices: boolean;
}

export interface RememberDeviceInput {
  tenantId: string;
  userId: string;
  sessionId: string;
  fingerprint: string;
  now: Date;
  /**
   * Decide, con el estado leído bajo el candado del usuario, si se crea el
   * aviso. Devuelve el enlace «No fui yo» (hash y caducidad) o `null`.
   */
  decide: (
    state: KnownDeviceState,
  ) => { tokenHash: string; expiresAt: Date } | null;
}

/** Una sesión de la clínica, tal como sale de la BD. */
export interface ClinicSessionRecord {
  id: string;
  userId: string;
  deviceLabel: string | null;
  ipPrefix: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
}

/** Qué familias de `userId` en la clínica se cierran. */
export type SessionSelection =
  | { kind: 'one'; sessionId: string }
  | { kind: 'all-except'; sessionId: string | null };

export interface RevokeClinicSessionsInput {
  tenantId: string;
  userId: string;
  selection: SessionSelection;
  now: Date;
  /** El evento de auditoría, con el número de sesiones cerradas. */
  audit: (sessionsClosed: number) => AuditEventDraft;
}

/** Resultado de canjear un enlace «No fui yo». */
export interface NotMeOutcome {
  userId: string;
  /** Rol vigente en la clínica del enlace (`null` = ya no es miembro). */
  role: ClinicRole | null;
  sessionsClosed: number;
}

export interface ConsumeSessionAlertInput {
  tenantId: string;
  tokenHash: string;
  now: Date;
  audit: (outcome: NotMeOutcome) => AuditEventDraft;
}

export interface UserSessionsRepository {
  /** Registra la familia (y, con clínica, su fila bajo la RLS). */
  openSession(input: OpenSessionInput): Promise<void>;
  /**
   * Bajo un candado por usuario (dos logins a la vez se serializan): lee la
   * huella, decide con `decide`, la marca como vista ahora y, si toca, crea el
   * aviso. `true` = se creó el aviso (este login, y solo este, envía el email).
   */
  rememberDevice(input: RememberDeviceInput): Promise<boolean>;
  /**
   * Familias VIVAS de `userId` en la clínica (bajo su RLS): sin revocar, sin
   * vencer y con la `tokenVersion` actual del usuario.
   */
  listClinicSessions(
    tenantId: string,
    userId: string,
    now: Date,
  ): Promise<ClinicSessionRecord[]>;
  /**
   * Cierra (revoca) las familias elegidas de `userId` en la clínica y audita
   * en la misma transacción si cerró alguna. Devuelve cuántas cerró.
   */
  revokeClinicSessions(input: RevokeClinicSessionsInput): Promise<number>;
  /** Rol de la membresía ACTIVA de `userId` en la clínica, o `null`. */
  activeMemberRole(
    tenantId: string,
    userId: string,
  ): Promise<ClinicRole | null>;
  /**
   * Canjea el enlace «No fui yo» (un solo uso, vivo, de esta clínica) y en la
   * MISMA transacción cierra TODAS las sesiones del usuario (`tokenVersion`
   * +1 y familias revocadas), deja sin valor los enlaces de restablecimiento
   * vivos (pudo pedirlos quien entró) y audita. `null` = el enlace no vale.
   */
  consumeSessionAlert(
    input: ConsumeSessionAlertInput,
  ): Promise<NotMeOutcome | null>;
  /** Cierre por inactividad de la clínica (minutos). */
  clinicIdleMinutes(tenantId: string): Promise<number>;
  /** Lo cambia y audita en la misma transacción. */
  setClinicIdleMinutes(
    tenantId: string,
    minutes: number,
    audit: AuditEventDraft,
  ): Promise<void>;
  /** Email y nombre del usuario (para el aviso). `null` si ya no existe. */
  findRecipient(
    userId: string,
  ): Promise<{ email: string; fullName: string } | null>;
}
