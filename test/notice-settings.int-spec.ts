import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  loadNoticeSettings,
  loadTenantMajorityAge,
} from '../src/modules/patients/infrastructure/notices/notice-context';
import { REGIONAL_TOKYO_FIXTURE } from './support/location-fixtures';

/**
 * DX-328: la mayoría de edad con que se decide a quién va un aviso es la de
 * la CLÍNICA (`tenants.majorityAge`), no la que antes se deducía de la sede.
 * Dos clínicas con 16 y 20, cada una con una sede idéntica (misma zona y el
 * país por defecto de la columna): la regla vieja por sede daría 18 a las
 * dos, así que una regresión que lea la sede falla aquí.
 */
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const prisma = new PrismaService(new TenantContextService());
const SUBDOMAINS = ['dx328-notice-16', 'dx328-notice-20'];

async function cleanup(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  await owner.location.deleteMany({
    where: { tenantId: { in: tenants.map((t) => t.id) } },
  });
  await owner.tenant.deleteMany({ where: { subdomain: { in: SUBDOMAINS } } });
}

describe('loadNoticeSettings (int, DX-328)', () => {
  const clinics: { tenantId: string; locationId: string; age: number }[] = [];

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    for (const [i, age] of [16, 20].entries()) {
      const tenant = await owner.tenant.create({
        data: {
          name: `Mayoría ${age}`,
          subdomain: SUBDOMAINS[i],
          majorityAge: age,
        },
      });
      const location = await owner.location.create({
        data: {
          ...REGIONAL_TOKYO_FIXTURE,
          tenantId: tenant.id,
          name: 'Principal',
        },
      });
      clinics.push({ tenantId: tenant.id, locationId: location.id, age });
    }
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await owner.$disconnect();
  });

  it('loadNoticeSettings reads majorityAge from the tenant, not the location', async () => {
    // Las dos sedes son iguales en todo lo que la regla vieja leía.
    const locations = await owner.location.findMany({
      where: { id: { in: clinics.map((c) => c.locationId) } },
      select: { country: true, timeZone: true },
    });
    expect(locations[0]).toEqual(locations[1]);

    for (const { tenantId, locationId, age } of clinics) {
      const expected = { timeZone: 'Asia/Tokyo', majorityAge: age };
      await expect(
        prisma.runWithTenant(tenantId, (tx) =>
          loadNoticeSettings(tx, tenantId, null),
        ),
      ).resolves.toEqual(expected);
      await expect(
        prisma.runWithTenant(tenantId, (tx) =>
          loadNoticeSettings(tx, tenantId, locationId),
        ),
      ).resolves.toEqual(expected);
      await expect(
        prisma.runWithTenant(tenantId, (tx) =>
          loadTenantMajorityAge(tx, tenantId),
        ),
      ).resolves.toBe(age);
    }
  });
});
