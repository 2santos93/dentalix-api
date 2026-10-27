import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  locationTimeZoneRequired,
  requireLocationTimeZone,
} from './location-time-zone';

/** 409 `LOCATION_REQUIRED`: la clínica no tiene ninguna sede activa (R6). */
export function locationRequired(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'LOCATION_REQUIRED',
    message:
      'La clínica no tiene ninguna sede activa. Crea una en Ajustes → Sedes.',
  });
}

/**
 * Sede de referencia y sus datos regionales. `currency` y `locale` pueden ser
 * null en fase 1 (fila de una réplica antigua aún sin barrer): quien los
 * necesite responde su propio 409 (`LOCATION_CURRENCY_REQUIRED`), nunca otro
 * valor.
 */
export interface ReferenceLocation {
  id: string;
  timeZone: string;
  currency: string | null;
  locale: string | null;
}

/**
 * La sede con la que se interpreta una operación (G1, R6): la sede en contexto
 * si hay una; sin ella (vista «Todas las sedes»), la sede principal, que es la
 * activa más antigua. Es una regla de producto, no un supuesto de país.
 *
 * - Clínica sin sedes activas → 409 `LOCATION_REQUIRED`.
 * - Sede sin zona válida, o `locationId` que no es una sede viva del tenant →
 *   409 `LOCATION_TIMEZONE_REQUIRED`.
 *
 * Corre dentro de `runWithTenant`; `tenantId` va explícito además de RLS.
 */
export async function resolveReferenceLocation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationId: string | null,
): Promise<ReferenceLocation> {
  const select = {
    id: true,
    timeZone: true,
    currency: true,
    locale: true,
  } as const;
  const location = locationId
    ? await tx.location.findFirst({
        where: { id: locationId, tenantId, deletedAt: null },
        select,
      })
    : await tx.location.findFirst({
        where: { tenantId, deletedAt: null, isActive: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select,
      });
  if (!location) {
    if (locationId) throw locationTimeZoneRequired(locationId);
    throw locationRequired();
  }
  return {
    id: location.id,
    timeZone: requireLocationTimeZone(location),
    currency: location.currency,
    locale: location.locale,
  };
}
