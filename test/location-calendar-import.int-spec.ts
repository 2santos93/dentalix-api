import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaLocationCalendarRepository } from '../src/modules/location-calendar/infrastructure/prisma-location-calendar.repository';
import { ImportHolidaysUseCase } from '../src/modules/location-calendar/application/import-holidays.use-case';
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

// DX-316: la importación de festivos bajo concurrencia. Escribe dentro de
// `withLockedCalendar`: el FOR UPDATE de la fila de calendario de la sede
// serializa importaciones y altas, así que R5 y el tope de 1000 se cumplen
// aunque lleguen a la vez. Lo que se prueba va por la ruta de la app
// (PrismaService → runWithTenant, rol dentalix_app, sujeto a RLS); `raw`
// (DIRECT_URL, owner) siembra, observa pg_locks y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaLocationCalendarRepository(prisma, tenantContext);
const importHolidays = new ImportHolidaysUseCase(repo);

const SUBDOMAIN = 'dx316-import-int';
const ICS_A = join(
  __dirname,
  '..',
  'src',
  'modules',
  'location-calendar',
  'domain',
  '__fixtures__',
  'holidays-12.ics',
);

let tmp: string;
/** Un CSV en un temporal, como el que deja multer. */
function csvUpload(name: string, ...lines: string[]) {
  const path = join(tmp, `${randomUUID()}-${name}`);
  writeFileSync(path, lines.join('\n'));
  return { originalname: name, path };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.locationHoliday.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
}

describe('importar festivos bajo concurrencia (int, DX-316)', () => {
  let tenantId: string;
  const asTenant = <T>(fn: () => Promise<T>) => tenantContext.run(tenantId, fn);
  const liveCount = (locationId: string) =>
    raw.locationHoliday.count({ where: { locationId, deletedAt: null } });

  async function seedLocation(name: string): Promise<string> {
    return (
      await raw.location.create({
        data: locationData(REGIONAL_TOKYO_FIXTURE, { tenantId, name }),
      })
    ).id;
  }

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'dx316-import-'));
    await cleanup();
    tenantId = (
      await raw.tenant.create({
        data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    rmSync(tmp, { recursive: true, force: true });
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  });

  it('two concurrent imports of the same file create 12, not 24', async () => {
    const locationId = await seedLocation('Sede doble importación');
    const file = { originalname: 'festivos.ics', path: ICS_A };
    const [first, second] = await Promise.all([
      asTenant(() =>
        importHolidays.execute(locationId, file, { dryRun: false }),
      ),
      asTenant(() =>
        importHolidays.execute(locationId, file, { dryRun: false }),
      ),
    ]);
    expect([first.counts, second.counts]).toEqual(
      expect.arrayContaining([
        { new: 12, duplicate: 0, error: 0 },
        { new: 0, duplicate: 12, error: 0 },
      ]),
    );
    expect(await liveCount(locationId)).toBe(12);
  });

  it('an import that waits on an uncommitted recurring holiday of the same month-day sees it: ERROR, not a second holiday that day', async () => {
    const locationId = await seedLocation('Sede importación y alta');
    const locked = gate<string>();
    const release = gate();
    // El primero bloquea el calendario e inserta un recurrente sin confirmar.
    const holder = asTenant(() =>
      repo.withLockedCalendar(locationId, async (tx, tid) => {
        await tx.locationHoliday.create({
          data: {
            id: randomUUID(),
            tenantId: tid,
            locationId,
            date: new Date('2001-05-03T00:00:00.000Z'),
            name: 'Cada año',
            recurring: true,
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
    // Un puntual del mismo día y mes: no hay índice único entre clases, así
    // que solo el bloqueo impide que entren los dos.
    const contender = asTenant(() =>
      importHolidays.execute(
        locationId,
        csvUpload('f.csv', 'fecha,nombre', '2027-05-03,Puntual'),
        { dryRun: false },
      ),
    );
    try {
      await waitForTransactionWaiters(raw, xid);
    } finally {
      release.open();
    }
    await holder;
    const result = await contender;
    expect(result.counts).toEqual({ new: 0, duplicate: 0, error: 1 });
    expect(result.rows[0]).toMatchObject({
      status: 'ERROR',
      message: 'Ese día ya es festivo cada año: «Cada año».',
    });
    expect(await liveCount(locationId)).toBe(1);
  });

  it('an import that waits on an uncommitted holiday at 998 sees it and is 409 LOCATION_HOLIDAY_LIMIT', async () => {
    const locationId = await seedLocation('Sede al tope');
    await raw.$executeRaw`
      INSERT INTO "location_holidays"
        ("id", "tenantId", "locationId", "date", "name", "recurring", "updatedAt")
      SELECT gen_random_uuid(), ${tenantId}::uuid, ${locationId}::uuid,
             DATE '2030-01-01' + g, 'Sembrado ' || g, false, now()
        FROM generate_series(0, 996) AS g`;
    // 997 vivos: caben 3. Un alta sin confirmar ocupa uno (998) y la
    // importación de 3 espera al bloqueo: al entrar ve 998 y no escribe nada.
    // Sin el bloqueo vería 997 y la sede acabaría con 1001.
    const locked = gate<string>();
    const release = gate();
    const holder = asTenant(() =>
      repo.withLockedCalendar(locationId, async (tx, tid) => {
        await tx.locationHoliday.create({
          data: {
            id: randomUUID(),
            tenantId: tid,
            locationId,
            date: new Date('2027-03-01T00:00:00.000Z'),
            name: 'Alta suelta',
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
    const contender = settle(
      asTenant(() =>
        importHolidays.execute(
          locationId,
          csvUpload(
            'f.csv',
            'fecha,nombre',
            '2027-02-01,Uno',
            '2027-02-02,Dos',
            '2027-02-03,Tres',
          ),
          { dryRun: false },
        ),
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
    expect((outcome as { reason: unknown }).reason).toMatchObject({
      response: { code: 'LOCATION_HOLIDAY_LIMIT' },
    });
    expect(await liveCount(locationId)).toBe(998);
  });
});
