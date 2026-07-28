import { Inject, Injectable } from '@nestjs/common';
import { TokenService } from '../../../../shared/crypto/token.service';
import { AUTH_REPOSITORY } from '../../domain/ports/auth-repository.port';
import type { AuthRepository } from '../../domain/ports/auth-repository.port';

export interface LogoutInput {
  refreshToken: string;
}

/**
 * Revoca el refresh token entregado insertando su `jti` en la denylist. A
 * partir de aquí /auth/refresh lo rechaza. El access token NO se revoca: muere
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
    await this.repo.revokeToken(payload.jti, new Date(payload.exp * 1000));
  }
}
