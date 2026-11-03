import type { Prisma } from '@prisma/client';
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

/** Las columnas de la sede que `documentRegional` necesita. */
export const DOCUMENT_REGIONAL_SELECT = {
  timeZone: true,
  locale: true,
  hourCycle: true,
} as const;

/**
 * DX-354: la región de la sede de un documento que no es de una sola sede
 * (estado de cuenta, familiar): la sede en contexto si hay una; sin ella
 * (vista «Todas las sedes»), la principal (R6, la activa más antigua). Dentro
 * de `runWithTenant`. A diferencia de `resolveReferenceLocation`, nunca lanza:
 * una sede que no existe o sin ajustes da `null`, y el documento se lee igual.
 */
export async function loadDocumentRegional(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationId: string | null,
): Promise<DocumentRegionalDto | null> {
  const location = locationId
    ? await tx.location.findFirst({
        where: { id: locationId, tenantId, deletedAt: null },
        select: DOCUMENT_REGIONAL_SELECT,
      })
    : await tx.location.findFirst({
        where: { tenantId, deletedAt: null, isActive: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: DOCUMENT_REGIONAL_SELECT,
      });
  return documentRegional(location);
}
