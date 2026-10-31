import {
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from '../../../../shared/crypto/token.service';
import { isTenantPayload } from '../../../../shared/crypto/token.service';
import type { VerifiedRefreshPayload } from '../../../../shared/crypto/token.service';
import { AUTH_REPOSITORY } from '../../domain/ports/auth-repository.port';
import type { AuthRepository } from '../../domain/ports/auth-repository.port';
import { SessionClaimsService } from '../session-claims.service';
import {
  DEFAULT_REFRESH_REUSE_GRACE_SECONDS,
  REFRESH_REUSE_GRACE_MS,
} from '../../domain/refresh-rotation';

export interface RefreshInput {
  refreshToken: string;
  /**
   * Clínica del host que pide el refresh (`null` = apex, sesión de
   * plataforma). Si se indica, el token tiene que ser de esa misma clínica:
   * una sesión no se renueva desde el host de otra. `undefined` = no se
   * comprueba (clientes antiguos que mandan el refresh en el body sin host
   * de clínica).
   */
  expectedTenantId?: string | null;
}

/**
 * Cambia un refresh token válido por un par nuevo. NO es stateless: antes de
 * emitir revalida la sesión contra la BD y consume el token.
 *
 * 1. Firma y TTL (secreto de refresh), y que la sesión sea de la clínica del
 *    host cuando se indica `expectedTenantId` (DX-062).
 * 2. Estado ACTUAL (SEC-001): el usuario existe; en sesión de clínica, sigue
 *    con membresía activa y el par nuevo lleva su rol VIGENTE (no el del token
 *    anterior); en sesión de plataforma, sigue siendo superadmin.
 * 3. Versión de sesión (SEC-002): el claim `tv` coincide con
 *    `User.tokenVersion`; cambiar la contraseña la incrementa y deja muertos
 *    todos los refresh anteriores.
 * 4. Un solo uso, por familia (claim `sid`, una por inicio de sesión; ver
 *    `domain/refresh-rotation.ts`): el token vigente se rota; el anterior,
 *    dentro de la gracia (JWT_REFRESH_REUSE_GRACE_SECONDS, 30 s), recibe otra
 *    copia del vigente (la respuesta del refresh se perdió: recarga con el
 *    refresh en vuelo); cualquier otro token ya rotado es REUSO → se revoca
 *    la familia entera y 401. Familia cerrada con /auth/logout → 401.
 *    Los refresh anteriores al claim `sid` siguen por la denylist de un solo
 *    uso (SEC-002: el `jti` se inserta de forma atómica; reusarlo → 401) y
 *    el par que reciben ya nace en una familia.
 *
 * El access token NO se revalida: vive hasta su TTL (JWT_ACCESS_TTL, ~15 min)
 * aunque la membresía se desactive. Esa es la ventana máxima de acceso tras
 * una baja o un cambio de rol.
 */
@Injectable()
export class RefreshUseCase {
  private readonly logger = new Logger('Auth');
  private readonly graceMs: number;

  constructor(
    private readonly tokens: TokenService,
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
    private readonly sessions: SessionClaimsService,
    @Optional() @Inject(REFRESH_REUSE_GRACE_MS) graceMs?: number,
  ) {
    this.graceMs = graceMs ?? DEFAULT_REFRESH_REUSE_GRACE_SECONDS * 1000;
  }

  async execute(
    input: RefreshInput,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    let payload: VerifiedRefreshPayload;
    try {
      payload = await this.tokens.verifyRefresh(input.refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (input.expectedTenantId !== undefined) {
      const tokenTenantId = isTenantPayload(payload) ? payload.tenantId : null;
      if (tokenTenantId !== input.expectedTenantId) {
        throw new UnauthorizedException('Invalid refresh token');
      }
    }

    const { claims, tokenVersion } = await this.sessions.current(payload);
    // Tokens anteriores al claim `tv` cuentan como versión 0.
    const tv = payload.tv ?? 0;
    if (tv !== tokenVersion) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Se emite con la `tv` del token validado, no con la leída: si un cambio
    // de contraseña la incrementó entre la lectura y aquí, el par nuevo nace
    // ya caducado para el siguiente refresh en vez de sobrevivir al cambio.
    const issuable = { ...claims, tv };
    if (!payload.sid) return this.rotateLegacy(payload, issuable);

    const sid = payload.sid;
    const next = await this.tokens.issue(issuable, { sid });
    const nextClaims = this.tokens.refreshClaims(next.refreshToken);
    const rotation = await this.repo.rotateRefreshSession({
      sid,
      userId: payload.sub,
      presentedJti: payload.jti,
      presentedExpiresAt: new Date(payload.exp * 1000),
      nextJti: nextClaims.jti,
      nextExpiresAt: nextClaims.expiresAt,
      graceMs: this.graceMs,
    });
    switch (rotation.decision) {
      case 'rotate':
        return next;
      case 'grace':
        // La respuesta anterior se perdió: otra copia del token VIGENTE (mismo
        // jti y exp) con un access token nuevo. No hay segunda cadena.
        this.logger.log({ event: 'auth.refresh_grace', sid });
        return this.tokens.issue(issuable, {
          sid,
          jti: rotation.currentJti,
          expiresAt: rotation.currentExpiresAt,
        });
      case 'reused':
        // Un token ya rotado fuera de la gracia: robo o copia vieja. La
        // familia entera queda revocada (ya lo hizo el repositorio).
        this.logger.warn({
          event: 'auth.refresh_reuse_detected',
          sid,
          userId: payload.sub,
        });
        throw new UnauthorizedException('Invalid refresh token');
      case 'revoked':
        throw new UnauthorizedException('Invalid refresh token');
    }
  }

  /** Refresh anterior al claim `sid`: un solo uso por la denylist. */
  private async rotateLegacy(
    payload: VerifiedRefreshPayload,
    issuable: Parameters<TokenService['issue']>[0],
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const consumed = await this.repo.consumeRefreshToken(
      payload.jti,
      new Date(payload.exp * 1000),
    );
    if (!consumed) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    // El par nuevo ya nace en una familia (`sid` nuevo).
    return this.tokens.issue(issuable);
  }
}
