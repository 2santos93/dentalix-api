import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { AUTH_REPOSITORY } from '../../domain/ports/auth-repository.port';
import type { AuthRepository } from '../../domain/ports/auth-repository.port';
import { PasswordService } from '../../../../shared/crypto/password.service';

export interface RegisterClinicInput {
  clinicName: string;
  subdomain: string;
  email: string;
  password: string;
  fullName: string;
}

@Injectable()
export class RegisterClinicUseCase {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
    private readonly password: PasswordService,
  ) {}

  async execute(
    input: RegisterClinicInput,
  ): Promise<{ tenantId: string; userId: string }> {
    const email = input.email.trim().toLowerCase();
    const subdomain = input.subdomain.trim().toLowerCase();

    if (await this.repo.findTenantBySubdomain(subdomain)) {
      throw new ConflictException('Subdomain already in use');
    }
    if (await this.repo.findUserByEmail(email)) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await this.password.hash(input.password);
    return this.repo.createClinicWithOwner({
      clinicName: input.clinicName,
      subdomain,
      email,
      passwordHash,
      fullName: input.fullName,
    });
  }
}
