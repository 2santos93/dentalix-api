import { Inject, Injectable } from '@nestjs/common';
import type {
  UserProfileRepository,
} from '../../domain/ports/user-profile-repository.port';
import { USER_PROFILE_REPOSITORY } from '../../domain/ports/user-profile-repository.port';
import type { FileStoragePort } from '../../../../shared/storage/file-storage.port';
import { FILE_STORAGE } from '../../../../shared/storage/file-storage.port';
import { splitFileUrl } from '../avatar-url.util';

export interface RemoveMyAvatarInput {
  userId: string;
}

@Injectable()
export class RemoveMyAvatarUseCase {
  constructor(
    @Inject(USER_PROFILE_REPOSITORY) private readonly repo: UserProfileRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
  ) {}

  async execute(input: RemoveMyAvatarInput): Promise<void> {
    const current = await this.repo.findUserById(input.userId);
    if (current?.avatarUrl) {
      const key = splitFileUrl(current.avatarUrl);
      if (key) await this.storage.delete(key.namespace, key.filename);
    }
    await this.repo.updateAvatarUrl(input.userId, null);
  }
}
