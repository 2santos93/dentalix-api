import type { PrismaClient } from '@prisma/client';

/**
 * G1 (DX-313): moneda, zona y formato de una sede de test; G1-B (DX-350): y su
 * reloj. Son DATOS DE TEST, no defaults del producto: ningún helper de este
 * fichero acepta que se omita el fixture, y cada llamada nombra el suyo.
 */
export interface RegionalFixture {
  country: string;
  currency: string;
  timeZone: string;
  locale: string;
  hourCycle: 'h12' | 'h23';
  /**
   * DX-329: prefijo telefónico por defecto de la sede (región de
   * libphonenumber-js). Es un dato del fixture, no algo que se deduzca del
   * país: así ninguna sede de test queda sin región (pre-flight I1).
   */
  defaultPhoneRegion: string;
}

/** Conserva las expectativas de los tests anteriores a G1 (COP, Bogotá). */
export const REGIONAL_BOGOTA_FIXTURE: RegionalFixture = {
  country: 'CO',
  currency: 'COP',
  timeZone: 'America/Bogota',
  locale: 'es-CO',
  hourCycle: 'h23',
  defaultPhoneRegion: 'CO',
};

/** Sede de Tokio: su país no tiene indicativo provisional (DX-312). */
export const REGIONAL_TOKYO_FIXTURE: RegionalFixture = {
  country: 'JP',
  currency: 'JPY',
  timeZone: 'Asia/Tokyo',
  locale: 'ja-JP',
  hourCycle: 'h23',
  defaultPhoneRegion: 'JP',
};

/** Sede con reloj de 12 h; un número sin «+» toma +1 (DX-312). */
export const REGIONAL_NEW_YORK_FIXTURE: RegionalFixture = {
  country: 'US',
  currency: 'USD',
  timeZone: 'America/New_York',
  locale: 'en-US',
  hourCycle: 'h12',
  defaultPhoneRegion: 'US',
};

/** Sede con reloj de 24 h; su país no tiene indicativo provisional (DX-312). */
export const REGIONAL_BERLIN_FIXTURE: RegionalFixture = {
  country: 'DE',
  currency: 'EUR',
  timeZone: 'Europe/Berlin',
  locale: 'de-DE',
  hourCycle: 'h23',
  defaultPhoneRegion: 'DE',
};

/** `data` de `prisma.location.create`: los valores del fixture más lo que pase el test. */
export function locationData<T extends object>(
  regional: RegionalFixture,
  overrides?: T,
): RegionalFixture & T {
  return { ...regional, ...overrides } as RegionalFixture & T;
}

/** Cuerpo de `POST /locations`. */
export function locationBody<T extends object>(
  regional: RegionalFixture,
  overrides?: T,
): RegionalFixture & T {
  return { ...regional, ...overrides } as RegionalFixture & T;
}

/** Cuerpo de `POST /auth/register`: los datos de la clínica más los cinco `location*`. */
export function registerBody<T extends object>(
  regional: RegionalFixture,
  overrides?: T,
): {
  locationCountry: string;
  locationCurrency: string;
  locationTimeZone: string;
  locationLocale: string;
  locationHourCycle: string;
} & T {
  return {
    locationCountry: regional.country,
    locationCurrency: regional.currency,
    locationTimeZone: regional.timeZone,
    locationLocale: regional.locale,
    locationHourCycle: regional.hourCycle,
    ...overrides,
  } as ReturnType<typeof registerBody<T>>;
}

/**
 * Excepción G5.3 (DX-334): columna anterior a DX-312: solo admite CO/ES. País
 * de las sedes que los int de migraciones insertan en una etapa ANTERIOR a
 * DX-312 (sin la columna "countryCode"); no decide nada.
 */
export const LEGACY_ENUM_COUNTRY = 'CO';

const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** Fragmento para un INSERT crudo: `INSERT INTO locations (…, ${columns}) VALUES (…, ${values})`. */
export function regionalSql(regional: RegionalFixture): {
  columns: string;
  values: string;
} {
  return {
    columns:
      '"countryCode", "currency", "timeZone", "locale", "hourCycle", "defaultPhoneRegion"',
    values: [
      quote(regional.country),
      quote(regional.currency),
      quote(regional.timeZone),
      quote(regional.locale),
      quote(regional.hourCycle),
      quote(regional.defaultPhoneRegion),
    ].join(', '),
  };
}

/**
 * Como `regionalSql`, para una etapa anterior a DX-312: el país va en la
 * columna enum de entonces (`LEGACY_ENUM_COUNTRY`), y sin prefijo telefónico
 * (DX-329 es posterior).
 */
export function legacyEnumRegionalSql(regional: RegionalFixture): {
  columns: string;
  values: string;
} {
  return {
    columns: '"country", "currency", "timeZone", "locale", "hourCycle"',
    values: [
      quote(LEGACY_ENUM_COUNTRY),
      quote(regional.currency),
      quote(regional.timeZone),
      quote(regional.locale),
      quote(regional.hourCycle),
    ].join(', '),
  };
}

/**
 * INSERT crudo de una sede sin datos regionales, como la de una réplica
 * anterior a G1; el país lo da quien llama (`updatedAt` no tiene default en
 * la BD; Prisma lo envía). Escribe "countryCode" (el trigger de DX-312 da la
 * columna antigua) y deja moneda, zona, formato y revisión en NULL. Devuelve
 * el id.
 */
export async function legacyLocationInsert(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  tenantId: string,
  name: string,
  country: string,
): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "locations" ("id", "tenantId", "name", "countryCode", "updatedAt")
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${name}, ${country}, now())
    RETURNING "id"`;
  return rows[0].id;
}

/**
 * INSERT crudo con moneda, zona y formato y SIN reloj: lo que hace una réplica
 * de G1 (anterior a G1-B) al crear una sede. Deja `hourCycle` en NULL y
 * `regionalSettingsReviewedAt` sin poner. Devuelve el id.
 */
export async function g1LocationInsert(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  tenantId: string,
  name: string,
  regional: RegionalFixture,
): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "locations" ("id", "tenantId", "name", "countryCode", "currency",
                             "timeZone", "locale", "updatedAt")
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${name}, ${regional.country},
            ${regional.currency}, ${regional.timeZone}, ${regional.locale}, now())
    RETURNING "id"`;
  return rows[0].id;
}

/**
 * Como `g1LocationInsert`, para una etapa anterior a DX-312: el país va en la
 * columna enum de entonces (`LEGACY_ENUM_COUNTRY`).
 */
export async function legacyEnumG1LocationInsert(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  tenantId: string,
  name: string,
  regional: RegionalFixture,
): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "locations" ("id", "tenantId", "name", "country", "currency",
                             "timeZone", "locale", "updatedAt")
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${name},
            ${LEGACY_ENUM_COUNTRY}::"ClinicCountry", ${regional.currency},
            ${regional.timeZone}, ${regional.locale}, now())
    RETURNING "id"`;
  return rows[0].id;
}

/**
 * Cambia la zona de una sede dejando `location_schedules.timezone` igual
 * (doble escritura de fase 1, R20).
 */
export async function setLocationZone(
  prisma: Pick<PrismaClient, '$executeRaw'>,
  tenantId: string,
  locationId: string,
  zone: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "locations" SET "timeZone" = ${zone}
    WHERE "id" = ${locationId}::uuid AND "tenantId" = ${tenantId}::uuid`;
  await prisma.$executeRaw`
    UPDATE "location_schedules" SET "timezone" = ${zone}
    WHERE "locationId" = ${locationId}::uuid AND "tenantId" = ${tenantId}::uuid`;
}
