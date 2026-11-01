import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import { ClinicRole } from '@prisma/client';
import type { HourCycle } from '../../../locations/domain/regional-settings';
import type { RefreshRotationDecision } from '../refresh-rotation';

/** G1: país, moneda, zona y formato regional de la primera sede, ya validados. */
export interface ClinicLocationSettings {
  country: string;
  currency: string;
  timeZone: string;
  locale: string;
  /**
   * G1-B fase 1: null = registro de la web de G1 (los cuatro, sin reloj): la
   * sede lo recibe de `dx_g1b_backfill_location_hour_cycle` en la misma
   * transacción del alta.
   */
  hourCycle: HourCycle | null;
}

export interface CreateClinicWithOwnerInput {
  clinicName: string;
  subdomain: string;
  email: string;
  passwordHash: string;
  fullName: string;
  /** Cuándo se probó el control del email (enlace de verificación, DX-029). */
  emailVerifiedAt: Date;
  /**
   * G1: la «Sede principal» nace con estos valores y revisada (R11). Ya no
   * hay forma legada sin sede (DX-312, R7).
   */
  location: ClinicLocationSettings;
  /**
   * DX-359: desde dónde se verificó el registro, para el evento CLINIC_REGISTERED
   * que se escribe en la MISMA transacción del alta (`null` en el seed).
   */
  request: AuditRequestMeta | null;
}

export interface MembershipRecord {
  userId: string;
  passwordHash: string;
  role: ClinicRole;
  tokenVersion: number;
  /**
   * DX-089: sedes ACTIVAS a las que está restringida la membresía. `null` =
   * sin restricción (no tiene filas en `membership_locations`); `[]` = tiene
   * filas pero ninguna de esas sedes sigue activa (nunca equivale a todas).
   */
  allowedLocationIds: string[] | null;
}

/**
 * Usuario para autenticar SIN pasar por una membresía: lo necesita el
 * superadmin de plataforma, que por definición no tiene `ClinicMembership`
 * en las clínicas de los clientes.
 */
export interface AuthUserRecord {
  id: string;
  passwordHash: string;
  isPlatformAdmin: boolean;
  tokenVersion: number;
}

/**
 * Estado ACTUAL de una sesión, leído de la BD en cada /auth/refresh para no
 * fiarse de lo que trae el token anterior (SEC-001).
 */
export interface SessionState {
  tokenVersion: number;
  isPlatformAdmin: boolean;
  /**
   * Solo cuando se pidió un tenant. `null` = la clínica no existe o está
   * borrada. `membershipRole` = rol de la membresía ACTIVA del usuario en esa
   * clínica, o `null` si no la tiene (nunca la tuvo o fue desactivada).
   */
  tenant: {
    membershipRole: ClinicRole | null;
    /** DX-089: igual que `MembershipRecord.allowedLocationIds`. */
    allowedLocationIds: string[] | null;
  } | null;
}

/** Lo que pide /auth/refresh al rotar un token de una familia (`sid`). */
export interface RotateRefreshSessionInput {
  sid: string;
  userId: string;
  /** `jti`/`exp` del token que se presenta. */
  presentedJti: string;
  presentedExpiresAt: Date;
  /** `jti`/`exp` del token nuevo, ya firmado, si se rota. */
  nextJti: string;
  nextExpiresAt: Date;
  graceMs: number;
}

/**
 * Resultado de la rotación. En `grace`, `currentJti`/`currentExpiresAt` son
 * los del token VIGENTE de la familia: el caso de uso reemite ese mismo token.
 */
export type RefreshSessionRotation =
  | { decision: Exclude<RefreshRotationDecision, 'grace'> }
  | { decision: 'grace'; currentJti: string; currentExpiresAt: Date };

export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY');

export interface AuthRepository {
  findUserByEmail(
    email: string,
  ): Promise<{ id: string; fullName: string } | null>;
  /** Usuario + hash + flag de plataforma, sin exigir membresía. */
  findUserForAuth(email: string): Promise<AuthUserRecord | null>;
  /**
   * Clínica que OCUPA `subdomain`, también si está dada de baja (la columna es
   * UNIQUE en toda la tabla). `null` = la dirección está libre.
   */
  findTenantBySubdomain(subdomain: string): Promise<{ id: string } | null>;
  createClinicWithOwner(
    input: CreateClinicWithOwnerInput,
  ): Promise<{ tenantId: string; userId: string }>;
  findMembership(
    tenantId: string,
    email: string,
  ): Promise<MembershipRecord | null>;
  /**
   * Estado actual del usuario `userId` (y de su membresía en `tenantId`, si se
   * pasa). `null` si el usuario no existe o está borrado.
   */
  findSessionState(
    userId: string,
    tenantId: string | null,
  ): Promise<SessionState | null>;
  /** Revoca un jti (logout). Idempotente. */
  revokeToken(jti: string, expiresAt: Date): Promise<void>;
  /**
   * Consume un refresh token de un solo uso: inserta su jti en la denylist y
   * devuelve `true` solo a QUIEN lo insertó. `false` si ya estaba (reuso,
   * refresh concurrente perdido, o sesión cerrada con logout).
   */
  consumeRefreshToken(jti: string, expiresAt: Date): Promise<boolean>;
  /**
   * Rota el token de una familia (ver `domain/refresh-rotation.ts`) de forma
   * atómica: bloquea la fila de la familia (dos refresh a la vez se
   * serializan), decide y, si toca, guarda la rotación o la revocación por
   * reuso. Una familia sin fila (su primer refresh) nace con el token
   * presentado como vigente.
   */
  rotateRefreshSession(
    input: RotateRefreshSessionInput,
  ): Promise<RefreshSessionRotation>;
  /** Revoca una familia entera (logout). Idempotente. */
  revokeRefreshSession(
    sid: string,
    userId: string,
    presentedJti: string,
    expiresAt: Date,
  ): Promise<void>;
}
