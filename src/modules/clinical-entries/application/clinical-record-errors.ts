import { ForbiddenException } from '@nestjs/common';

export const CLINICAL_ENTRY_NOT_FOUND_MESSAGE =
  'Evolución no encontrada en la historia clínica de este paciente';

export const AUTHOR_REQUIRED_MESSAGE =
  'La historia clínica solo la escribe un profesional autenticado: no se registró el autor';

/** Autoría obligatoria (DX-038): sin usuario del JWT no se escribe la HC. */
export function assertAuthor(authorId: string | undefined): string {
  if (!authorId) {
    throw new ForbiddenException(AUTHOR_REQUIRED_MESSAGE);
  }
  return authorId;
}
