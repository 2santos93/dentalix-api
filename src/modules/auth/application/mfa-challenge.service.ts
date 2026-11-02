import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  MFA_CHALLENGE_TTL_SECONDS,
  MFA_MESSAGES,
  type MfaChallengePurpose,
} from '../domain/user-mfa';

const EMAIL_CODE_WINDOW_MS = 10 * 60_000;

/** Lo que firma el token intermedio del login (DX-021). */
export interface MfaChallengeClaims {
  sub: string;
  /** `null`: login de plataforma (apex); solo vale en un host sin clínica. */
  tenantId: string | null;
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
    tenantId: string | null;
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
   * DX-021-bis: código de 8 dígitos que se envía al correo de un superadmin
   * para empezar su alta. Sale de la cuenta, su `tokenVersion` y la ventana de
   * 10 min con la clave derivada: no se guarda en ningún sitio, y volver a
   * escribir la contraseña da el mismo código (el tope de correos de plataforma
   * puede no dejar salir otro).
   */
  emailCode(
    userId: string,
    tokenVersion: number,
    now: number = Date.now(),
  ): string {
    const window = Math.floor(now / EMAIL_CODE_WINDOW_MS);
    const mac = createHmac('sha256', this.secret)
      .update(`enrollment-email:${userId}:${tokenVersion}:${window}`)
      .digest();
    return String(mac.readUInt32BE(0) % 100_000_000).padStart(8, '0');
  }

  /** Vale el de esta ventana y el de la anterior: entre 10 y 20 min de vida. */
  matchesEmailCode(
    userId: string,
    tokenVersion: number,
    code: string,
  ): boolean {
    const given = Buffer.from(code);
    const now = Date.now();
    return [now, now - EMAIL_CODE_WINDOW_MS].some((t) => {
      const expected = Buffer.from(this.emailCode(userId, tokenVersion, t));
      return (
        given.length === expected.length && timingSafeEqual(given, expected)
      );
    });
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
      claims.tenantId !== (hostTenantId ?? null) ||
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
