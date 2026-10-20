import { Inject, Injectable } from '@nestjs/common';
import type { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { USER_PROFILE_REPOSITORY } from '../../domain/ports/user-profile-repository.port';
import type { FileStoragePort } from '../../../../shared/storage/file-storage.port';
import { FILE_STORAGE } from '../../../../shared/storage/file-storage.port';
import { avatarKeyOf } from '../avatar-url.util';

export interface RemoveMyAvatarInput {
  userId: string;
}

@Injectable()
export class RemoveMyAvatarUseCase {
  constructor(
    @Inject(USER_PROFILE_REPOSITORY)
    private readonly repo: UserProfileRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
  ) {}

  async execute(input: RemoveMyAvatarInput): Promise<void> {
    const current = await this.repo.findUserById(input.userId);
    const key = avatarKeyOf(current?.avatarKey ?? null);
    if (key) {
      // Excepción justificada al borrado blando: esto borra el FICHERO del
      // bucket, no una fila. La fila de `users` se conserva; sólo se le pone
      // la clave a null (abajo). Retener en blando un blob que ya nadie
      // referencia sería pagar almacenamiento por una imagen que el usuario
      // pidió quitar (el versionado del bucket guarda la copia un tiempo).
      // eslint-disable-next-line no-restricted-syntax
      await this.storage.delete(key);
    }
    await this.repo.updateAvatarKey(input.userId, null);
  }
}
