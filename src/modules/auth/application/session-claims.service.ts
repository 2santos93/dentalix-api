import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import {
  JwtPayload,
  isTenantPayload,
} from '../../../shared/crypto/token.service';
import { AUTH_REPOSITORY } from '../domain/ports/auth-repository.port';
import type {
  AuthRepository,
  SessionState,
} from '../domain/ports/auth-repository.port';

export interface CurrentSession {
  /** Claims con los que se puede volver a emitir HOY esta sesión. */
  claims: JwtPayload;
  /** `User.tokenVersion` actual. */
  tokenVersion: number;
}

/**
 * Recalcula los claims de una sesión a partir del estado ACTUAL de la BD, en
 * vez de copiarlos del token anterior (SEC-001). La usan /auth/refresh y el
 * cambio de contraseña, que son los dos sitios que vuelven a emitir un par
 * para una sesión ya abierta.
 *
 * Se renueva el MISMO tipo de sesión: una de plataforma sigue sin tenant ni
 * rol, una de clínica conserva su tenant. Así renovar nunca convierte un token
 * de plataforma en uno de clínica (ni al revés), que sería una escalada
 * silenciosa. Lo que sí cambia es el ROL y las SEDES permitidas (`loc`,
 * DX-089): salen de la membresía vigente.
 *
 * 401 ("Session is no longer valid", sin más detalle) si el usuario ya no existe, si
 * ya no es superadmin (sesión de plataforma), si ya no tiene membresía activa
 * en la clínica (sesión de clínica) o si la sesión es break-glass (SEC-008).
 */
@Injectable()
export class SessionClaimsService {
  constructor(@Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository) {}

  async current(session: JwtPayload): Promise<CurrentSession> {
    const tenantId = isTenantPayload(session) ? session.tenantId : null;
    // SEC-008: una sesión break-glass no se re-emite nunca (ni por refresh ni
    // por cambio de contraseña).
    if (isTenantPayload(session) && session.breakGlass) throw invalid();
    const state = await this.repo.findSessionState(session.sub, tenantId);
    if (!state) throw invalid();

    if (tenantId === null) {
      if (!state.isPlatformAdmin) throw invalid();
      return {
        claims: { sub: session.sub, platform: true },
        tokenVersion: state.tokenVersion,
      };
    }
    const role = roleIn(state);
    return {
      claims: {
        sub: session.sub,
        tenantId,
        role,
        ...locationClaim(role, state.tenant!.allowedLocationIds),
      },
      tokenVersion: state.tokenVersion,
    };
  }
}

/**
 * DX-089: claim `loc` de una sesión de clínica. Solo lo lleva un miembro
 * restringido (con filas en `membership_locations`); un ADMIN nunca, aunque
 * tuviera filas, porque administra todas las sedes. Sin claim = todas.
 */
export function locationClaim(
  role: ClinicRole,
  allowedLocationIds: string[] | null,
): { loc?: string[] } {
  if (role === ClinicRole.ADMIN || allowedLocationIds === null) return {};
  return { loc: allowedLocationIds };
}

function roleIn(state: SessionState): ClinicRole {
  if (!state.tenant) throw invalid();
  if (state.tenant.membershipRole) return state.tenant.membershipRole;
  // Sin membresía no se renueva NADA, tampoco al superadmin (SEC-008): su
  // acceso a una clínica ajena es break-glass, con MFA y motivo en cada
  // entrada y un token corto sin refresh. Esto además mata los refresh de
  // 30 días emitidos antes de SEC-008 a superadmins sin membresía.
  throw invalid();
}

function invalid(): UnauthorizedException {
  return new UnauthorizedException('Session is no longer valid');
}
