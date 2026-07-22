import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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

  async issue(payload: JwtPayload): Promise<{ accessToken: string; refreshToken: string }> {
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.getOrThrow<string>('JWT_ACCESS_TTL'),
    });
    const refreshToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.config.getOrThrow<string>('JWT_REFRESH_TTL'),
    });
    return { accessToken, refreshToken };
  }

  verifyAccess(token: string): Promise<JwtPayload> {
    return this.jwt.verifyAsync<JwtPayload>(token, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }
}
