import { ConflictException } from '@nestjs/common';
import { ClinicCountry, Prisma } from '@prisma/client';
import {
  loadLocationZones,
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
 * 409 `LOCATION_CURRENCY_REQUIRED`: la sede no tiene moneda (fila sin barrer,
 * «sede sin configurar»). Nunca se sustituye por otra moneda.
 */
export function locationCurrencyRequired(
  locationId?: string,
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'LOCATION_CURRENCY_REQUIRED',
    message:
      'La sede no tiene moneda configurada. Configúrala en Ajustes → Sedes.',
    ...(locationId ? { locationId } : {}),
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
  country: ClinicCountry;
  timeZone: string;
  currency: string | null;
  locale: string | null;
}

/** La sede principal (R6): la activa más antigua del tenant. */
function principalLocationQuery(tenantId: string) {
  return {
    where: { tenantId, deletedAt: null, isActive: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  } satisfies Prisma.LocationFindFirstArgs;
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
    country: true,
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
        ...principalLocationQuery(tenantId),
        select,
      });
  if (!location) {
    if (locationId) throw locationTimeZoneRequired(locationId);
    throw locationRequired();
  }
  return {
    id: location.id,
    country: location.country,
    timeZone: requireLocationTimeZone(location),
    currency: location.currency,
    locale: location.locale,
  };
}

/**
 * Zona de cada fila de una vista de toda la clínica cuya sede puede faltar
 * (p. ej. una deuda sin sede): la de su sede o, sin sede, la de la principal
 * (R6). Todo en la transacción del llamador y en dos consultas fijas. Los
 * errores saltan al buscar, no al cargar: una sede sin zona solo es 409 si
 * una fila es suya, y la clínica sin sedes activas solo es 409
 * `LOCATION_REQUIRED` si alguna fila no tiene sede.
 */
export async function loadTenantZones(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<(locationId: string | null) => string> {
  const zones = await loadLocationZones(tx, tenantId);
  const principal = await tx.location.findFirst({
    ...principalLocationQuery(tenantId),
    select: { id: true },
  });
  return (locationId) => {
    if (locationId) return zones.zoneOf(locationId);
    if (!principal) throw locationRequired();
    return zones.zoneOf(principal.id);
  };
}
