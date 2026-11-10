import { ConflictException } from '@nestjs/common';

export const NOTE_TEMPLATE_NOT_FOUND_MESSAGE =
  'Plantilla de evolución no encontrada en esta clínica';

export const DUPLICATE_NOTE_TEMPLATE_MESSAGE =
  'Ya existe una plantilla de evolución con ese nombre.';

export const NOTE_TEMPLATE_STALE_MESSAGE = 'La plantilla cambió, recárgala';

export const NOTE_TEMPLATE_STALE_CODE = 'NOTE_TEMPLATE_STALE';

/** 409 de la versión optimista (DX-231): la web ofrece «Recargar» por el `code`. */
export function staleNoteTemplate(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: NOTE_TEMPLATE_STALE_CODE,
    message: NOTE_TEMPLATE_STALE_MESSAGE,
  });
}

export const INACTIVE_NOTE_TEMPLATE_MESSAGE =
  'La plantilla está desactivada: actívala en Ajustes → Plantillas de evolución o elige otra.';

/** DX-455: `code` del 409 de un atajo que choca (duplicado o prefijo). */
export const NOTE_SHORTCUT_CONFLICT_CODE = 'NOTE_SHORTCUT_CONFLICT';

/** 409 de un atajo que choca; el mensaje ya viene en español. */
export function shortcutConflict(message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: NOTE_SHORTCUT_CONFLICT_CODE,
    message,
  });
}
