import { ClinicCountry, Prisma } from '@prisma/client';
import { isValidTimeZone } from '../time/civil-day';
import { DEFAULT_BUSINESS_HOURS_TIMEZONE } from './default-business-hours';

/**
 * Zona con la que se interpreta una sede que no tiene horario propio (o cuyo
 * horario guarda una zona que este runtime no reconoce): la de su país. Es
 * también la zona con la que nace el horario de una sede nueva.
 */
export function timeZoneForCountry(country: ClinicCountry | null): string {
  switch (country) {
    case ClinicCountry.ES:
      return 'Europe/Madrid';
    case ClinicCountry.CO:
      return 'America/Bogota';
    default:
      return DEFAULT_BUSINESS_HOURS_TIMEZONE;
  }
}

interface LocationZoneRow {
  id: string;
  country: ClinicCountry;
  timezone: string | null;
}

function zoneOfRow(row: LocationZoneRow): string {
  return row.timezone && isValidTimeZone(row.timezone)
    ? row.timezone
    : timeZoneForCountry(row.country);
}

/**
 * Zona IANA de cada sede del tenant, en UNA consulta (sede + su horario vivo).
 * La zona sale SIEMPRE de la BD: la del horario (`LocationSchedule.timezone`,
 * validada al guardarse) o, sin horario, la del país de la sede. Incluye las
 * sedes retiradas: sus abonos siguen contando en los períodos pasados.
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
    SELECT l."id", l."country", s."timezone"
      FROM "locations" l
      LEFT JOIN "location_schedules" s
        ON s."tenantId" = l."tenantId"
       AND s."locationId" = l."id"
       AND s."deletedAt" IS NULL
     WHERE l."tenantId" = ${tenantId}::uuid
       ${onlyIds}`;
  return new Map(rows.map((row) => [row.id, zoneOfRow(row)]));
}

/**
 * Lo mismo que `loadLocationTimeZones` como función de búsqueda: una sede que
 * no aparezca (no debería: los abonos tienen FK a su sede) usa la zona por
 * defecto, así "hoy" nunca cae en el UTC del servidor.
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
  return (locationId) =>
    zones.get(locationId) ?? DEFAULT_BUSINESS_HOURS_TIMEZONE;
}
