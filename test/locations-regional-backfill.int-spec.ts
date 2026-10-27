import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { JobRegistry } from '../src/modules/jobs/application/job-registry';
import {
  LOCATION_REGIONAL_BACKFILL_CRON,
  LOCATION_REGIONAL_BACKFILL_JOB,
  LocationRegionalBackfillJob,
} from '../src/modules/locations/infrastructure/jobs/location-regional-backfill.job';
import {
  REGIONAL_TOKYO_FIXTURE,
  legacyLocationInsert,
  locationData,
} from './support/location-fixtures';

/**
 * GLOBAL-G1 fase 1 (spec §2.3): el barrido rellena, clínica por clínica y con
 * el rol de la app (RLS FORCE), las sedes que una réplica antigua dejó con
 * moneda, zona y locale NULL. Solo la función D5 decide los valores (R19).
 */
const run = promisify(execFile);
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const prisma = new PrismaService(new TenantContextService());
const SUBDOMAINS = ['g1-sweep-a', 'g1-sweep-b'];

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.locationSchedule.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { subdomain: { in: SUBDOMAINS } } });
}

describe('barrido de sedes sin configurar (int, G1 fase 1)', () => {
  let tenantA: string;
  let tenantB: string;
  let legacyA: string;
  let legacyB: string;
  let tokyo: string;
  let job: LocationRegionalBackfillJob;

  beforeAll(async () => {
    await cleanup();
    [tenantA, tenantB] = await Promise.all(
      SUBDOMAINS.map(async (subdomain) => {
        const tenant = await raw.tenant.create({
          data: { name: subdomain, subdomain },
        });
        return tenant.id;
      }),
    );
    const registry = new JobRegistry();
    job = new LocationRegionalBackfillJob(registry, prisma);
    job.onModuleInit();
    expect(registry.get(LOCATION_REGIONAL_BACKFILL_JOB)).toBeDefined();
    expect(registry.schedules()).toEqual([
      expect.objectContaining({
        cron: LOCATION_REGIONAL_BACKFILL_CRON,
        job: LOCATION_REGIONAL_BACKFILL_JOB,
      }),
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  it('sweep job fills NULL rows per tenant and a second run changes nothing', async () => {
    legacyA = await legacyLocationInsert(raw, tenantA, 'Antigua A');
    legacyB = await legacyLocationInsert(raw, tenantB, 'Antigua B');
    // Una réplica antigua de España: el país sí lo envió.
    await raw.location.update({
      where: { id: legacyB },
      data: { country: 'ES' },
    });
    // Valores elegidos por alguien: el barrido nunca los pisa.
    tokyo = (
      await raw.location.create({
        data: locationData(REGIONAL_TOKYO_FIXTURE, {
          tenantId: tenantA,
          name: 'Tokio',
          regionalSettingsReviewedAt: new Date(),
        }),
      })
    ).id;
    const tokyoBefore = await raw.location.findUniqueOrThrow({
      where: { id: tokyo },
    });

    const first = await job.sweep();
    const filled = (tenantId: string, reports: typeof first) =>
      reports.find((r) => r.tenantId === tenantId)?.filled;
    expect(filled(tenantA, first)).toBe(1);
    expect(filled(tenantB, first)).toBe(1);

    expect(
      await raw.location.findUniqueOrThrow({ where: { id: legacyA } }),
    ).toMatchObject({
      country: 'CO',
      currency: 'COP',
      timeZone: 'America/Bogota',
      locale: 'es-CO',
      // Por revisar: el ADMIN ve el aviso D5.
      regionalSettingsReviewedAt: null,
    });
    expect(
      await raw.location.findUniqueOrThrow({ where: { id: legacyB } }),
    ).toMatchObject({
      currency: 'EUR',
      timeZone: 'Europe/Madrid',
      locale: 'es-ES',
      regionalSettingsReviewedAt: null,
    });
    expect(
      await raw.location.findUniqueOrThrow({ where: { id: tokyo } }),
    ).toEqual(tokyoBefore);

    const second = await job.sweep();
    expect(filled(tenantA, second)).toBe(0);
    expect(filled(tenantB, second)).toBe(0);
    expect(
      await raw.location.findUniqueOrThrow({ where: { id: tokyo } }),
    ).toEqual(tokyoBefore);
  });

  it('g1:backfill-locations reports the rows it filled', async () => {
    const legacy = await legacyLocationInsert(raw, tenantB, 'Antigua B2');
    const { stdout } = await run(
      process.execPath,
      [
        'node_modules/.bin/ts-node',
        '--transpile-only',
        'prisma/scripts/g1-backfill-locations.ts',
      ],
      { env: process.env, timeout: 120_000 },
    );
    const lines = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual({
      event: 'locations.regional_backfilled',
      tenantId: tenantB,
      filled: 1,
    });
    expect(lines.at(-1)).toMatchObject({
      event: 'locations.regional_backfill_done',
      filled: expect.any(Number) as number,
    });
    expect(lines.some((l) => l.tenantId === tenantA)).toBe(false);
    expect(
      await raw.location.findUniqueOrThrow({ where: { id: legacy } }),
    ).toMatchObject({ currency: 'COP', regionalSettingsReviewedAt: null });
  }, 180_000);
});
