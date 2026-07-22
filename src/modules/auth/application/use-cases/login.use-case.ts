import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AUTH_REPOSITORY } from '../../domain/ports/auth-repository.port';
import type { AuthRepository } from '../../domain/ports/auth-repository.port';
import { PasswordService } from '../../../../shared/crypto/password.service';
import { TokenService } from '../../../../shared/crypto/token.service';

export interface LoginInput {
  tenantId: string;
  email: string;
  password: string;
}

@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async execute(input: LoginInput): Promise<{ accessToken: string; refreshToken: string }> {
    const email = input.email.trim().toLowerCase();
    const membership = await this.repo.findMembership(input.tenantId, email);
    if (!membership) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await this.password.verify(input.password, membership.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.tokens.issue({
      sub: membership.userId,
      tenantId: input.tenantId,
      role: membership.role,
    });
  }
}
