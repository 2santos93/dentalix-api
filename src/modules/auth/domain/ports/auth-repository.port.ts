import { ClinicCountry, ClinicRole } from '@prisma/client';
import type { HourCycle } from '../../../locations/domain/regional-settings';

/** G1: país, moneda, zona y formato regional de la primera sede, ya validados. */
export interface ClinicLocationSettings {
  country: ClinicCountry;
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
   * G1: la «Sede principal» nace con estos valores y revisada (R11). `null` =
   * pendiente LEGADO de una réplica o una web anteriores a G1 (fase 1, spec
   * §3.5): la sede se crea como antes (país por defecto de la BD) y la rellena
   * `dx_g1_backfill_location_regional` en la misma transacción, sin revisar.
   */
  location: ClinicLocationSettings | null;
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

export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY');

export interface AuthRepository {
  findUserByEmail(
    email: string,
  ): Promise<{ id: string; fullName: string } | null>;
  /** Usuario + hash + flag de plataforma, sin exigir membresía. */
  findUserForAuth(email: string): Promise<AuthUserRecord | null>;
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
}
