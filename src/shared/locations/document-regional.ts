import { locationRegionalOrNull } from './location-regional';
import type { DocumentRegionalDto } from './document-regional.dto';

/**
 * DX-354: la región de la sede de un documento que se lee (impresos y PDF),
 * para el campo `regional` del DTO. `null` si a la sede le falta la zona, el
 * formato o el reloj, o no son válidos: el documento se sirve igual (200) y la
 * web pinta «—» y el aviso de la sede. El 409 `LOCATION_LOCALE_REQUIRED` queda
 * para quien escribe o envía. Nunca lanza.
 */
export function documentRegional(
  location: {
    timeZone?: string | null;
    locale?: string | null;
    hourCycle?: string | null;
  } | null,
): DocumentRegionalDto | null {
  return locationRegionalOrNull(location);
}
