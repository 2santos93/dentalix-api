import { BadRequestException } from '@nestjs/common';
import {
  canonicalLanguageTag,
  LANGUAGE_TAG_MESSAGE,
} from '../../../shared/i18n/patient-language';

/**
 * DX-497: el idioma preferido tal como llega (alta, ficha o importación):
 * ausente = no se toca, null o vacío = «Idioma de la clínica», y si no, la
 * etiqueta canónica («EN» → «en»). 400 si no es una etiqueta BCP 47 válida.
 * Que esté en la lista de la clínica lo comprueba quien escribe, dentro de
 * su transacción.
 */
export function preferredLanguageInput(
  raw: string | null | undefined,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw.trim() === '') return null;
  const tag = canonicalLanguageTag(raw);
  if (!tag) throw new BadRequestException(LANGUAGE_TAG_MESSAGE);
  return tag;
}
