import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { USER_PROFILE_REPOSITORY } from '../../domain/ports/user-profile-repository.port';
import { PasswordService } from '../../../../shared/crypto/password.service';

export interface ChangeMyPasswordInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
}

@Injectable()
export class ChangeMyPasswordUseCase {
  constructor(
    @Inject(USER_PROFILE_REPOSITORY)
    private readonly repo: UserProfileRepository,
    private readonly password: PasswordService,
  ) {}

  async execute(input: ChangeMyPasswordInput): Promise<void> {
    const hash = await this.repo.getPasswordHash(input.userId);
    // Mensaje genérico: no revelar si el usuario existe. La longitud mínima
    // de newPassword la valida el DTO (@MinLength(8)).
    if (!hash) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await this.password.verify(input.currentPassword, hash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const newHash = await this.password.hash(input.newPassword);
    await this.repo.updatePasswordHash(input.userId, newHash);
  }
}
