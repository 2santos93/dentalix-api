import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaScheduleBlockRepository } from '../src/modules/schedule-blocks/infrastructure/repositories/prisma-schedule-block.repository';
import { PrismaAppointmentRepository } from '../src/modules/appointments/infrastructure/repositories/prisma-appointment.repository';
import { UpdateAppointmentUseCase } from '../src/modules/appointments/application/use-cases/update-appointment.use-case';
import type { LocationScheduleRepository } from '../src/modules/location-schedule/domain/ports/location-schedule-repository.port';
import type { StaffRepository } from '../src/modules/staff/domain/ports/staff-repository.port';
import type { RecordAuditEventUseCase } from '../src/modules/audit/application/record-audit-event.use-case';

// DX-121, capa DB: tipos de cita (RLS FORCE, FK compuesta, CHECK) y las dos
// garantías de la agenda en columnas: la carrera de dos movimientos al mismo
// hueco (uno gana, el otro 409) y que `providerIds[]` use índice con volumen.
// `raw` (DIRECT_URL, owner) siembra y limpia; lo que se prueba va por la MISMA
// ruta que la app (runWithTenant, rol dentalix_app, sujeto a RLS).
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = ['dx121-a', 'dx121-b', 'dx121-volumen'];

interface Clinic {
  tenantId: string;
  locationId: string;
  patientIds: string[];
}

async function seedClinic(subdomain: string, patients = 3): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: { tenantId: tenant.id, name: 'Sede' },
  });
  const patientIds: string[] = [];
  for (let i = 0; i < patients; i++) {
    const patient = await raw.patient.create({
      data: { tenantId: tenant.id, firstName: `P${i}`, lastName: subdomain },
    });
    patientIds.push(patient.id);
  }
  return { tenantId: tenant.id, locationId: location.id, patientIds };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.appointmentConfirmation.deleteMany({ where });
  await raw.appointment.deleteMany({ where });
  await raw.appointmentType.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
}

/** Día futuro fijo (UTC): las citas de este spec nunca caen en el pasado. */
const DAY = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
function at(time: string): Date {
  return new Date(`${DAY}T${time}:00.000Z`);
}

