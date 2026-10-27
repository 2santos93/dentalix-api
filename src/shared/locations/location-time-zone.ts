import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isValidTimeZone } from '../time/civil-day';

/**
 * 409 `LOCATION_TIMEZONE_REQUIRED` de la sede `locationId`: su zona falta (fila
 * de una réplica anterior a G1 aún sin barrer), este runtime no la reconoce, o
 * la sede no existe. Es un error recuperable: el ADMIN configura la zona en
 * Ajustes → Sedes. Nunca se sustituye por otra zona (G1, R5/R19).
 */
export function locationTimeZoneRequired(
  locationId: string,
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'LOCATION_TIMEZONE_REQUIRED',
    message:
      'Configura una zona horaria válida para la sede y vuelve a intentarlo.',
    locationId,
  });
}

/** La zona de la sede si es válida; si no, el 409 de arriba. */
export function requireLocationTimeZone(location: {
  id: string;
  timeZone: string | null;
}): string {
  const zone = location.timeZone;
  if (!zone || !isValidTimeZone(zone)) {
    throw locationTimeZoneRequired(location.id);
  }
  return zone;
}

interface LocationZoneRow {
  id: string;
  timeZone: string | null;
}

/**
 * Zona IANA de cada sede del tenant, en UNA consulta. La única fuente es
 * `Location.timeZone` (G1, R4): ni el horario ni el país. Incluye las sedes
 * retiradas: sus abonos siguen contando en los períodos pasados.
 *
 * Estricto: una sede leída con la zona NULL o inválida lanza
 * `LOCATION_TIMEZONE_REQUIRED` con su id.
 *
 * `tenantId` va explícito además de RLS. Con `locationIds`, solo esas sedes.
 */
export async function loadLocationTimeZones(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationIds?: readonly string[],
): Promise<Map<string, string>> {
  const ids = locationIds ? [...new Set(locationIds)] : undefined;
  if (ids && ids.length === 0) return new Map();
  const onlyIds = ids
    ? Prisma.sql`AND l."id" = ANY(${ids}::uuid[])`
    : Prisma.empty;
  const rows = await tx.$queryRaw<LocationZoneRow[]>`
    SELECT l."id", l."timeZone"
      FROM "locations" l
     WHERE l."tenantId" = ${tenantId}::uuid
       ${onlyIds}`;
  return new Map(rows.map((row) => [row.id, requireLocationTimeZone(row)]));
}

/**
 * Lo mismo que `loadLocationTimeZones` como función de búsqueda. Una sede que
 * no aparezca (no es del tenant o no existe) lanza `LOCATION_TIMEZONE_REQUIRED`:
 * "hoy" nunca se calcula con otra zona.
 *
 * La usan la regla de anulación de abonos (SEC-013), el `canVoid` de la caja y
 * del estado de cuenta (DX-057) y los períodos de caja y dashboard (DX-097):
 * todos tienen que ver el MISMO "hoy".
 */
export async function resolveLocationTimeZones(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationIds: readonly string[],
): Promise<(locationId: string) => string> {
  const zones = await loadLocationTimeZones(tx, tenantId, locationIds);
  return (locationId) => {
    const zone = zones.get(locationId);
    if (zone === undefined) throw locationTimeZoneRequired(locationId);
    return zone;
  };
}
