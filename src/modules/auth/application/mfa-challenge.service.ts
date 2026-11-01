import { hkdfSync, randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  MFA_CHALLENGE_TTL_SECONDS,
  MFA_MESSAGES,
  type MfaChallengePurpose,
} from '../domain/user-mfa';

/** Lo que firma el token intermedio del login (DX-021). */
export interface MfaChallengeClaims {
  sub: string;
  tenantId: string;
  /** `tokenVersion` al pedirlo: si cambia (contraseña, MFA), el token muere. */
  tv: number;
  purpose: MfaChallengePurpose;
  jti: string;
  exp: number;
}

/**
 * DX-021: token del paso intermedio del login (tras una contraseña correcta,
 * antes del segundo factor). NO da acceso a datos:
 *  - se firma con una clave DERIVADA (HKDF) de JWT_ACCESS_SECRET con otra
 *    etiqueta, así que `JwtAuthGuard` (que verifica con JWT_ACCESS_SECRET) y
 *    /auth/refresh lo rechazan;
 *  - lleva `purpose` y no lleva rol;
 *  - vive 5 min (10 el del alta forzada) y es de un solo uso (su `jti` entra
 *    en la denylist al canjearlo).
 */
@Injectable()
export class MfaChallengeService {
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.secret = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(config.getOrThrow<string>('JWT_ACCESS_SECRET'), 'utf8'),
        Buffer.alloc(0),
        'dentalix-login-mfa-challenge',
        32,
      ),
    ).toString('hex');
  }

  async issue(input: {
    userId: string;
    tenantId: string;
    tokenVersion: number;
    purpose: MfaChallengePurpose;
  }): Promise<{ token: string; expiresAt: Date }> {
    const token = await this.jwt.signAsync(
      {
        sub: input.userId,
        tenantId: input.tenantId,
        tv: input.tokenVersion,
        purpose: input.purpose,
      },
      {
        secret: this.secret,
        expiresIn: MFA_CHALLENGE_TTL_SECONDS[input.purpose],
        jwtid: randomUUID(),
      },
    );
    const { exp } = this.jwt.decode<{ exp: number }>(token);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /**
   * Verifica firma, caducidad, propósito y clínica del host. Cualquier fallo
   * es el mismo 401 («vuelve a iniciar sesión»).
   */
  async verify(
    token: string,
    purpose: MfaChallengePurpose,
    hostTenantId: string | undefined,
  ): Promise<MfaChallengeClaims> {
    let claims: MfaChallengeClaims;
    try {
      claims = await this.jwt.verifyAsync<MfaChallengeClaims>(token, {
        secret: this.secret,
      });
    } catch {
      throw expired();
    }
    if (
      claims.purpose !== purpose ||
      !hostTenantId ||
      claims.tenantId !== hostTenantId ||
      typeof claims.jti !== 'string'
    ) {
      throw expired();
    }
    return claims;
  }
}

export function expired(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    error: 'Unauthorized',
    code: 'MFA_CHALLENGE_EXPIRED',
    message: MFA_MESSAGES.challengeExpired,
  });
}
