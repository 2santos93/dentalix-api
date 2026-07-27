import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import type { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { USER_PROFILE_REPOSITORY } from '../../domain/ports/user-profile-repository.port';
import type { MyProfile } from '../../domain/entities/my-profile.entity';

export interface GetMyProfileInput {
  userId: string;
  tenantId: string;
  role: ClinicRole;
}

@Injectable()
export class GetMyProfileUseCase {
  constructor(
    @Inject(USER_PROFILE_REPOSITORY) private readonly repo: UserProfileRepository,
  ) {}

  async execute(input: GetMyProfileInput): Promise<MyProfile> {
    const user = await this.repo.findUserById(input.userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const clinicName = (await this.repo.findClinicName(input.tenantId)) ?? '';
    return {
      ...user,
      memberships: [{ tenantId: input.tenantId, clinicName, role: input.role }],
    };
  }
}
