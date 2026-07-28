import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ClinicRole } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  tenantId: string;
  role: ClinicRole;
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
