import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaProviderScheduleRepository } from '../src/modules/provider-schedule/infrastructure/prisma-provider-schedule.repository';
import {
  crossLocationConflictOn,
  weeklyScheduleError,
  type ProviderScheduleSnapshot,
} from '../src/modules/provider-schedule/domain/provider-availability';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-233: el repositorio del horario contra Postgres (rol de la app, RLS):
// reemplazo en blando, excepciones que se reemplazan, y el candado por
// profesional que hace que dos guardados a la vez no se salten la regla de
// «no estar en dos sedes a la vez».
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaProviderScheduleRepository(prisma, tenantContext);

describe('Repositorio del horario de los profesionales (DX-233, int)', () => {
  let tenantId: string;
  let otherTenantId: string;
  let locationA: string;
  let locationB: string;
  const provider = randomUUID();
  const actor = randomUUID();

  beforeAll(async () => {
    await prisma.onModuleInit();
    const t = await raw.tenant.create({
      data: { name: 'Repo horario', subdomain: 'dx233-repo' },
    });
    const o = await raw.tenant.create({
      data: { name: 'Repo horario otra', subdomain: 'dx233-repo-otra' },
    });
    tenantId = t.id;
    otherTenantId = o.id;
    locationA = (
      await raw.location.create({
        data: locationData(REGIONAL_BOGOTA_FIXTURE, { tenantId, name: 'A' }),
      })
    ).id;
    locationB = (
      await raw.location.create({
        data: locationData(REGIONAL_BOGOTA_FIXTURE, { tenantId, name: 'B' }),
      })
    ).id;
  });

  afterAll(async () => {
    const where = { tenantId: { in: [tenantId, otherTenantId] } };
    await raw.providerScheduleOverrideRange.deleteMany({ where });
    await raw.providerScheduleOverride.deleteMany({ where });
    await raw.providerScheduleRange.deleteMany({ where });
    await raw.providerSchedule.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  const asClinic = <T>(fn: () => Promise<T>, id = tenantId) =>
    tenantContext.run(id, undefined, fn);

  /** Valida como el caso de uso: el semanal nuevo, entero. */
  function validator(
    locations: {
      locationId: string;
      ranges: { weekday: number; startMinute: number; endMinute: number }[];
    }[],
  ) {
    return (current: ProviderScheduleSnapshot) => {
      // Lo guardado en OTRAS sedes cuenta: el guardado concurrente que ya
      // escribió B tiene que verse aquí.
      const others = current.weekly.filter(
        (r) => !locations.some((l) => l.locationId === r.locationId),
      );
      const merged = [
        ...locations,
        ...[...new Set(others.map((r) => r.locationId))].map((locationId) => ({
          locationId,
          ranges: others.filter((r) => r.locationId === locationId),
        })),
      ];
      const error = weeklyScheduleError(merged, (id) => id);
      if (error) throw new BadRequestException(error);
    };
  }

  it('reemplazar el semanal retira en blando lo anterior y deja solo lo nuevo', async () => {
    const first = [
      {
        locationId: locationA,
        timezone: 'America/Bogota',
        ranges: [{ weekday: 1, startMinute: 480, endMinute: 780 }],
      },
    ];
    await asClinic(() =>
      repo.replaceWeekly({
        providerId: provider,
        actorId: actor,
        overridesFrom: '2026-01-01',
        locations: first,
        validate: () => undefined,
      }),
    );
    const change = await asClinic(() =>
      repo.replaceWeekly({
        providerId: provider,
        actorId: actor,
        overridesFrom: '2026-01-01',
        locations: [
          {
            locationId: locationB,
            timezone: 'America/Bogota',
            ranges: [{ weekday: 4, startMinute: 840, endMinute: 1140 }],
          },
        ],
        validate: () => undefined,
      }),
    );
    expect(change.before).toEqual([
      { locationId: locationA, weekday: 1, startMinute: 480, endMinute: 780 },
    ]);
    expect(change.after).toEqual([
      { locationId: locationB, weekday: 4, startMinute: 840, endMinute: 1140 },
    ]);
    const rows = await raw.providerScheduleRange.findMany({
      where: { tenantId },
    });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.deletedAt === null)).toHaveLength(1);
    const schedules = await raw.providerSchedule.findMany({
      where: { tenantId },
    });
    expect(
      schedules.map((s) => [s.locationId, s.deletedAt === null]).sort(),
    ).toEqual(
      [
        [locationA, false],
        [locationB, true],
      ].sort(),
    );
    // Otra clínica no lo ve.
    const seen = await asClinic(
      () =>
        repo.findSnapshots([provider], {
          from: '2026-01-01',
          to: '2026-12-31',
        }),
      otherTenantId,
    );
    expect(seen.get(provider)).toMatchObject({
      configured: false,
      weekly: [],
    });
  });

  it('una excepción por sede y fecha: la segunda reemplaza a la primera', async () => {
    const set = (ranges: { startMinute: number; endMinute: number }[]) =>
      asClinic(() =>
        repo.upsertOverride({
          providerId: provider,
          locationId: locationB,
          date: '2027-01-14',
          ranges,
          note: null,
          actorId: actor,
          validate: (current) => {
            if (
              crossLocationConflictOn(current, locationB, '2027-01-14', ranges)
            ) {
              throw new BadRequestException('solape');
            }
          },
        }),
      );
    const first = await set([]);
    expect(first.before).toBeNull();
    const second = await set([{ startMinute: 540, endMinute: 600 }]);
    expect(second.before?.id).toBe(first.after.id);
    expect(second.after.ranges).toEqual([{ startMinute: 540, endMinute: 600 }]);
    const live = await asClinic(() =>
      repo.listOverrides(provider, { from: '2027-01-01', to: '2027-01-31' }),
    );
    expect(live.map((o) => o.id)).toEqual([second.after.id]);
    expect(
      await asClinic(() => repo.deleteOverride(provider, second.after.id)),
    ).toMatchObject({ id: second.after.id });
    expect(
      await asClinic(() => repo.deleteOverride(provider, second.after.id)),
    ).toBeNull();
  });

  it('dos guardados a la vez que juntos se solaparían entre sedes: uno gana, el otro 400', async () => {
    const other = randomUUID();
    const save = (
      locationId: string,
      startMinute: number,
      endMinute: number,
    ) => {
      const locations = [
        {
          locationId,
          timezone: 'America/Bogota',
          ranges: [{ weekday: 2, startMinute, endMinute }],
        },
      ];
      return asClinic(() =>
        repo.replaceWeekly({
          providerId: other,
          actorId: actor,
          overridesFrom: '2026-01-01',
          // Cada guardado conserva lo que ya hay en la otra sede (como haría
          // un editor que manda solo su columna sobre lo leído).
          locations,
          validate: validator(locations),
        }),
      );
    };
    // Ambos parten de nada; sin el candado, los dos validarían en vacío.
    const results = await Promise.allSettled([
      save(locationA, 480, 780),
      save(locationB, 720, 900),
    ]);
    // Con el candado, el segundo valida DESPUÉS de que el primero escribió,
    // lo ve y recibe 400. Sin él, los dos validarían en vacío y pasarían.
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(BadRequestException);
    const live = await raw.providerScheduleRange.findMany({
      where: { tenantId, providerId: other, deletedAt: null },
    });
    expect(live).toHaveLength(1);
  });
});
