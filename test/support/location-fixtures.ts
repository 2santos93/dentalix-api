import type { PrismaClient } from '@prisma/client';

/**
 * G1 (DX-313): moneda, zona y formato de una sede de test. Son DATOS DE TEST,
 * no defaults del producto: ningún helper de este fichero acepta que se omita
 * el fixture, y cada llamada nombra el suyo.
 */
export interface RegionalFixture {
  country: 'CO' | 'ES';
  currency: string;
  timeZone: string;
  locale: string;
}

/** Conserva las expectativas de los tests anteriores a G1 (COP, Bogotá). */
export const REGIONAL_BOGOTA_FIXTURE: RegionalFixture = {
  country: 'CO',
  currency: 'COP',
  timeZone: 'America/Bogota',
  locale: 'es-CO',
};

/** Sede fuera de CO/ES; el país sigue siendo el enum actual hasta G1.1. */
export const REGIONAL_TOKYO_FIXTURE: RegionalFixture = {
  country: 'CO',
  currency: 'JPY',
  timeZone: 'Asia/Tokyo',
  locale: 'ja-JP',
};

/** `data` de `prisma.location.create`: los cuatro valores más lo que pase el test. */
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

/** Cuerpo de `POST /auth/register`: los datos de la clínica más los cuatro `location*`. */
export function registerBody<T extends object>(
  regional: RegionalFixture,
  overrides?: T,
): {
  locationCountry: string;
  locationCurrency: string;
  locationTimeZone: string;
  locationLocale: string;
} & T {
  return {
    locationCountry: regional.country,
    locationCurrency: regional.currency,
    locationTimeZone: regional.timeZone,
    locationLocale: regional.locale,
    ...overrides,
  } as ReturnType<typeof registerBody<T>>;
}

/** Fragmento para un INSERT crudo: `INSERT INTO locations (…, ${columns}) VALUES (…, ${values})`. */
export function regionalSql(regional: RegionalFixture): {
  columns: string;
  values: string;
} {
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  return {
    columns: '"country", "currency", "timeZone", "locale"',
    values: [
      quote(regional.country),
      quote(regional.currency),
      quote(regional.timeZone),
      quote(regional.locale),
    ].join(', '),
  };
}

/**
 * INSERT crudo sin columnas regionales: lo que hace una réplica anterior a G1
 * (`updatedAt` no tiene default en la BD; Prisma lo envía). Deja los campos
 * regionales en NULL y `country` en el default de la BD. Devuelve el id.
 */
export async function legacyLocationInsert(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  tenantId: string,
  name: string,
): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "locations" ("id", "tenantId", "name", "updatedAt")
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${name}, now())
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
