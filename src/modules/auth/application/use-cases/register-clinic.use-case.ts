import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
    try {
      return await this.repo.createClinicWithOwner({
        clinicName: input.clinicName,
        subdomain,
        email,
        passwordHash,
        fullName: input.fullName,
      });
    } catch (error) {
      // Belt-and-suspenders for the check-then-create race: the partial
      // unique indexes (tenants_subdomain_key / users_email_key, soft-delete
      // aware) are the source of truth, but two concurrent registrations for
      // the same subdomain/email can both pass the findFirst dedup check
      // above and only collide at INSERT time. Map that Prisma unique
      // violation to the same 409 the pre-check would have produced, instead
      // of letting it bubble up as an unhandled 500.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Subdomain or email already in use');
      }
      throw error;
    }
  }
}
