import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import type { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { USER_PROFILE_REPOSITORY } from '../../domain/ports/user-profile-repository.port';
import type { MyProfile } from '../../domain/entities/my-profile.entity';
import type { FileStoragePort } from '../../../../shared/storage/file-storage.port';
import { FILE_STORAGE } from '../../../../shared/storage/file-storage.port';
import { avatarPublicUrl } from '../avatar-url.util';

export interface GetMyProfileInput {
  userId: string;
  tenantId: string;
  role: ClinicRole;
}

@Injectable()
export class GetMyProfileUseCase {
  constructor(
    @Inject(USER_PROFILE_REPOSITORY)
    private readonly repo: UserProfileRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
  ) {}

  async execute(input: GetMyProfileInput): Promise<MyProfile> {
    const user = await this.repo.findUserById(input.userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const clinicName = (await this.repo.findClinicName(input.tenantId)) ?? '';
    const { avatarKey, ...rest } = user;
    return {
      ...rest,
      // DX-084: la BD guarda la clave; la URL se calcula al responder.
      avatarUrl: avatarPublicUrl(this.storage, avatarKey),
      memberships: [{ tenantId: input.tenantId, clinicName, role: input.role }],
    };
  }
}
