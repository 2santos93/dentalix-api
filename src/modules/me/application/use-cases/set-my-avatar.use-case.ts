import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { USER_PROFILE_REPOSITORY } from '../../domain/ports/user-profile-repository.port';
import type { FileStoragePort } from '../../../../shared/storage/file-storage.port';
import { FILE_STORAGE } from '../../../../shared/storage/file-storage.port';
import { splitFileUrl } from '../avatar-url.util';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export interface SetMyAvatarInput {
  userId: string;
  buffer: Buffer;
  contentType: string;
}

@Injectable()
export class SetMyAvatarUseCase {
  constructor(
    @Inject(USER_PROFILE_REPOSITORY)
    private readonly repo: UserProfileRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
  ) {}

  async execute(input: SetMyAvatarInput): Promise<{ avatarUrl: string }> {
    const ext = EXT_BY_MIME[input.contentType];
    if (!ext) {
      throw new BadRequestException('Unsupported image type');
    }
    const current = await this.repo.findUserById(input.userId);
    if (current?.avatarUrl) {
      const prev = splitFileUrl(current.avatarUrl);
      // Excepción justificada al borrado blando: borra el FICHERO anterior del
      // bucket al reemplazar el avatar, no una fila. Si la extensión cambia
      // (jpg -> png) el `save` de abajo no lo pisaría y el blob viejo quedaría
      // huérfano ocupando espacio.
      // eslint-disable-next-line no-restricted-syntax
      if (prev) await this.storage.delete(prev.namespace, prev.filename);
    }
    const { url } = await this.storage.save(
      'avatars',
      `${input.userId}.${ext}`,
      input.buffer,
      input.contentType,
    );
    await this.repo.updateAvatarUrl(input.userId, url);
    return { avatarUrl: url };
  }
}
