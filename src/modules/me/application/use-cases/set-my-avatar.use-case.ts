import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { USER_PROFILE_REPOSITORY } from '../../domain/ports/user-profile-repository.port';
import type { FileStoragePort } from '../../../../shared/storage/file-storage.port';
import { FILE_STORAGE } from '../../../../shared/storage/file-storage.port';
import { IMMUTABLE_CACHE_CONTROL } from '../../../../shared/storage/public-file-cache';
import {
  hashLocalFile,
  readLocalRange,
} from '../../../../shared/storage/local-file';
import { avatarKeyOf } from '../avatar-url.util';
import { sniffAvatarImage } from '../avatar-image';
import {
  UPLOAD_STORAGE_BUDGET_MS,
  withStorageBudget,
} from '../../../../shared/storage/storage-budget';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Bytes del principio que bastan para reconocer PNG, JPEG y WebP. */
const SNIFF_BYTES = 16;

export interface SetMyAvatarInput {
  userId: string;
  /** Temporal en disco que dejó multer (DX-259: nada en memoria). */
  filePath: string;
  contentType: string;
}

@Injectable()
export class SetMyAvatarUseCase {
  constructor(
    @Inject(USER_PROFILE_REPOSITORY)
    private readonly repo: UserProfileRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
  ) {}

  /** Revisión M-1: guardar y borrar el anterior caben en el proxy de la web. */
  execute(input: SetMyAvatarInput): Promise<{ avatarUrl: string }> {
    return withStorageBudget(UPLOAD_STORAGE_BUDGET_MS, () => this.set(input));
  }

  private async set(input: SetMyAvatarInput): Promise<{ avatarUrl: string }> {
    const ext = EXT_BY_MIME[input.contentType];
    if (!ext) {
      throw new BadRequestException('Unsupported image type');
    }
    // DX-084: el contenido debe ser de verdad el tipo declarado (la etiqueta
    // del multipart la pone el cliente y fija la extensión con la que se sirve).
    const head = await readLocalRange(input.filePath, 0, SNIFF_BYTES);
    if (sniffAvatarImage(head) !== input.contentType) {
      throw new BadRequestException(
        'File content does not match the image type',
      );
    }
    // DX-084: clave sin PII (el id del usuario) y es lo que va a la BD.
    // DX-259 (OPS-039): con la versión del contenido (16 hex de su SHA-256),
    // así la URL de un avatar no cambia nunca de contenido y el navegador lo
    // guarda en caché sin volver a pedirlo; cambiar de avatar cambia la URL.
    const { sha256 } = await hashLocalFile(input.filePath);
    const key = `avatars/${input.userId}-${sha256.toString('hex').slice(0, 16)}.${ext}`;
    const current = await this.repo.findUserById(input.userId);
    const previous = avatarKeyOf(current?.avatarKey ?? null);

    // Primero el nuevo y la columna; si algo falla, el avatar anterior sigue
    // intacto y referenciado.
    await this.storage.saveFile(key, input.filePath, input.contentType, {
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    });
    await this.repo.updateAvatarKey(input.userId, key);

    if (previous && previous !== key) {
      // Excepción justificada al borrado blando: borra el FICHERO anterior del
      // bucket al reemplazar el avatar, no una fila. Cada versión tiene su
      // clave, así que el blob viejo quedaría huérfano ocupando espacio (el
      // versionado del bucket guarda la copia).
      // eslint-disable-next-line no-restricted-syntax
      await this.storage.delete(previous);
    }
    return { avatarUrl: this.storage.publicUrl(key) };
  }
}
