import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  regionalFormat,
  type HourCycle,
  type RegionalFormat,
} from '../format/regional-format';
import { isValidTimeZone } from '../time/civil-day';
import {
  locationTimeZoneRequired,
  locationZonesOf,
} from './location-time-zone';

/**
 * 409 `LOCATION_LOCALE_REQUIRED` de la sede `locationId` (G1-B, spec §10): le
 * falta el formato regional o el reloj (fila de una réplica anterior a G1-B
 * aún sin barrer), o su locale no está soportado. Recuperable: el ADMIN lo
 * configura en Ajustes → Sedes. Nunca se formatea con otro valor (R11).
 */
export function locationLocaleRequired(locationId: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'LOCATION_LOCALE_REQUIRED',
    message:
      'Configura el formato regional y el reloj de la sede y vuelve a intentarlo.',
    locationId,
  });
}

/** G1-B: reloj de la sede, 12 h o 24 h. Sin valor por defecto. */
export const HOUR_CYCLES: readonly HourCycle[] = ['h12', 'h23'];

/** El valor (p. ej. la columna, texto en fase 1) es uno de los relojes válidos. */
export function isHourCycle(value: unknown): value is HourCycle {
  return HOUR_CYCLES.some((cycle) => cycle === value);
}

/**
 * Lo que `requireLocationFormat` necesita de una sede: su id y el formato y el
 * reloj en crudo (pueden faltar en una fila sin barrer).
 */
export interface LocationFormatSource {
  id: string;
  locale: string | null;
  hourCycle: string | null;
}

/**
 * El formato de la sede; si le falta el locale o el reloj, o no son válidos,
 * el 409 de arriba. PEREZOSO (pre-flight I4): lo llama quien va a formatear,
 * en el momento de formatear; la lógica sigue con los cargadores de zona y una
 * sede sin reloj no bloquea lecturas que no pintan nada.
 */
export function requireLocationFormat(
  location: LocationFormatSource,
): RegionalFormat {
  const { locale, hourCycle } = location;
  if (!locale || !isHourCycle(hourCycle)) {
    throw locationLocaleRequired(location.id);
  }
  try {
    return regionalFormat({ locale, hourCycle });
  } catch (error) {
    // `regionalFormat` lanza RangeError con un locale no soportado.
    if (error instanceof RangeError) throw locationLocaleRequired(location.id);
    throw error;
  }
}

/** Zona y formato de una sede, para quien formatea con ellos. */
export interface LocationRegional {
  timeZone: string;
  fmt: RegionalFormat;
}

/**
 * Zona y formato de unas sedes concretas, leídos en UNA consulta, como
 * función de búsqueda ESTRICTA: al cargar, una sede pedida sin zona válida da
 * `LOCATION_TIMEZONE_REQUIRED` (la zona primero, en todas) y después una sin
 * formato o sin reloj, `LOCATION_LOCALE_REQUIRED`; una sede que no aparezca
 * (no es del tenant o no existe), el de zona al buscarla.
 *
 * Solo para quien va a formatear con todas las sedes pedidas; la lógica usa
 * `resolveLocationTimeZones`. `tenantId` va explícito además de RLS.
 */
export async function resolveLocationRegional(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationIds: readonly string[],
): Promise<(locationId: string) => LocationRegional> {
  const ids = [...new Set(locationIds)];
  const rows =
    ids.length === 0
      ? []
      : await tx.$queryRaw<
          {
            id: string;
            timeZone: string | null;
            locale: string | null;
            hourCycle: string | null;
          }[]
        >`
    SELECT l."id", l."timeZone", l."locale", l."hourCycle"
      FROM "locations" l
     WHERE l."tenantId" = ${tenantId}::uuid
       AND l."id" = ANY(${ids}::uuid[])`;
  const zones = locationZonesOf(rows);
  const [unconfigured] = zones.unconfigured;
  if (unconfigured !== undefined) throw locationTimeZoneRequired(unconfigured);
  const regional = new Map<string, LocationRegional>(
    rows.map((row) => [
      row.id,
      { timeZone: zones.zoneOf(row.id), fmt: requireLocationFormat(row) },
    ]),
  );
  return (locationId) => {
    const found = regional.get(locationId);
    if (found === undefined) throw locationTimeZoneRequired(locationId);
    return found;
  };
}

/**
 * DX-521: los ajustes regionales de una sede tal como se congelan en la foto
 * del recibo y se sirven en su respuesta: zona, locale canónico y reloj.
 */
export interface LocationRegionalSettings {
  timeZone: string;
  locale: string;
  hourCycle: HourCycle;
}

/**
 * DX-521 (PF2): la región de una sede si tiene los TRES ajustes y este
 * runtime los reconoce (zona IANA, locale soportado, reloj válido); `null` en
 * cualquier otro caso. Nunca lanza: quien la usa decide qué hacer sin región
 * (el recibo se lee igual; el email conserva su 409). Devuelve el locale
 * canónico (`fmt.locale`), no el texto crudo de la columna.
 */
export function locationRegionalOrNull(
  row: {
    timeZone?: string | null;
    locale?: string | null;
    hourCycle?: string | null;
  } | null,
): LocationRegionalSettings | null {
  if (!row) return null;
  const { timeZone, locale, hourCycle } = row;
  if (!timeZone || !isValidTimeZone(timeZone)) return null;
  if (!locale || !isHourCycle(hourCycle)) return null;
  try {
    const fmt = regionalFormat({ locale, hourCycle });
    return { timeZone, locale: fmt.locale, hourCycle };
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}
