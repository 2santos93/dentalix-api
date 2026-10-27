import { Prisma, PrismaClient } from '@prisma/client';
import {
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  legacyLocationInsert,
  locationData,
  regionalSql,
  setLocationZone,
} from './support/location-fixtures';

// G1 (DX-313): los helpers de test escriben lo que dicen. `legacyLocationInsert`
// simula una réplica anterior a G1 (campos regionales NULL) y `setLocationZone`
// mantiene la doble escritura de fase 1 (R20).
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

  it('locationData escribe los cuatro valores del fixture', async () => {
    const tokyo = await raw.location.create({
      data: locationData(REGIONAL_TOKYO_FIXTURE, { tenantId, name: 'Tokio' }),
    });
    expect(tokyo).toMatchObject({
      currency: 'JPY',
      timeZone: 'Asia/Tokyo',
      locale: 'ja-JP',
    });
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
    expect(row).toMatchObject({ currency: 'COP', timeZone: 'America/Bogota' });
  });

  it('legacyLocationInsert deja los campos regionales en NULL', async () => {
    const id = await legacyLocationInsert(raw, tenantId, 'Antigua');
    const row = await raw.location.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      currency: null,
      timeZone: null,
      locale: null,
      regionalSettingsReviewedAt: null,
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
