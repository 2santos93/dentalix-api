import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { USER_PROFILE_REPOSITORY } from '../../domain/ports/user-profile-repository.port';
import type { FileStoragePort } from '../../../../shared/storage/file-storage.port';
import { FILE_STORAGE } from '../../../../shared/storage/file-storage.port';
import { avatarKeyOf } from '../avatar-url.util';
import { sniffAvatarImage } from '../avatar-image';

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
    // DX-084: el contenido debe ser de verdad el tipo declarado (la etiqueta
    // del multipart la pone el cliente y fija la extensión con la que se sirve).
    if (sniffAvatarImage(input.buffer) !== input.contentType) {
      throw new BadRequestException(
        'File content does not match the image type',
      );
    }
    // DX-084: clave sin PII (el id del usuario) y es lo que va a la BD.
    const key = `avatars/${input.userId}.${ext}`;
    const current = await this.repo.findUserById(input.userId);
    const previous = avatarKeyOf(current?.avatarKey ?? null);

    // Primero el nuevo y la columna; si algo falla, el avatar anterior sigue
    // intacto y referenciado.
    await this.storage.save(key, input.buffer, input.contentType);
    await this.repo.updateAvatarKey(input.userId, key);

    if (previous && previous !== key) {
      // Excepción justificada al borrado blando: borra el FICHERO anterior del
      // bucket al reemplazar el avatar, no una fila. Si la extensión cambia
      // (jpg -> png) el `save` de arriba no lo pisa y el blob viejo quedaría
      // huérfano ocupando espacio (el versionado del bucket guarda la copia).
      // eslint-disable-next-line no-restricted-syntax
      await this.storage.delete(previous);
    }
    return { avatarUrl: this.storage.publicUrl(key) };
  }
}