describe('tipos de cita y agenda en columnas (int, DX-121)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  describe('appointment_types', () => {
    it('tiene RLS ENABLE + FORCE', async () => {
      const rows = await raw.$queryRaw<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid = '"appointment_types"'::regclass`;
      expect(rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    });

    it('cada clínica ve solo sus tipos, y no puede escribir en otra', async () => {
      await raw.appointmentType.create({
        data: {
          tenantId: b.tenantId,
          name: 'Solo de B',
          durationMinutes: 30,
          color: '#0E7490',
        },
      });
      const visible = await asA((tx) => tx.appointmentType.findMany());
      expect(visible.map((t) => t.name)).not.toContain('Solo de B');

      await expect(
        asA((tx) =>
          tx.appointmentType.create({
            data: {
              tenantId: b.tenantId,
              name: 'Intruso',
              durationMinutes: 30,
              color: '#0E7490',
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it.each([
      ['color libre', { color: 'red' }],
      ['color con CSS inyectado', { color: '#0E7490;x' }],
      ['duración no múltiplo de 5', { durationMinutes: 32 }],
      ['duración de más de 8 h', { durationMinutes: 485 }],
      ['nombre en blanco', { name: '   ' }],
    ])('el CHECK rechaza %s', async (_label, override) => {
      await expect(
        asA((tx) =>
          tx.appointmentType.create({
            data: {
              tenantId: a.tenantId,
              name: `Tipo ${randomUUID()}`,
              durationMinutes: 30,
              color: '#0E7490',
              ...override,
            },
          }),
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it('nombre único entre los vivos: uno retirado libera el nombre', async () => {
      const first = await asA((tx) =>
        tx.appointmentType.create({
          data: {
            tenantId: a.tenantId,
            name: 'Endodoncia',
            durationMinutes: 90,
            color: '#7C3AED',
          },
        }),
      );
      await expect(
        asA((tx) =>
          tx.appointmentType.create({
            data: {
              tenantId: a.tenantId,
              name: 'Endodoncia',
              durationMinutes: 60,
              color: '#7C3AED',
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'P2002' });

      await asA((tx) =>
        tx.appointmentType.update({
          where: { id: first.id },
          data: { deletedAt: new Date(), active: false },
        }),
      );
      await expect(
        asA((tx) =>
          tx.appointmentType.create({
            data: {
              tenantId: a.tenantId,
              name: 'Endodoncia',
              durationMinutes: 60,
              color: '#7C3AED',
            },
          }),
        ),
      ).resolves.toMatchObject({ name: 'Endodoncia' });
    });

    it('FK compuesta: una cita de A no admite un tipo de B', async () => {
      const typeOfB = await raw.appointmentType.create({
        data: {
          tenantId: b.tenantId,
          name: 'Tipo de B',
          durationMinutes: 30,
          color: '#0E7490',
        },
      });
      await expect(
        asA((tx) =>
          tx.appointment.create({
            data: {
              tenantId: a.tenantId,
              locationId: a.locationId,
              patientId: a.patientIds[0],
              providerId: randomUUID(),
              start: at('07:00'),
              end: at('07:30'),
              appointmentTypeId: typeOfB.id,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'P2003' });
    });
  });

  describe('carrera de dos movimientos al mismo hueco', () => {
    it('uno se mueve (200) y el otro recibe 409; queda una sola cita en el hueco', async () => {
      const p1 = randomUUID();
      const p2 = randomUUID();
      const [x, y] = await Promise.all(
        [
          { patientId: a.patientIds[1], start: at('09:00'), end: at('09:30') },
          { patientId: a.patientIds[2], start: at('10:00'), end: at('10:30') },
        ].map((slot) =>
          raw.appointment.create({
            data: {
              tenantId: a.tenantId,
              locationId: a.locationId,
              providerId: p1,
              ...slot,
            },
          }),
        ),
      );

      // Barrera: ninguno de los dos sigue hasta que ambos pasaron la lectura de
      // la cita, así los dos pre-checks de solape ven el hueco libre y es la
      // EXCLUDE constraint de la BD la que decide.
      let arrived = 0;
      let release: () => void = () => undefined;
      const barrier = new Promise<void>((resolve) => (release = resolve));
      const schedule = {
        findByLocation: async () => {
          arrived += 1;
          if (arrived === 2) release();
          await barrier;
          return null;
        },
      } as unknown as LocationScheduleRepository;
      const staff = {
        findById: (userId: string) => Promise.resolve({ userId }),
      } as unknown as StaffRepository;
      const audit = {
        record: () => Promise.resolve(),
      } as unknown as RecordAuditEventUseCase;
      const uc = new UpdateAppointmentUseCase(
        new PrismaAppointmentRepository(prisma, tenantContext),
        schedule,
        staff,
        audit,
        new PrismaScheduleBlockRepository(prisma, tenantContext),
      );

      const move = (id: string) =>
        tenantContext.run(a.tenantId, () =>
          uc.execute(id, {
            providerId: p2,
            start: at('12:00'),
            end: at('12:30'),
          }),
        );
      const results = await Promise.allSettled([move(x.id), move(y.id)]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);

      const inSlot = await raw.appointment.findMany({
        where: { tenantId: a.tenantId, providerId: p2, start: at('12:00') },
      });
      expect(inSlot).toHaveLength(1);
    });
  });

  describe('providerIds[] con volumen (índice de DX-043)', () => {
    const VOLUME = 60_000;
    const PROVIDERS = Array.from({ length: 12 }, () => randomUUID());
    let c: Clinic;

    beforeAll(async () => {
      c = await seedClinic(SUBDOMAINS[2], 50);
      const providers = PROVIDERS.map((p) => `'${p}'`).join(',');
      const patients = c.patientIds.map((p) => `'${p}'`).join(',');
      // 12 profesionales x 5000 franjas de 30 min; en cada franja, 12 pacientes
      // distintos, así ninguna fila choca con las EXCLUDE constraints.
      await raw.$executeRawUnsafe(`
        INSERT INTO "appointments"
          ("id", "tenantId", "locationId", "patientId", "providerId", "start", "end", "updatedAt")
        SELECT gen_random_uuid(), '${c.tenantId}', '${c.locationId}',
               (ARRAY[${patients}]::uuid[])[(i % 50) + 1],
               (ARRAY[${providers}]::uuid[])[(i % 12) + 1],
               s.ts, s.ts + interval '30 minutes', now()
        FROM generate_series(0, ${VOLUME - 1}) AS i,
             LATERAL (SELECT timestamp '2032-01-05 08:00' + (i / 12) * interval '30 minutes' AS ts) AS s`);
      await raw.$executeRawUnsafe('ANALYZE "appointments"');
    }, 120_000);

    it(`el día de 3 profesionales entre ${VOLUME} citas no recorre la tabla`, async () => {
      const ids = PROVIDERS.slice(0, 3)
        .map((p) => `'${p}'`)
        .join(',');
      const plan = await prisma.runWithTenant(c.tenantId, (tx) =>
        tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`
          EXPLAIN SELECT * FROM "appointments"
          WHERE "deletedAt" IS NULL
            AND "start" >= '2032-02-10 05:00' AND "start" < '2032-02-11 05:00'
            AND "providerId" IN (${ids})
            AND "locationId" = '${c.locationId}'
          ORDER BY "start" ASC`),
      );
      const text = plan.map((row) => row['QUERY PLAN']).join('\n');
      expect(text).not.toMatch(/Seq Scan on appointments/);
      expect(text).toMatch(/Index|Bitmap/);
    });
  });
});
