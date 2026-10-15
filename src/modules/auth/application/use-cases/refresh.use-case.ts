import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenService } from '../../../../shared/crypto/token.service';
import type { VerifiedRefreshPayload } from '../../../../shared/crypto/token.service';
import { AUTH_REPOSITORY } from '../../domain/ports/auth-repository.port';
import type { AuthRepository } from '../../domain/ports/auth-repository.port';
import { SessionClaimsService } from '../session-claims.service';

export interface RefreshInput {
  refreshToken: string;
}

/**
 * Cambia un refresh token válido por un par nuevo. NO es stateless: antes de
 * emitir revalida la sesión contra la BD y consume el token.
 *
 * 1. Firma y TTL (secreto de refresh).
 * 2. Estado ACTUAL (SEC-001): el usuario existe; en sesión de clínica, sigue
 *    con membresía activa y el par nuevo lleva su rol VIGENTE (no el del token
 *    anterior); en sesión de plataforma, sigue siendo superadmin.
 * 3. Versión de sesión (SEC-002): el claim `tv` coincide con
 *    `User.tokenVersion`; cambiar la contraseña la incrementa y deja muertos
 *    todos los refresh anteriores.
 * 4. Un solo uso (SEC-002): el `jti` se inserta en la denylist de forma
 *    atómica; solo la petición que lo inserta obtiene par nuevo. Reusar un
 *    refresh ya rotado (o ya cerrado con /auth/logout) → 401.
 *
 * El access token NO se revalida: vive hasta su TTL (JWT_ACCESS_TTL, ~15 min)
 * aunque la membresía se desactive. Esa es la ventana máxima de acceso tras
 * una baja o un cambio de rol.
 */
@Injectable()
export class RefreshUseCase {
  constructor(
    private readonly tokens: TokenService,
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
    private readonly sessions: SessionClaimsService,
  ) {}

  async execute(
    input: RefreshInput,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    let payload: VerifiedRefreshPayload;
    try {
      payload = await this.tokens.verifyRefresh(input.refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const { claims, tokenVersion } = await this.sessions.current(payload);
    // Tokens anteriores al claim `tv` cuentan como versión 0.
    const tv = payload.tv ?? 0;
    if (tv !== tokenVersion) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const consumed = await this.repo.consumeRefreshToken(
      payload.jti,
      new Date(payload.exp * 1000),
    );
    if (!consumed) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    // Se emite con la `tv` del token validado, no con la leída: si un cambio
    // de contraseña la incrementó entre la lectura y aquí, el par nuevo nace
    // ya caducado para el siguiente refresh en vez de sobrevivir al cambio.
    return this.tokens.issue({ ...claims, tv });
  }
}
