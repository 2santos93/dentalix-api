import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { JobRegistry } from '../src/modules/jobs/application/job-registry';
import {
  LOCATION_REGIONAL_BACKFILL_CRON,
  LOCATION_REGIONAL_BACKFILL_JOB,
  LocationRegionalBackfillJob,
  checkLocationRegional,
} from '../src/modules/locations/infrastructure/jobs/location-regional-backfill.job';
import {
  REGIONAL_BERLIN_FIXTURE,
  REGIONAL_NEW_YORK_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  g1LocationInsert,
  legacyLocationInsert,
  locationData,
} from './support/location-fixtures';

/**
 * GLOBAL-G1 fase 1 (spec §2.3): el barrido rellena, clínica por clínica y con
 * el rol de la app (RLS FORCE), las sedes que una réplica antigua dejó con
 * moneda, zona y locale NULL. Solo la función D5 decide los valores (R19).
 * G1-B fase 1 (DX-350): también el reloj que una réplica de G1 deja NULL, con
 * `dx_g1b_backfill_location_hour_cycle` (R5).
 */
const run = promisify(execFile);
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const prisma = new PrismaService(new TenantContextService());
const SUBDOMAINS = ['g1-sweep-a', 'g1-sweep-b'];
const PENDING_EMAILS = ['g1b-live@sweep.test', 'g1b-expired@sweep.test'];

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.locationSchedule.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { subdomain: { in: SUBDOMAINS } } });
  await raw.pendingRegistration.deleteMany({
    where: { email: { in: PENDING_EMAILS } },
  });
}

