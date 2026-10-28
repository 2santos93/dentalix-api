import { randomUUID } from 'node:crypto';
import { ConflictException, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { loadLocationBusinessCalendar } from '../src/shared/locations/location-business-calendar';
import { addBusinessDays } from '../src/shared/time/business-days';
import { PrismaLocationCalendarRepository } from '../src/modules/location-calendar/infrastructure/prisma-location-calendar.repository';
import {
  REGIONAL_TOKYO_FIXTURE,
  locationData,
} from './support/location-fixtures';
import {
  gate,
  settle,
  transactionId,
  waitForTransactionWaiters,
} from './support/postgres-concurrency';

// DX-316: el cargador de los plazos en días hábiles y el bloqueo del
// calendario de la sede. Lo que se prueba va por la misma ruta que la app
// (PrismaService → runWithTenant, rol dentalix_app, sujeto a RLS); `raw`
// (DIRECT_URL, owner) siembra, observa pg_locks y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaLocationCalendarRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx316-cal-a', 'dx316-cal-b'];

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.locationHoliday.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
}

async function seedTenant(subdomain: string): Promise<string> {
  return (await raw.tenant.create({ data: { name: subdomain, subdomain } })).id;
}

/** Una sede de Tokio; el trigger le da su calendario de lunes a viernes. */
async function seedLocation(tenantId: string, name: string): Promise<string> {
  return (
    await raw.location.create({
      data: locationData(REGIONAL_TOKYO_FIXTURE, { tenantId, name }),
    })
  ).id;
}

function rawHoliday(
  tenantId: string,
  locationId: string,
  date: string,
  extra: { recurring?: boolean; deletedAt?: Date } = {},
) {
  return raw.locationHoliday.create({
    data: {
      id: randomUUID(),
      tenantId,
      locationId,
      date: new Date(`${date}T00:00:00.000Z`),
      name: `Festivo de prueba ${date}`,
      ...extra,
    },
  });
}

const load = (tenantId: string, locationId: string) =>
  prisma.runWithTenant(tenantId, (tx) =>
    loadLocationBusinessCalendar(tx, tenantId, locationId),
  );

describe('calendario de la sede (int, DX-316)', () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    await cleanup();
    tenantA = await seedTenant(SUBDOMAINS[0]);
    tenantB = await seedTenant(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  });

  describe('loadLocationBusinessCalendar', () => {
    it('a Tokyo location working Sunday–Thursday with a holiday: addBusinessDays on the loaded calendar gives the expected day', async () => {
      const locationId = await seedLocation(tenantA, 'Sede Tokio');
      await raw.locationWorkingCalendar.updateMany({
        where: { tenantId: tenantA, locationId },
        data: { workingWeekdays: [0, 1, 2, 3, 4] },
      });
      await rawHoliday(tenantA, locationId, '2027-05-09');
      // Retirado: no cuenta (si contara, el plazo saltaría al martes 11).
      await rawHoliday(tenantA, locationId, '2027-05-10', {
        deletedAt: new Date(),
      });

      const calendar = await load(tenantA, locationId);
      expect(calendar).toEqual({
        locationId,
        timeZone: 'Asia/Tokyo',
        workingWeekdays: [0, 1, 2, 3, 4],
        holidays: [{ date: '2027-05-09', recurring: false }],
      });
      // Miércoles 5 a las 16:00 UTC es jueves 6 a la 01:00 en Tokio. El día
      // hábil siguiente al jueves: viernes y sábado no son hábiles, el
      // domingo 9 es festivo → lunes 10. (Con el día UTC saldría el jueves
      // 6; con lunes a viernes, el viernes 7; sin el festivo, el domingo 9.)
      expect(
        addBusinessDays(
          new Date('2027-05-05T16:00:00.000Z'),
          1,
          calendar,
          calendar.timeZone,
        ),
      ).toBe('2027-05-10');
    });

    it('a location of another clinic is 409 LOCATION_TIMEZONE_REQUIRED (RLS)', async () => {
      const locationId = await seedLocation(tenantA, 'Sede ajena');
      await expect(load(tenantB, locationId)).rejects.toMatchObject({
        response: { code: 'LOCATION_TIMEZONE_REQUIRED', locationId },
      });
    });

    it('never defaults when the calendar row is missing', async () => {
      const locationId = await seedLocation(tenantA, 'Sede sin calendario');
      await raw.locationWorkingCalendar.deleteMany({
        where: { tenantId: tenantA, locationId },
      });
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        await expect(load(tenantA, locationId)).rejects.toThrow(
          'LOCATION_WORKING_CALENDAR_MISSING',
        );
      } finally {
        error.mockRestore();
      }
    });
  });

  describe('R5 bajo concurrencia: el FOR UPDATE de la fila de calendario', () => {
    const asA = <T>(fn: () => Promise<T>) => tenantContext.run(tenantA, fn);

    it('a recurring create that waits on a one-off of the same month-day sees it and is 409', async () => {
      const locationId = await seedLocation(tenantA, 'Sede carrera 1');
      const locked = gate<string>();
      const release = gate();
      // El primero bloquea el calendario e inserta un puntual sin confirmar.
      const holder = asA(() =>
        repo.withLockedCalendar(locationId, async (tx, tenantId) => {
          await tx.locationHoliday.create({
            data: {
              id: randomUUID(),
              tenantId,
              locationId,
              date: new Date('2027-05-03T00:00:00.000Z'),
              name: 'Puntual',
            },
          });
          locked.open(await transactionId(tx));
          await release.wait;
        }),
      );
      const xid = await Promise.race([
        locked.wait,
        holder.then(() => {
          throw new Error('el primero terminó sin bloquear');
        }),
      ]);
      // Un recurrente del mismo día y mes: no hay índice único entre clases,
      // así que solo el bloqueo impide que entren los dos.
      const contender = settle(
        asA(() =>
          repo.createHoliday(locationId, {
            date: '2030-05-03',
            name: 'Cada año',
            recurring: true,
          }),
        ),
      );
      try {
        await waitForTransactionWaiters(raw, xid);
      } finally {
        release.open();
      }
      await holder;
      const outcome = await contender;
      expect(outcome.status).toBe('rejected');
      const reason = (outcome as { reason: unknown }).reason;
      expect(reason).toBeInstanceOf(ConflictException);
      expect(reason).toMatchObject({
        response: { code: 'HOLIDAY_ALREADY_EXISTS' },
      });
      expect(
        await raw.locationHoliday.count({
          where: { locationId, deletedAt: null },
        }),
      ).toBe(1);
    });

    it('two conflicting creates at the same time: exactly one wins', async () => {
      const locationId = await seedLocation(tenantA, 'Sede carrera 2');
      const outcomes = await Promise.all([
        settle(
          asA(() =>
            repo.createHoliday(locationId, {
              date: '2027-12-31',
              name: 'Puntual',
              recurring: false,
            }),
          ),
        ),
        settle(
          asA(() =>
            repo.createHoliday(locationId, {
              date: '2001-12-31',
              name: 'Cada año',
              recurring: true,
            }),
          ),
        ),
      ]);
      expect(outcomes.map((o) => o.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect(
        await raw.locationHoliday.count({
          where: { locationId, deletedAt: null },
        }),
      ).toBe(1);
    });
  });
});
