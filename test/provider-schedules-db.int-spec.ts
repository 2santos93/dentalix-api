import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-233, capa BD: horario de los profesionales por sede y excepciones.
// Se inserta POR LA MISMA RUTA que la app (runWithTenant, rol dentalix_app,
// sujeto a RLS); `raw` (DIRECT_URL, owner) solo siembra y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

interface Clinic {
  tenantId: string;
  locationA: string;
  locationB: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const a = await raw.location.create({
    data: { tenantId: tenant.id, name: 'Sede A' },
  });
  const b = await raw.location.create({
    data: { tenantId: tenant.id, name: 'Sede B' },
  });
  return { tenantId: tenant.id, locationA: a.id, locationB: b.id };
}

async function cleanup(tenantIds: string[]): Promise<void> {
  const where = { tenantId: { in: tenantIds } };
  await raw.providerScheduleOverrideRange.deleteMany({ where });
  await raw.providerScheduleOverride.deleteMany({ where });
  await raw.providerScheduleRange.deleteMany({ where });
  await raw.providerSchedule.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

const FK_VIOLATION = { code: 'P2003' };
const UNIQUE_VIOLATION = { code: 'P2002' };
const TZ = 'America/Bogota';

describe('Horario de los profesionales: reglas de la BD (DX-233, int)', () => {
  let c: Clinic;
  let other: Clinic;
  const provider = randomUUID();

  beforeAll(async () => {
    await prisma.onModuleInit();
    c = await seedClinic('dx233-db-a');
    other = await seedClinic('dx233-db-b');
  });

  afterAll(async () => {
    await cleanup([c.tenantId, other.tenantId]);
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  afterEach(async () => {
    const where = { tenantId: { in: [c.tenantId, other.tenantId] } };
    await raw.providerScheduleOverrideRange.deleteMany({ where });
    await raw.providerScheduleOverride.deleteMany({ where });
    await raw.providerScheduleRange.deleteMany({ where });
    await raw.providerSchedule.deleteMany({ where });
  });

  function asClinic<T>(
    clinic: Clinic,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return prisma.runWithTenant(clinic.tenantId, fn);
  }

  function newSchedule(
    tx: Prisma.TransactionClient,
    locationId: string,
    providerId = provider,
    tenantId = c.tenantId,
  ) {
    return tx.providerSchedule.create({
      data: { tenantId, providerId, locationId, timezone: TZ },
    });
  }

  function newRange(
    tx: Prisma.TransactionClient,
    scheduleId: string,
    range: { weekday: number; startMinute: number; endMinute: number },
    providerId = provider,
  ) {
    return tx.providerScheduleRange.create({
      data: { tenantId: c.tenantId, scheduleId, providerId, ...range },
    });
  }

  describe('FK compuestas (SEC-004)', () => {
    it('provider_schedules: no admite la sede de otra clínica', async () => {
      await expect(
        asClinic(c, (tx) => newSchedule(tx, other.locationA)),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('provider_schedule_ranges: el tramo no puede decir que es de otro profesional', async () => {
      const schedule = await asClinic(c, (tx) => newSchedule(tx, c.locationA));
      await expect(
        asClinic(c, (tx) =>
          newRange(
            tx,
            schedule.id,
            { weekday: 1, startMinute: 480, endMinute: 780 },
            randomUUID(),
          ),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('provider_schedule_overrides: no admite la sede de otra clínica', async () => {
      await expect(
        asClinic(c, (tx) =>
          tx.providerScheduleOverride.create({
            data: {
              tenantId: c.tenantId,
              providerId: provider,
              locationId: other.locationA,
              date: new Date('2026-10-22'),
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('provider_schedule_override_ranges: la fecha del tramo es la de su excepción', async () => {
      const override = await asClinic(c, (tx) =>
        tx.providerScheduleOverride.create({
          data: {
            tenantId: c.tenantId,
            providerId: provider,
            locationId: c.locationA,
            date: new Date('2026-10-22'),
          },
        }),
      );
      await expect(
        asClinic(c, (tx) =>
          tx.providerScheduleOverrideRange.create({
            data: {
              tenantId: c.tenantId,
              overrideId: override.id,
              providerId: provider,
              date: new Date('2026-10-23'),
              startMinute: 480,
              endMinute: 600,
            },
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });
  });

  describe('único parcial', () => {
    it('un solo horario VIVO por profesional y sede; retirado no estorba', async () => {
      const first = await asClinic(c, (tx) => newSchedule(tx, c.locationA));
      await expect(
        asClinic(c, (tx) => newSchedule(tx, c.locationA)),
      ).rejects.toMatchObject(UNIQUE_VIOLATION);
      await asClinic(c, (tx) =>
        tx.providerSchedule.update({
          where: { id: first.id },
          data: { deletedAt: new Date() },
        }),
      );
      await expect(
        asClinic(c, (tx) => newSchedule(tx, c.locationA)),
      ).resolves.toMatchObject({ locationId: c.locationA });
    });

    it('una sola excepción VIVA por profesional, sede y fecha', async () => {
      const data = {
        tenantId: c.tenantId,
        providerId: provider,
        locationId: c.locationA,
        date: new Date('2026-10-22'),
      };
      const first = await asClinic(c, (tx) =>
        tx.providerScheduleOverride.create({ data }),
      );
      await expect(
        asClinic(c, (tx) => tx.providerScheduleOverride.create({ data })),
      ).rejects.toMatchObject(UNIQUE_VIOLATION);
      await asClinic(c, (tx) =>
        tx.providerScheduleOverride.update({
          where: { id: first.id },
          data: { deletedAt: new Date() },
        }),
      );
      await expect(
        asClinic(c, (tx) => tx.providerScheduleOverride.create({ data })),
      ).resolves.toMatchObject({ locationId: c.locationA });
    });
  });

  describe('CHECK de los tramos', () => {
    it.each([
      [
        'fin anterior al inicio',
        { weekday: 1, startMinute: 600, endMinute: 540 },
      ],
      [
        'más allá de medianoche',
        { weekday: 1, startMinute: 1380, endMinute: 1445 },
      ],
      [
        'minutos que no son múltiplo de 5',
        { weekday: 1, startMinute: 482, endMinute: 600 },
      ],
      ['día de la semana 7', { weekday: 7, startMinute: 480, endMinute: 600 }],
      ['inicio negativo', { weekday: 1, startMinute: -5, endMinute: 600 }],
    ])('rechaza un tramo con %s', async (_label, range) => {
      const schedule = await asClinic(c, (tx) => newSchedule(tx, c.locationA));
      await expect(
        asClinic(c, (tx) => newRange(tx, schedule.id, range)),
      ).rejects.toThrow(/provider_schedule_ranges_(minutes|weekday)_check/);
    });

    it('rechaza una nota de más de 200 caracteres en la excepción', async () => {
      await expect(
        asClinic(c, (tx) =>
          tx.providerScheduleOverride.create({
            data: {
              tenantId: c.tenantId,
              providerId: provider,
              locationId: c.locationA,
              date: new Date('2026-10-22'),
              note: 'x'.repeat(201),
            },
          }),
        ),
      ).rejects.toThrow(/provider_schedule_overrides_note_check/);
    });
  });

  describe('sin solape del mismo profesional en dos sedes (EXCLUDE)', () => {
    it('el mismo día de la semana en otra sede no se solapa; contiguo y otro día sí valen', async () => {
      const a = await asClinic(c, (tx) => newSchedule(tx, c.locationA));
      const b = await asClinic(c, (tx) => newSchedule(tx, c.locationB));
      await asClinic(c, (tx) =>
        newRange(tx, a.id, { weekday: 1, startMinute: 480, endMinute: 780 }),
      );
      await expect(
        asClinic(c, (tx) =>
          newRange(tx, b.id, { weekday: 1, startMinute: 720, endMinute: 900 }),
        ),
      ).rejects.toThrow(/provider_schedule_ranges_no_overlap/);
      // Contiguo: 13:00 empieza justo donde acaba el otro.
      await expect(
        asClinic(c, (tx) =>
          newRange(tx, b.id, { weekday: 1, startMinute: 780, endMinute: 900 }),
        ),
      ).resolves.toBeDefined();
      await expect(
        asClinic(c, (tx) =>
          newRange(tx, b.id, { weekday: 4, startMinute: 480, endMinute: 780 }),
        ),
      ).resolves.toBeDefined();
    });

    it('un tramo retirado no estorba y otro profesional tampoco', async () => {
      const a = await asClinic(c, (tx) => newSchedule(tx, c.locationA));
      const old = await asClinic(c, (tx) =>
        newRange(tx, a.id, { weekday: 2, startMinute: 480, endMinute: 780 }),
      );
      await asClinic(c, (tx) =>
        tx.providerScheduleRange.update({
          where: { id: old.id },
          data: { deletedAt: new Date() },
        }),
      );
      await expect(
        asClinic(c, (tx) =>
          newRange(tx, a.id, { weekday: 2, startMinute: 600, endMinute: 840 }),
        ),
      ).resolves.toBeDefined();
      const otherProvider = randomUUID();
      const b = await asClinic(c, (tx) =>
        newSchedule(tx, c.locationB, otherProvider),
      );
      await expect(
        asClinic(c, (tx) =>
          newRange(
            tx,
            b.id,
            { weekday: 2, startMinute: 600, endMinute: 840 },
            otherProvider,
          ),
        ),
      ).resolves.toBeDefined();
    });

    it('las excepciones del mismo día en dos sedes tampoco se solapan', async () => {
      const date = new Date('2026-10-23');
      const mk = (locationId: string) =>
        asClinic(c, (tx) =>
          tx.providerScheduleOverride.create({
            data: {
              tenantId: c.tenantId,
              providerId: provider,
              locationId,
              date,
            },
          }),
        );
      const oa = await mk(c.locationA);
      const ob = await mk(c.locationB);
      const range = (
        overrideId: string,
        startMinute: number,
        endMinute: number,
      ) =>
        asClinic(c, (tx) =>
          tx.providerScheduleOverrideRange.create({
            data: {
              tenantId: c.tenantId,
              overrideId,
              providerId: provider,
              date,
              startMinute,
              endMinute,
            },
          }),
        );
      await range(oa.id, 480, 720);
      await expect(range(ob.id, 700, 900)).rejects.toThrow(
        /provider_schedule_override_ranges_no_overlap/,
      );
      await expect(range(ob.id, 720, 900)).resolves.toBeDefined();
    });
  });

  describe('RLS forzada', () => {
    it('otra clínica no lee ni escribe los horarios', async () => {
      const schedule = await asClinic(c, (tx) => newSchedule(tx, c.locationA));
      await asClinic(c, (tx) =>
        newRange(tx, schedule.id, {
          weekday: 1,
          startMinute: 480,
          endMinute: 780,
        }),
      );
      await asClinic(c, (tx) =>
        tx.providerScheduleOverride.create({
          data: {
            tenantId: c.tenantId,
            providerId: provider,
            locationId: c.locationA,
            date: new Date('2026-10-22'),
          },
        }),
      );

      const seen = await asClinic(other, async (tx) => ({
        schedules: await tx.providerSchedule.count(),
        ranges: await tx.providerScheduleRange.count(),
        overrides: await tx.providerScheduleOverride.count(),
      }));
      expect(seen).toEqual({ schedules: 0, ranges: 0, overrides: 0 });

      // Escribir con el tenantId de la clínica A desde la B: WITH CHECK.
      await expect(
        asClinic(other, (tx) => newSchedule(tx, c.locationB)),
      ).rejects.toThrow(/row-level security/);
      // Y retirar lo de A desde B no toca nada.
      const touched = await asClinic(other, (tx) =>
        tx.providerSchedule.updateMany({ data: { deletedAt: new Date() } }),
      );
      expect(touched.count).toBe(0);
    });

    it('las cuatro tablas tienen RLS activada y FORZADA', async () => {
      const rows = await raw.$queryRaw<
        {
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }[]
      >`
        SELECT relname, relrowsecurity, relforcerowsecurity
          FROM pg_class
         WHERE relname IN ('provider_schedules', 'provider_schedule_ranges',
                           'provider_schedule_overrides', 'provider_schedule_override_ranges')
         ORDER BY relname`;
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(
        true,
      );
    });
  });
});