/** `npm run g1:backfill-locations`, con o sin `--check`. */
function runScript(...args: string[]) {
  return run(
    process.execPath,
    [
      'node_modules/.bin/ts-node',
      '--transpile-only',
      'prisma/scripts/g1-backfill-locations.ts',
      ...args,
    ],
    { env: process.env, timeout: 120_000 },
  );
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
    const { stdout } = await runScript();
    const lines = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // La sede anterior a G1 tampoco tiene reloj: la rellenan las dos funciones.
    expect(lines).toContainEqual({
      event: 'locations.regional_backfilled',
      tenantId: tenantB,
      filled: 1,
      hourCycleFilled: 1,
    });
    expect(lines.at(-1)).toMatchObject({
      event: 'locations.regional_backfill_done',
      filled: expect.any(Number) as number,
      hourCycleFilled: expect.any(Number) as number,
    });
    expect(lines.some((l) => l.tenantId === tenantA)).toBe(false);
    expect(
      await raw.location.findUniqueOrThrow({ where: { id: legacy } }),
    ).toMatchObject({
      currency: 'COP',
      hourCycle: 'h23',
      regionalSettingsReviewedAt: null,
    });
  }, 180_000);

  it('g1:backfill-locations --check counts NULL rows across tenants with the app role, without writing', async () => {
    const before = await checkLocationRegional(prisma);
    const nullA = await legacyLocationInsert(raw, tenantA, 'Sin barrer A');
    const nullB = await legacyLocationInsert(raw, tenantB, 'Sin barrer B');
    // Una clínica retirada cuenta igual: la fase 2 pone NOT NULL en todas.
    await raw.tenant.update({
      where: { id: tenantB },
      data: { deletedAt: new Date() },
    });
    try {
      const counted = await checkLocationRegional(prisma);
      expect(counted.locations).toBe(before.locations + 2);
      const failed = await runScript('--check').catch(
        (error: { code: number; stdout: string }) => error,
      );
      expect('code' in failed && failed.code).toBe(1);
      expect(failed.stdout.trim().split('\n')).toEqual([
        `locations_sin_configurar=${counted.locations}`,
        `pendientes_legados_vigentes=${counted.legacyPending}`,
        `pendientes_sin_reloj_vigentes=${counted.pendingWithoutClock}`,
      ]);
      // Solo cuenta: las dos sedes siguen sin configurar.
      for (const id of [nullA, nullB]) {
        expect(
          await raw.location.findUniqueOrThrow({ where: { id } }),
        ).toMatchObject({
          currency: null,
          timeZone: null,
          locale: null,
          hourCycle: null,
        });
      }
      // Tras el barrido (que también recorre la retirada) vuelve a la base.
      await job.sweep();
      expect((await checkLocationRegional(prisma)).locations).toBe(
        before.locations,
      );
    } finally {
      await raw.tenant.update({
        where: { id: tenantB },
        data: { deletedAt: null },
      });
    }
  }, 180_000);

  describe('reloj de la sede (G1-B fase 1)', () => {
    let replicaA: string;
    let replicaB: string;
    let chosen: string;
    const hourCycleFilled = (
      tenantId: string,
      reports: Awaited<ReturnType<LocationRegionalBackfillJob['sweep']>>,
    ) => reports.find((r) => r.tenantId === tenantId)?.hourCycleFilled;
    const snapshot = (id: string) =>
      raw.location.findUniqueOrThrow({ where: { id } });

    it('sweep job fills NULL hourCycle per tenant', async () => {
      // Sedes que crea una réplica de G1: moneda, zona y formato, sin reloj.
      replicaA = await g1LocationInsert(
        raw,
        tenantA,
        'Réplica G1 A',
        REGIONAL_NEW_YORK_FIXTURE,
      );
      replicaB = await g1LocationInsert(
        raw,
        tenantB,
        'Réplica G1 B',
        REGIONAL_BERLIN_FIXTURE,
      );
      // Un reloj elegido: nunca se pisa.
      chosen = (
        await raw.location.create({
          data: locationData(REGIONAL_NEW_YORK_FIXTURE, {
            tenantId: tenantA,
            name: 'Nueva York',
            regionalSettingsReviewedAt: new Date(),
          }),
        })
      ).id;
      const chosenBefore = await snapshot(chosen);
      expect(chosenBefore.hourCycle).toBe('h12');

      const reports = await job.sweep();
      expect(reports.find((r) => r.tenantId === tenantA)).toEqual({
        tenantId: tenantA,
        filled: 0,
        hourCycleFilled: 1,
      });
      expect(hourCycleFilled(tenantB, reports)).toBe(1);
      expect(await snapshot(replicaA)).toMatchObject({
        currency: 'USD',
        timeZone: 'America/New_York',
        locale: 'en-US',
        hourCycle: 'h23',
        // El reloj backfilleado es el que ya se veía: sin aviso de revisión.
        regionalSettingsReviewedAt: null,
      });
      expect(await snapshot(replicaB)).toMatchObject({
        locale: 'de-DE',
        hourCycle: 'h23',
        regionalSettingsReviewedAt: null,
      });
      expect(await snapshot(chosen)).toEqual(chosenBefore);
    });

    it('a second run changes nothing', async () => {
      const before = await Promise.all(
        [replicaA, replicaB, chosen].map(snapshot),
      );
      const reports = await job.sweep();
      expect(hourCycleFilled(tenantA, reports)).toBe(0);
      expect(hourCycleFilled(tenantB, reports)).toBe(0);
      expect(
        await Promise.all([replicaA, replicaB, chosen].map(snapshot)),
      ).toEqual(before);
    });

    it('--check exits 1 while a location has no clock', async () => {
      const before = await checkLocationRegional(prisma);
      const id = await g1LocationInsert(
        raw,
        tenantB,
        'Réplica G1 sin barrer',
        REGIONAL_BERLIN_FIXTURE,
      );
      const counted = await checkLocationRegional(prisma);
      expect(counted.locations).toBe(before.locations + 1);
      const failed = await runScript('--check').catch(
        (error: { code: number; stdout: string }) => error,
      );
      expect('code' in failed && failed.code).toBe(1);
      expect(failed.stdout).toContain(
        `locations_sin_configurar=${counted.locations}`,
      );
      // Solo cuenta.
      expect((await snapshot(id)).hourCycle).toBeNull();
      await job.sweep();
      expect((await snapshot(id)).hourCycle).toBe('h23');
      expect((await checkLocationRegional(prisma)).locations).toBe(
        before.locations,
      );
    }, 180_000);

    it('--check fails on a live G1-shape pending registration without clock', async () => {
      const before = await checkLocationRegional(prisma);
      const pending = (email: string, expiresAt: Date) => ({
        email,
        clinicName: 'Clínica pendiente',
        subdomain: email.split('@')[0],
        fullName: 'Ana Pérez',
        passwordHash: 'x',
        tokenHash: createHash('sha256').update(email).digest('hex'),
        createdAt: new Date(expiresAt.getTime() - 3 * 86_400_000),
        expiresAt,
        // Lo que envía una web de G1: los cuatro campos de la sede, sin reloj.
        locationCountry: REGIONAL_NEW_YORK_FIXTURE.country,
        locationCurrency: REGIONAL_NEW_YORK_FIXTURE.currency,
        locationTimeZone: REGIONAL_NEW_YORK_FIXTURE.timeZone,
        locationLocale: REGIONAL_NEW_YORK_FIXTURE.locale,
      });
      await raw.pendingRegistration.createMany({
        data: [
          pending(PENDING_EMAILS[0], new Date(Date.now() + 86_400_000)),
          // Caducado: la fase 2 lo borra, no bloquea el NOT NULL.
          pending(PENDING_EMAILS[1], new Date(Date.now() - 86_400_000)),
        ],
      });
      const counted = await checkLocationRegional(prisma);
      expect(counted).toEqual({
        ...before,
        pendingWithoutClock: before.pendingWithoutClock + 1,
      });
      const failed = await runScript('--check').catch(
        (error: { code: number; stdout: string }) => error,
      );
      expect('code' in failed && failed.code).toBe(1);
      expect(failed.stdout.trim().split('\n')).toContain(
        `pendientes_sin_reloj_vigentes=${counted.pendingWithoutClock}`,
      );
      // Con el reloj, el pendiente deja de contar.
      await raw.pendingRegistration.update({
        where: { email: PENDING_EMAILS[0] },
        data: { locationHourCycle: 'h12' },
      });
      expect((await checkLocationRegional(prisma)).pendingWithoutClock).toBe(
        before.pendingWithoutClock,
      );
    }, 180_000);

    it('sweep and POST /locations compat call the function as dentalix_app', async () => {
      const fn = 'public.dx_g1b_backfill_location_hour_cycle(uuid)';
      const [grants] = await raw.$queryRaw<
        { app: boolean; publicExec: boolean }[]
      >`
        SELECT has_function_privilege('dentalix_app', ${fn}, 'EXECUTE') AS app,
               EXISTS (SELECT 1
                         FROM pg_proc p,
                              aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                        WHERE p.oid = ${fn}::regprocedure
                          AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                 AS "publicExec"`;
      expect(grants).toEqual({ app: true, publicExec: false });

      // La llamada que hacen el barrido y la rama de compatibilidad de
      // POST /locations: con el rol de la app, en la tx de la clínica.
      const id = await g1LocationInsert(
        raw,
        tenantA,
        'Réplica G1 compat',
        REGIONAL_NEW_YORK_FIXTURE,
      );
      const call = () =>
        prisma.runWithTenant(tenantA, async (tx) => {
          const [row] = await tx.$queryRaw<{ who: string; n: number }[]>`
            SELECT current_user::text AS who,
                   public.dx_g1b_backfill_location_hour_cycle(${tenantA}::uuid) AS n`;
          return row;
        });

      // Sin el grant falla: el grant es lo que hace funcionar al barrido.
      await raw.$executeRawUnsafe(
        `REVOKE EXECUTE ON FUNCTION ${fn} FROM dentalix_app`,
      );
      try {
        await expect(call()).rejects.toThrow(/permission denied/);
        await expect(job.sweep()).rejects.toThrow(/permission denied/);
      } finally {
        await raw.$executeRawUnsafe(
          `GRANT EXECUTE ON FUNCTION ${fn} TO dentalix_app`,
        );
      }
      expect((await snapshot(id)).hourCycle).toBeNull();

      expect(await call()).toEqual({ who: 'dentalix_app', n: 1 });
      expect((await snapshot(id)).hourCycle).toBe('h23');
      const reports = await job.sweep();
      expect(hourCycleFilled(tenantA, reports)).toBe(0);
    });
  });
});
