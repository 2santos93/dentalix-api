import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  jwtScopeFrom,
  jwtSignOptions,
  verifyJwt,
  type JwtScope,
} from '../../../shared/crypto/jwt-policy';
import {
  MFA_CHALLENGE_TTL_SECONDS,
  MFA_MESSAGES,
  type MfaChallengePurpose,
} from '../domain/user-mfa';

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
  /** DX-045: misma política que las sesiones (HS256, `iss`/`aud`). */
  private readonly scope: JwtScope;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.scope = jwtScopeFrom(config);
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
  }): Promise<{ token: string; expiresAt: Date; jti: string }> {
    const jti = randomUUID();
    const token = await this.jwt.signAsync(
      {
        sub: input.userId,
        tenantId: input.tenantId,
        tv: input.tokenVersion,
        purpose: input.purpose,
      },
      {
        ...jwtSignOptions(this.scope),
        secret: this.secret,
        expiresIn: MFA_CHALLENGE_TTL_SECONDS[input.purpose],
        jwtid: jti,
      },
    );
    const { exp } = this.jwt.decode<{ exp: number }>(token);
    return { token, expiresAt: new Date(exp * 1000), jti };
  }

  /**
   * DX-021-bis, SEC-066: código de 8 dígitos que se envía al correo de la cuenta
   * (superadmin o miembro de clínica) para su alta forzada. Sale del `jti` con la clave derivada: es de ESE token, no se
   * guarda en ningún sitio y muere con él. Así quien conoce la contraseña solo
   * puede gastar sus propios intentos, nunca los del titular.
   */
  emailCode(jti: string): string {
    const mac = this.mac(`enrollment-email:${jti}`);
    return String(mac.readUInt32BE(0) % 100_000_000).padStart(8, '0');
  }

  /** Referencia del correo: dice cuál de varios es el de este intento. */
  emailCodeRef(jti: string): string {
    return this.mac(`enrollment-email-ref:${jti}`)
      .subarray(0, 2)
      .toString('hex')
      .toUpperCase();
  }

  matchesEmailCode(jti: string, code: string): boolean {
    const given = Buffer.from(code);
    const expected = Buffer.from(this.emailCode(jti));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private mac(data: string): Buffer {
    return createHmac('sha256', this.secret).update(data).digest();
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
      claims = await verifyJwt<MfaChallengeClaims>(
        this.jwt,
        token,
        this.secret,
        this.scope,
      );
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
