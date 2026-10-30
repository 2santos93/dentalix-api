import { Prisma, PrismaClient } from '@prisma/client';
import {
  callingCodeOf,
  suggestedPhoneRegion,
  type CountryCode,
} from '../src/shared/phone/phone-number';
import {
  REGIONAL_BERLIN_FIXTURE,
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_NEW_YORK_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  g1LocationInsert,
  legacyLocationInsert,
  locationData,
  regionalSql,
  setLocationZone,
} from './support/location-fixtures';

// G1 (DX-313): los helpers de test escriben lo que dicen. `legacyLocationInsert`
// simula una réplica anterior a G1 (campos regionales NULL) y `setLocationZone`
// mantiene la doble escritura de fase 1 (R20). G1-B (DX-350): el reloj va en
// todos, y `g1LocationInsert` simula una réplica de G1 (sin reloj).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const SUBDOMAIN = 'g1-fixtures-int';
let tenantId: string;

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.locationSchedule.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { subdomain: SUBDOMAIN } });
}

/** Las dos columnas del país (DX-312): la nueva y la antigua, en crudo. */
async function countryColumns(
  id: string,
): Promise<{ countryCode: string; country: string | null }> {
  const [row] = await raw.$queryRaw<
    { countryCode: string; country: string | null }[]
  >`SELECT "countryCode"::text AS "countryCode", "country"::text AS country
      FROM "locations" WHERE "id" = ${id}::uuid`;
  return row;
}

