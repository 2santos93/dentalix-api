import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  loadLocationTimeZones,
  resolveLocationTimeZones,
} from '../src/shared/locations/location-time-zone';
import { resolveReferenceLocation } from '../src/shared/locations/reference-location';
import {
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  legacyLocationInsert,
  locationData,
} from './support/location-fixtures';

/**
 * GLOBAL-G1 (DX-314): la zona de una sede sale SOLO de `locations."timeZone"`,
 * contra Postgres real con el rol de la app (RLS FORCE). Ni el horario ni el
 * país: una zona NULL o corrupta es 409, nunca Bogotá.
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const prisma = new PrismaService(new TenantContextService());
const SUBDOMAINS = ['g1-zone-int', 'g1-zone-int-empty'];

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.locationScheduleRange.deleteMany({ where });
  await raw.locationSchedule.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { subdomain: { in: SUBDOMAINS } } });
}

async function conflictOf(promise: Promise<unknown>): Promise<object> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConflictException);
  return (error as ConflictException).getResponse() as object;
}

describe('zona de la sede: solo Location.timeZone (int, G1)', () => {
  let tenantId: string;
  let emptyTenantId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await cleanup();
    tenantId = (
      await raw.tenant.create({
        data: { name: 'Zonas G1', subdomain: SUBDOMAINS[0] },
      })
    ).id;
    emptyTenantId = (
      await raw.tenant.create({
        data: { name: 'Sin sedes G1', subdomain: SUBDOMAINS[1] },
      })
    ).id;
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
    // La más antigua está desactivada: la principal es la activa más antigua.
    ids.retired = (
      await raw.location.create({
        data: locationData(REGIONAL_BOGOTA_FIXTURE, {
          tenantId,
          name: 'Retirada',
          isActive: false,
          createdAt: at(0),
        }),
      })
    ).id;
    ids.auckland = (
      await raw.location.create({
        data: locationData(REGIONAL_TOKYO_FIXTURE, {
          tenantId,
          name: 'Auckland',
          currency: 'NZD',
          timeZone: 'Pacific/Auckland',
          locale: 'en-NZ',
          createdAt: at(1),
        }),
      })
    ).id;
    ids.tokyo = (
      await raw.location.create({
        data: locationData(REGIONAL_TOKYO_FIXTURE, {
          tenantId,
          name: 'Tokio',
          createdAt: at(2),
        }),
      })
    ).id;
    // Su horario LEGADO dice Bogotá: el código nuevo no lo lee (R20).
    await raw.locationSchedule.create({
      data: { tenantId, locationId: ids.tokyo, timezone: 'America/Bogota' },
    });
    ids.corrupt = (
      await raw.location.create({
        data: locationData(REGIONAL_BOGOTA_FIXTURE, {
          tenantId,
          name: 'Marte',
          createdAt: at(3),
        }),
      })
    ).id;
    await raw.$executeRaw`
      UPDATE "locations" SET "timeZone" = 'Mars/Olympus' WHERE "id" = ${ids.corrupt}::uuid`;
    ids.legacy = await legacyLocationInsert(raw, tenantId, 'Réplica antigua');
    await raw.location.create({
      data: locationData(REGIONAL_BOGOTA_FIXTURE, {
        tenantId: emptyTenantId,
        name: 'Inactiva',
        isActive: false,
      }),
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  const inTenant = <T>(
    id: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) => prisma.runWithTenant(id, fn);

  it('reads Location.timeZone (Asia/Tokyo, Pacific/Auckland)', async () => {
    const zones = await inTenant(tenantId, (tx) =>
      loadLocationTimeZones(tx, tenantId, [ids.tokyo, ids.auckland]),
    );
    expect(zones.get(ids.tokyo)).toBe('Asia/Tokyo');
    expect(zones.get(ids.auckland)).toBe('Pacific/Auckland');
  });

  it('corrupt zone raises LOCATION_TIMEZONE_REQUIRED', async () => {
    expect(
      await conflictOf(
        inTenant(tenantId, (tx) =>
          loadLocationTimeZones(tx, tenantId, [ids.tokyo, ids.corrupt]),
        ),
      ),
    ).toMatchObject({
      code: 'LOCATION_TIMEZONE_REQUIRED',
      locationId: ids.corrupt,
    });
  });

  it('NULL zone is 409 LOCATION_TIMEZONE_REQUIRED, never Bogotá', async () => {
    const row = await raw.location.findUniqueOrThrow({
      where: { id: ids.legacy },
    });
    expect(row).toMatchObject({ country: 'CO', timeZone: null });
    expect(
      await conflictOf(
        inTenant(tenantId, (tx) =>
          resolveLocationTimeZones(tx, tenantId, [ids.legacy]),
        ),
      ),
    ).toMatchObject({
      code: 'LOCATION_TIMEZONE_REQUIRED',
      locationId: ids.legacy,
    });
  });

  it('unknown id raises LOCATION_TIMEZONE_REQUIRED', async () => {
    const unknown = '00000000-0000-4000-8000-00000000abcd';
    const zoneOf = await inTenant(tenantId, (tx) =>
      resolveLocationTimeZones(tx, tenantId, [ids.tokyo, unknown]),
    );
    expect(zoneOf(ids.tokyo)).toBe('Asia/Tokyo');
    expect(() => zoneOf(unknown)).toThrow(ConflictException);
    // Una sede de otra clínica tampoco se ve (RLS + tenantId explícito).
    const other = await inTenant(emptyTenantId, (tx) =>
      resolveLocationTimeZones(tx, emptyTenantId, [ids.tokyo]),
    );
    expect(() => other(ids.tokyo)).toThrow(ConflictException);
  });

  it('reference location is the active location or the oldest active one', async () => {
    await expect(
      inTenant(tenantId, (tx) =>
        resolveReferenceLocation(tx, tenantId, ids.tokyo),
      ),
    ).resolves.toEqual({
      id: ids.tokyo,
      timeZone: 'Asia/Tokyo',
      currency: 'JPY',
      locale: 'ja-JP',
    });
    // Sin sede en contexto: la activa más antigua (la retirada no cuenta).
    await expect(
      inTenant(tenantId, (tx) => resolveReferenceLocation(tx, tenantId, null)),
    ).resolves.toEqual({
      id: ids.auckland,
      timeZone: 'Pacific/Auckland',
      currency: 'NZD',
      locale: 'en-NZ',
    });
  });

  it('clinic without active locations raises LOCATION_REQUIRED', async () => {
    expect(
      await conflictOf(
        inTenant(emptyTenantId, (tx) =>
          resolveReferenceLocation(tx, emptyTenantId, null),
        ),
      ),
    ).toMatchObject({
      code: 'LOCATION_REQUIRED',
      message:
        'La clínica no tiene ninguna sede activa. Crea una en Ajustes → Sedes.',
    });
  });
});
