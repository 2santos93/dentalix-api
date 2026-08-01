import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ClinicRole } from '@prisma/client';

/** Sesión dentro de UNA clínica: la forma de siempre. */
export interface TenantJwtPayload {
  sub: string;
  tenantId: string;
  role: ClinicRole;
}

/**
 * Sesión de PLATAFORMA (superadmin): no pertenece a ningún tenant, así que no
 * lleva `tenantId` ni `role`. Solo sirve para las rutas `/platform/*`; el
 * interceptor de tenant y el RolesGuard lo rechazan explícitamente en
 * cualquier ruta de clínica (ver `isTenantPayload`).
 */
export interface PlatformJwtPayload {
  sub: string;
  platform: true;
}

export type JwtPayload = TenantJwtPayload | PlatformJwtPayload;

/** Narrowing: ¿es un token de plataforma (superadmin, sin tenant)? */
export function isPlatformPayload(
  payload: JwtPayload,
): payload is PlatformJwtPayload {
  return (payload as PlatformJwtPayload).platform === true;
}

/**
 * Narrowing: ¿es un token de clínica (con tenant y rol)? Se usa como guarda
 * en todo consumidor que necesite `tenantId`/`role`, de modo que un token de
 * plataforma NUNCA pueda colarse en una ruta tenant-scoped.
 */
export function isTenantPayload(
  payload: JwtPayload,
): payload is TenantJwtPayload {
  return !isPlatformPayload(payload);
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async issue(
    payload: JwtPayload,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    // expiresIn config values are human-readable ms durations ("900s", "30d").
    // jsonwebtoken accepts them at runtime; cast to satisfy its branded StringValue type.
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.getOrThrow<string>(
        'JWT_ACCESS_TTL',
      ) as JwtSignOptions['expiresIn'],
    });
    const refreshToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.config.getOrThrow<string>(
        'JWT_REFRESH_TTL',
      ) as JwtSignOptions['expiresIn'],
      // jwtid → claim `jti`: identifica ESTE refresh token para poder revocarlo
      // en /auth/logout. El access token no lo lleva (no se revoca).
      jwtid: randomUUID(),
    });
    return { accessToken, refreshToken };
  }

  verifyAccess(token: string): Promise<JwtPayload> {
    return this.jwt.verifyAsync<JwtPayload>(token, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  // Verifies a refresh token against the SEPARATE refresh secret. Because
  // access and refresh tokens are signed with different secrets, this
  // rejects an access token presented at the refresh endpoint (and vice
  // versa for `verifyAccess`).
  verifyRefresh(
    token: string,
  ): Promise<JwtPayload & { jti: string; exp: number }> {
    return this.jwt.verifyAsync<JwtPayload & { jti: string; exp: number }>(
      token,
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      },
    );
  }
}