describe('fixtures de sede (G1)', () => {
  beforeAll(async () => {
    await cleanup();
    tenantId = (
      await raw.tenant.create({
        data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
      })
    ).id;
  });
  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
  });

  it('locationData escribe los valores del fixture, reloj incluido', async () => {
    const tokyo = await raw.location.create({
      data: locationData(REGIONAL_TOKYO_FIXTURE, { tenantId, name: 'Tokio' }),
    });
    expect(tokyo).toMatchObject({
      currency: 'JPY',
      timeZone: 'Asia/Tokyo',
      locale: 'ja-JP',
      hourCycle: 'h23',
    });
  });

  // DX-312 (R13): cada sede de test lleva el país de su ciudad.
  it('regional fixtures use their real countries', async () => {
    const cases = [
      [REGIONAL_TOKYO_FIXTURE, 'JP'],
      [REGIONAL_NEW_YORK_FIXTURE, 'US'],
      [REGIONAL_BERLIN_FIXTURE, 'DE'],
    ] as const;
    for (const [fixture, code] of cases) {
      expect(fixture.country).toBe(code);
      const location = await raw.location.create({
        data: locationData(fixture, { tenantId, name: `País ${code}` }),
      });
      expect((await countryColumns(location.id)).countryCode).toBe(code);
    }
  });

  // DX-329: la región por defecto de cada fixture es la que se sugiere desde
  // su país, y da el indicativo de un número sin «+».
  it('regional fixtures change the default calling code as their country says', () => {
    const cases = [
      [REGIONAL_NEW_YORK_FIXTURE, '1'],
      [REGIONAL_TOKYO_FIXTURE, '81'],
      [REGIONAL_BERLIN_FIXTURE, '49'],
      [REGIONAL_BOGOTA_FIXTURE, '57'],
    ] as const;
    for (const [fixture, callingCode] of cases) {
      expect(suggestedPhoneRegion(fixture.country)).toBe(
        fixture.defaultPhoneRegion,
      );
      expect(callingCodeOf(fixture.defaultPhoneRegion as CountryCode)).toBe(
        callingCode,
      );
    }
  });

  it('regionalSql sirve para un INSERT crudo', async () => {
    const { columns, values } = regionalSql(REGIONAL_BOGOTA_FIXTURE);
    await raw.$executeRawUnsafe(
      `INSERT INTO "locations" ("id", "tenantId", "name", ${columns}, "updatedAt")
       VALUES (gen_random_uuid(), '${tenantId}', 'Cruda', ${values}, now())`,
    );
    const row = await raw.location.findFirstOrThrow({
      where: { tenantId, name: 'Cruda' },
    });
    expect(row).toMatchObject({
      currency: 'COP',
      timeZone: 'America/Bogota',
      hourCycle: 'h23',
    });
  });

  // DX-329 (pre-flight I1): ninguna sede de test queda sin prefijo
  // telefónico; la región es un dato del fixture.
  it('locationData and regionalSql write the fixture default phone region', async () => {
    const tokyo = await raw.location.create({
      data: locationData(REGIONAL_TOKYO_FIXTURE, {
        tenantId,
        name: 'Prefijo Prisma',
      }),
    });
    expect(tokyo.defaultPhoneRegion).toBe('JP');
    const { columns, values } = regionalSql(REGIONAL_NEW_YORK_FIXTURE);
    await raw.$executeRawUnsafe(
      `INSERT INTO "locations" ("id", "tenantId", "name", ${columns}, "updatedAt")
       VALUES (gen_random_uuid(), '${tenantId}', 'Prefijo SQL', ${values}, now())`,
    );
    const row = await raw.location.findFirstOrThrow({
      where: { tenantId, name: 'Prefijo SQL' },
    });
    expect(row.defaultPhoneRegion).toBe('US');
    // Ninguno escribe la marca: la región no la decidió la API.
    expect([
      tokyo.defaultPhoneRegionSetAt,
      row.defaultPhoneRegionSetAt,
    ]).toEqual([null, null]);
  });

  it('g1LocationInsert escribe countryCode', async () => {
    const id = await g1LocationInsert(
      raw,
      tenantId,
      'Réplica G1 país',
      REGIONAL_NEW_YORK_FIXTURE,
    );
    // Fuera de los dos valores de la columna antigua, el trigger de DX-312 la
    // deja en NULL.
    expect(await countryColumns(id)).toEqual({
      countryCode: REGIONAL_NEW_YORK_FIXTURE.country,
      country: null,
    });
  });

  it('g1LocationInsert deja el reloj en NULL y escribe lo demás', async () => {
    const id = await g1LocationInsert(
      raw,
      tenantId,
      'Réplica G1',
      REGIONAL_NEW_YORK_FIXTURE,
    );
    const row = await raw.location.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      currency: 'USD',
      timeZone: 'America/New_York',
      locale: 'en-US',
      hourCycle: null,
      regionalSettingsReviewedAt: null,
    });
  });

  it('legacyLocationInsert deja los campos regionales en NULL y el país que recibe', async () => {
    const id = await legacyLocationInsert(
      raw,
      tenantId,
      'Antigua',
      REGIONAL_BOGOTA_FIXTURE.country,
    );
    const row = await raw.location.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      currency: null,
      timeZone: null,
      locale: null,
      hourCycle: null,
      regionalSettingsReviewedAt: null,
    });
    // El país que recibe va en "countryCode"; el trigger de DX-312 da la
    // columna antigua.
    expect(await countryColumns(id)).toEqual({
      countryCode: REGIONAL_BOGOTA_FIXTURE.country,
      country: REGIONAL_BOGOTA_FIXTURE.country,
    });
  });

  it('setLocationZone cambia la sede y su horario a la vez', async () => {
    const location = await raw.location.create({
      data: locationData(REGIONAL_BOGOTA_FIXTURE, { tenantId, name: 'Zona' }),
    });
    await raw.locationSchedule.create({
      data: { tenantId, locationId: location.id, timezone: 'America/Bogota' },
    });
    await setLocationZone(raw, tenantId, location.id, 'Pacific/Auckland');
    expect(
      (await raw.location.findUniqueOrThrow({ where: { id: location.id } }))
        .timeZone,
    ).toBe('Pacific/Auckland');
    expect(
      (
        await raw.locationSchedule.findFirstOrThrow({
          where: { locationId: location.id },
        })
      ).timezone,
    ).toBe('Pacific/Auckland');
  });
});
