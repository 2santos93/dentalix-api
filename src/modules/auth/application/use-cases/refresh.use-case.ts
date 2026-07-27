import { Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenService } from '../../../../shared/crypto/token.service';

export interface RefreshInput {
  refreshToken: string;
}

/**
 * Exchanges a valid refresh token for a fresh access + refresh pair.
 *
 * This is a STATELESS refresh: the new pair is minted from the verified
 * refresh-token payload without a DB round-trip. There is no server-side
 * refresh-token store, so tokens cannot be individually revoked — a role
 * change or membership removal only takes effect on the next login, up to
 * the refresh TTL (`JWT_REFRESH_TTL`). Rotating the refresh token on every
 * call still shortens the window in which a leaked refresh token is useful.
 */
@Injectable()
export class RefreshUseCase {
  constructor(private readonly tokens: TokenService) {}

  async execute(
    input: RefreshInput,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    let payload;
    try {
      payload = await this.tokens.verifyRefresh(input.refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    return this.tokens.issue({
      sub: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
    });
  }
}
