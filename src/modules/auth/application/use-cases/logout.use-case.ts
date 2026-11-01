import { Inject, Injectable } from '@nestjs/common';
import { TokenService } from '../../../../shared/crypto/token.service';
import { AUTH_REPOSITORY } from '../../domain/ports/auth-repository.port';
import type { AuthRepository } from '../../domain/ports/auth-repository.port';

export interface LogoutInput {
  refreshToken: string;
}

/**
 * Revoca la familia del refresh token entregado (claim `sid`: todo ese inicio
 * de sesión) o, en los refresh anteriores a las familias, su `jti` en la
 * denylist. A partir de aquí /auth/refresh lo rechaza. El access token NO se revoca: muere
 * solo al expirar (JWT_ACCESS_TTL, ~15m). Es idempotente y silencioso: un
 * refresh inválido/expirado no produce error (cerrar sesión no debe fallar).
 */
@Injectable()
export class LogoutUseCase {
  constructor(
    private readonly tokens: TokenService,
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
  ) {}

  async execute(input: LogoutInput): Promise<void> {
    let payload;
    try {
      payload = await this.tokens.verifyRefresh(input.refreshToken);
    } catch {
      return; // token inválido/expirado → nada que revocar
    }
    const expiresAt = new Date(payload.exp * 1000);
    // Con familia (`sid`): se cierra la sesión entera, también la copia que
    // otra pestaña pudiera estar rotando en ese momento. Sin `sid` (refresh
    // anterior a las familias): su jti a la denylist.
    if (payload.sid) {
      await this.repo.revokeRefreshSession(
        payload.sid,
        payload.sub,
        payload.jti,
        expiresAt,
      );
      return;
    }
    await this.repo.revokeToken(payload.jti, expiresAt);
  }
}
