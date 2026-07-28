import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenService } from '../../../../shared/crypto/token.service';
import { AUTH_REPOSITORY } from '../../domain/ports/auth-repository.port';
import type { AuthRepository } from '../../domain/ports/auth-repository.port';

export interface RefreshInput {
  refreshToken: string;
}

/**
 * Exchanges a valid refresh token for a fresh access + refresh pair.
 *
 * Mostly stateless: the new pair is minted from the verified refresh-token
 * payload. The ONE server-side check is the revocation denylist — a refresh
 * token whose `jti` was revoked by /auth/logout is rejected with 401. The
 * access token remains unchecked (short TTL). Rotating the refresh token on
 * every call still shortens the window a leaked refresh token is useful.
 */
@Injectable()
export class RefreshUseCase {
  constructor(
    private readonly tokens: TokenService,
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
  ) {}

  async execute(
    input: RefreshInput,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    let payload;
    try {
      payload = await this.tokens.verifyRefresh(input.refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (await this.repo.isTokenRevoked(payload.jti)) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    return this.tokens.issue({
      sub: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
    });
  }
}
