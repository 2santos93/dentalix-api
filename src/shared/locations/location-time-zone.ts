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

/** Zonas de un conjunto de sedes, leídas en UNA consulta (G1, R4). */
export interface LocationZones {
  /** Sedes con zona válida: las únicas con las que se cortan períodos. */
  readonly configured: ReadonlyMap<string, string>;
  /**
   * Sedes leídas sin zona válida: fila de una réplica anterior a G1 aún sin
   * barrer, o zona que este runtime no reconoce.
   */
  readonly unconfigured: readonly string[];
  /** Zona de la sede; 409 `LOCATION_TIMEZONE_REQUIRED` si no tiene una válida o no se leyó. */
  zoneOf(locationId: string): string;
}

/**
 * Zona IANA de cada sede del tenant (o solo de `locationIds`). La única fuente
 * es `Location.timeZone`: ni el horario ni el país. Incluye las sedes
 * retiradas: sus movimientos siguen contando en los períodos pasados.
 *
 * Tolerante al LEER: una sede sin zona válida no falla la carga, queda en
 * `unconfigured` y el 409 salta al USARLA (`zoneOf`, o
 * `loadPeriodLocationZones` en los períodos). Así una sede recién creada por
 * una réplica antigua no tumba las vistas de toda la clínica mientras no tenga
 * movimientos (§2.0). Las sedes que pide el cliente se comprueban con
 * `resolveLocationTimeZones`, que es estricta.
 *
 * `tenantId` va explícito además de RLS.
 */
export async function loadLocationZones(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationIds?: readonly string[],
): Promise<LocationZones> {
  const ids = locationIds ? [...new Set(locationIds)] : undefined;
  const rows =
    ids?.length === 0
      ? []
      : await tx.$queryRaw<{ id: string; timeZone: string | null }[]>`
    SELECT l."id", l."timeZone"
      FROM "locations" l
     WHERE l."tenantId" = ${tenantId}::uuid
       ${ids ? Prisma.sql`AND l."id" = ANY(${ids}::uuid[])` : Prisma.empty}`;
  return locationZonesOf(rows);
}

/** Las zonas de unas filas `{ id, timeZone }` ya leídas. */
export function locationZonesOf(
  rows: readonly { id: string; timeZone: string | null }[],
): LocationZones {
  const configured = new Map<string, string>();
  const unconfigured: string[] = [];
  for (const row of rows) {
    if (row.timeZone && isValidTimeZone(row.timeZone)) {
      configured.set(row.id, row.timeZone);
    } else {
      unconfigured.push(row.id);
    }
  }
  return {
    configured,
    unconfigured,
    zoneOf(locationId) {
      const zone = configured.get(locationId);
      if (zone === undefined) throw locationTimeZoneRequired(locationId);
      return zone;
    },
  };
}

/**
 * Las zonas de unas sedes concretas como función de búsqueda, ESTRICTA: una
 * sede pedida sin zona válida lanza `LOCATION_TIMEZONE_REQUIRED` al cargar, y
 * una que no aparezca (no es del tenant o no existe), al buscarla. "Hoy"
 * nunca se calcula con otra zona.
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
  const zones = await loadLocationZones(tx, tenantId, locationIds);
  const [unconfigured] = zones.unconfigured;
  if (unconfigured !== undefined) throw locationTimeZoneRequired(unconfigured);
  return (locationId) => zones.zoneOf(locationId);
}

/**
 * Las zonas de una vista de PERÍODO (caja, dashboard, informes): las filas se
 * reparten en días con `configured`, así que una sede sin zona no se puede
 * cortar.
 * - Vista de una sola sede: es la vista de esa sede y necesita su zona; sin
 *   ella, 409 `LOCATION_TIMEZONE_REQUIRED`. Una sede que no es del tenant no
 *   se lee: la vista sale vacía, como antes.
 * - Vista de varias sedes (toda la clínica o las permitidas al miembro): una
 *   sede sin zona y sin movimientos se ignora; con movimientos, 409 con su id.
 *   `firstInUse` devuelve la primera de esas sedes con filas en la tabla de la
 *   vista (o null); solo se consulta si hay alguna sede sin zona.
 */
export async function loadPeriodLocationZones(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationIds: readonly string[] | undefined,
  firstInUse: (locationIds: string[]) => Promise<string | null | undefined>,
): Promise<LocationZones> {
  const zones = await loadLocationZones(tx, tenantId, locationIds);
  const [unconfigured] = zones.unconfigured;
  if (unconfigured === undefined) return zones;
  const inUse =
    locationIds?.length === 1
      ? unconfigured
      : await firstInUse([...zones.unconfigured]);
  if (inUse) throw locationTimeZoneRequired(inUse);
  return zones;
}

/** Lo que `firstLocationWithRows` necesita de un modelo de Prisma con sede. */
interface LocationRowsModel {
  findFirst(args: {
    where: { tenantId: string; locationId: { in: string[] } };
    select: { locationId: true };
  }): PromiseLike<{ locationId: string } | null>;
}

/**
 * El `firstInUse` de `loadPeriodLocationZones` para una tabla con
 * `locationId`: la primera de esas sedes con alguna fila (viva o no).
 */
export function firstLocationWithRows(
  model: LocationRowsModel,
  tenantId: string,
): (locationIds: string[]) => Promise<string | undefined> {
  return async (locationIds) =>
    (
      await model.findFirst({
        where: { tenantId, locationId: { in: locationIds } },
        select: { locationId: true },
      })
    )?.locationId;
}
