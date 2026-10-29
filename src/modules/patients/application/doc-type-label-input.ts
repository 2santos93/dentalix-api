import { BadRequestException } from '@nestjs/common';
import {
  DocTypeLabelError,
  normalizeDocTypeLabel,
} from '../domain/document-type';

/**
 * DX-327 (R7): la etiqueta libre de un cuerpo, normalizada. Ausente =
 * `undefined` (no se toca); vacía o null = `null`. Si no es válida, 400 con
 * el mensaje del dominio.
 */
export function docTypeLabelInput(
  raw: string | null | undefined,
): string | null | undefined {
  try {
    return normalizeDocTypeLabel(raw);
  } catch (err) {
    if (err instanceof DocTypeLabelError) {
      throw new BadRequestException(err.message);
    }
    throw err;
  }
}
