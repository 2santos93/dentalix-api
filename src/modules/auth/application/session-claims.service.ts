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
 * silenciosa. Lo que sí cambia es el ROL: sale de la membresía vigente.
 *
 * 401 ("Session is no longer valid", sin más detalle) si el usuario ya no existe, si
 * ya no es superadmin (sesión de plataforma) o si ya no tiene membresía activa
 * en la clínica (sesión de clínica).
 */
@Injectable()
export class SessionClaimsService {
  constructor(@Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository) {}

  async current(session: JwtPayload): Promise<CurrentSession> {
    const tenantId = isTenantPayload(session) ? session.tenantId : null;
    const state = await this.repo.findSessionState(session.sub, tenantId);
    if (!state) throw invalid();

    if (tenantId === null) {
      if (!state.isPlatformAdmin) throw invalid();
      return {
        claims: { sub: session.sub, platform: true },
        tokenVersion: state.tokenVersion,
      };
    }
    return {
      claims: { sub: session.sub, tenantId, role: roleIn(state) },
      tokenVersion: state.tokenVersion,
    };
  }
}

function roleIn(state: SessionState): ClinicRole {
  if (!state.tenant) throw invalid();
  if (state.tenant.membershipRole) return state.tenant.membershipRole;
  // Sin membresía: solo el superadmin, que entra a cualquier clínica como
  // ADMIN — mismo criterio que LoginUseCase.loginAsPlatformAdminInTenant.
  if (state.isPlatformAdmin) return ClinicRole.ADMIN;
  throw invalid();
}

function invalid(): UnauthorizedException {
  return new UnauthorizedException('Session is no longer valid');
}
