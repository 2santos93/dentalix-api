import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { USER_PROFILE_REPOSITORY } from '../../domain/ports/user-profile-repository.port';

export interface UpdateMyNameInput {
  userId: string;
  fullName: string;
}

@Injectable()
export class UpdateMyNameUseCase {
  constructor(
    @Inject(USER_PROFILE_REPOSITORY) private readonly repo: UserProfileRepository,
  ) {}

  async execute(input: UpdateMyNameInput): Promise<void> {
    const fullName = input.fullName.trim();
    if (!fullName) {
      throw new BadRequestException('Name cannot be empty');
    }
    await this.repo.updateName(input.userId, fullName);
  }
}
