import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { settle } from './support/postgres-concurrency';

// DX-211, capa BD: la red bajo la API. Se escribe como owner (DIRECT_URL, sin
// RLS) para probar las restricciones en sí, sin los pre-checks de la app, y
// como `dentalix_app` (DATABASE_URL) para la RLS FORCE y los permisos.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appDb = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
// Dos conexiones independientes para la carrera de dos INSERT.
const racerA = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const racerB = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const START = new Date('2031-03-03T15:00:00.000Z');
const END = new Date('2031-03-03T15:30:00.000Z');
const SUBDOMAINS = ['dx211-int-a', 'dx211-int-b'];

interface Clinic {
  tenantId: string;
  norte: string;
  sur: string;
  patientIds: string[];
  membershipId: string;
  userId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = (name: string) =>
    raw.location.create({
      data: locationData(REGIONAL_BOGOTA_FIXTURE, {
        tenantId: tenant.id,
        name,
      }),
    });
  const norte = await location('Norte');
  const sur = await location('Sur');
  const patientIds: string[] = [];
  for (const name of ['Ana', 'Luis', 'Eva']) {
    const p = await raw.patient.create({
      data: { tenantId: tenant.id, firstName: name, lastName: subdomain },
    });
    patientIds.push(p.id);
  }
  const user = await raw.user.create({
    data: {
      email: `dra@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Dra',
    },
  });
  const membership = await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'DENTIST' },
  });
  return {
    tenantId: tenant.id,
    norte: norte.id,
    sur: sur.id,
    patientIds,
    membershipId: membership.id,
    userId: user.id,
  };
}

function chairRow(
  clinic: Clinic,
  data: Partial<Prisma.ChairUncheckedCreateInput> = {},
): Prisma.ChairUncheckedCreateInput {
  return {
    tenantId: clinic.tenantId,
    locationId: clinic.norte,
    name: `Sillón ${randomUUID().slice(0, 8)}`,
    ...data,
  };
}

function appointmentRow(
  clinic: Clinic,
  data: Partial<Prisma.AppointmentUncheckedCreateInput>,
): Prisma.AppointmentUncheckedCreateInput {
  return {
    tenantId: clinic.tenantId,
    locationId: clinic.norte,
    patientId: clinic.patientIds[0],
    providerId: randomUUID(),
    start: START,
    end: END,
    ...data,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.appointment.deleteMany({ where });
  await raw.chair.deleteMany({ where });
  await raw.clinicMembership.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
  await raw.user.deleteMany({
    where: { email: { in: SUBDOMAINS.map((s) => `dra@${s}.test`) } },
  });
}

describe('sillones en la BD (int, DX-211)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([
      raw.$disconnect(),
      appDb.$disconnect(),
      racerA.$disconnect(),
      racerB.$disconnect(),
    ]);
  });

  describe('RLS FORCE y permisos de `chairs`', () => {
    it('tiene RLS activada y FORZADA, con la política tenant_isolation', async () => {
      const [row] = await raw.$queryRaw<
        { enabled: boolean; forced: boolean; policies: number }[]
      >`
        SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
               (SELECT count(*)::int FROM pg_policy p
                 WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
        FROM pg_class c WHERE c.relname = 'chairs'`;
      expect(row).toEqual({ enabled: true, forced: true, policies: 1 });
    });

    it('la app solo ve los sillones de su clínica, no inserta en otra y no borra', async () => {
      const chairA = await raw.chair.create({ data: chairRow(a) });
      await raw.chair.create({ data: chairRow(b, { locationId: b.norte }) });
      const seen = await appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
        return tx.chair.findMany({ select: { tenantId: true } });
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((c) => c.tenantId === a.tenantId)).toBe(true);
      // Sin tenant en la sesión: nada.
      await expect(appDb.chair.count()).resolves.toBe(0);
      // Insertar en la clínica B con el tenant de A: WITH CHECK lo rechaza.
      await expect(
        appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          await tx.chair.create({ data: chairRow(b, { locationId: b.norte }) });
        }),
      ).rejects.toThrow(/row-level security/);
      // Desactivar, no borrar: dentalix_app no tiene DELETE.
      await expect(
        appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          await tx.chair.delete({ where: { id: chairA.id } });
        }),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('FK compuestas y CHECK de `chairs`', () => {
    it('la sede es de la misma clínica', async () => {
      await expect(
        raw.chair.create({ data: chairRow(a, { locationId: b.norte }) }),
      ).rejects.toThrow(/chairs_tenantId_locationId_fkey/);
    });

    it('el profesional por defecto es miembro de la misma clínica (membresía y usuario)', async () => {
      await expect(
        raw.chair.create({
          data: chairRow(a, {
            defaultProviderId: a.userId,
            defaultProviderMembershipId: a.membershipId,
          }),
        }),
      ).resolves.toMatchObject({ defaultProviderId: a.userId });
      // Miembro de B en un sillón de A.
      await expect(
        raw.chair.create({
          data: chairRow(a, {
            defaultProviderId: b.userId,
            defaultProviderMembershipId: b.membershipId,
          }),
        }),
      ).rejects.toThrow(/chairs_default_provider_fkey/);
      // Membresía de A con el usuario de B: la membresía no puede mentir.
      await expect(
        raw.chair.create({
          data: chairRow(a, {
            defaultProviderId: b.userId,
            defaultProviderMembershipId: a.membershipId,
          }),
        }),
      ).rejects.toThrow(/chairs_default_provider_fkey/);
      // Usuario sin membresía: los dos van juntos (CHECK).
      await expect(
        raw.chair.create({
          data: chairRow(a, { defaultProviderId: a.userId }),
        }),
      ).rejects.toThrow(/chairs_default_provider_check/);
    });

    it('nombre único por sede (activos o no), recortado y de 1 a 40', async () => {
      await raw.chair.create({
        data: chairRow(a, { name: 'Único', active: false }),
      });
      await expect(
        raw.chair.create({ data: chairRow(a, { name: 'Único' }) }),
      ).rejects.toThrow(/chairs_location_name_key|Unique constraint/);
      await expect(
        raw.chair.create({
          data: chairRow(a, { locationId: a.sur, name: 'Único' }),
        }),
      ).resolves.toBeTruthy();
      for (const name of [' Sillón', '']) {
        await expect(
          raw.chair.create({ data: chairRow(a, { name }) }),
        ).rejects.toThrow(/chairs_name_check/);
      }
      await expect(
        raw.chair.create({ data: chairRow(a, { sortOrder: 1000 }) }),
      ).rejects.toThrow(/chairs_sort_order_check/);
    });
  });

  describe('appointments.chairId', () => {
    it('FK compuesta: el sillón es de la misma clínica y de la misma sede que la cita', async () => {
      const chairSur = await raw.chair.create({
        data: chairRow(a, { locationId: a.sur }),
      });
      const chairB = await raw.chair.create({
        data: chairRow(b, { locationId: b.norte }),
      });
      await expect(
        raw.appointment.create({
          data: appointmentRow(a, {
            chairId: chairSur.id,
            start: new Date('2031-04-01T15:00:00.000Z'),
            end: new Date('2031-04-01T15:30:00.000Z'),
          }),
        }),
      ).rejects.toThrow(/appointments_chair_fkey/);
      await expect(
        raw.appointment.create({
          data: appointmentRow(a, {
            chairId: chairB.id,
            start: new Date('2031-04-02T15:00:00.000Z'),
            end: new Date('2031-04-02T15:30:00.000Z'),
          }),
        }),
      ).rejects.toThrow(/appointments_chair_fkey/);
    });

    it('EXCLUDE por sillón: incluye tenantId, el rango medio abierto y solo las vivas, no canceladas y con sillón', async () => {
      const [row] = await raw.$queryRaw<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'appointments_no_overlap_per_chair'
          AND conrelid = '"appointments"'::regclass`;
      expect(row.def).toContain('"tenantId" WITH =');
      expect(row.def).toContain('"chairId" WITH =');
      expect(row.def).toContain('tsrange(start, "end") WITH &&');
      expect(row.def).toContain('"chairId" IS NOT NULL');
      expect(row.def).toContain('"deletedAt" IS NULL');
      expect(row.def).toContain("'CANCELLED'");
    });

    it('mismo sillón y franja: 23P01; contigua, cancelada o en otro sillón: vale; sin sillón: nada cambia', async () => {
      const chair = await raw.chair.create({ data: chairRow(a) });
      const other = await raw.chair.create({ data: chairRow(a) });
      await raw.appointment.create({
        data: appointmentRow(a, { chairId: chair.id }),
      });
      await expect(
        raw.appointment.create({
          data: appointmentRow(a, {
            chairId: chair.id,
            patientId: a.patientIds[1],
            start: new Date('2031-03-03T15:15:00.000Z'),
            end: new Date('2031-03-03T15:45:00.000Z'),
          }),
        }),
      ).rejects.toThrow(/appointments_no_overlap_per_chair/);
      await expect(
        raw.appointment.create({
          data: appointmentRow(a, {
            chairId: chair.id,
            patientId: a.patientIds[1],
            start: END,
            end: new Date('2031-03-03T16:00:00.000Z'),
          }),
        }),
      ).resolves.toBeTruthy();
      await expect(
        raw.appointment.create({
          data: appointmentRow(a, {
            chairId: chair.id,
            patientId: a.patientIds[2],
            status: 'CANCELLED',
          }),
        }),
      ).resolves.toBeTruthy();
      await expect(
        raw.appointment.create({
          data: appointmentRow(a, {
            chairId: other.id,
            patientId: a.patientIds[2],
          }),
        }),
      ).resolves.toBeTruthy();
      // Sin sillón: dos citas de profesionales distintos a la misma hora.
      await expect(
        raw.appointment.create({
          data: appointmentRow(a, {
            patientId: a.patientIds[1],
            start: new Date('2031-05-05T15:00:00.000Z'),
            end: new Date('2031-05-05T15:30:00.000Z'),
          }),
        }),
      ).resolves.toBeTruthy();
      await expect(
        raw.appointment.create({
          data: appointmentRow(a, {
            patientId: a.patientIds[2],
            start: new Date('2031-05-05T15:00:00.000Z'),
            end: new Date('2031-05-05T15:30:00.000Z'),
          }),
        }),
      ).resolves.toBeTruthy();
    });

    it('concurrencia: dos INSERT simultáneos en el mismo sillón y franja, solo uno entra', async () => {
      const chair = await raw.chair.create({ data: chairRow(a) });
      const slot = {
        chairId: chair.id,
        start: new Date('2031-06-06T15:00:00.000Z'),
        end: new Date('2031-06-06T15:30:00.000Z'),
      };
      const outcomes = await Promise.all([
        settle(
          racerA.appointment.create({
            data: appointmentRow(a, { ...slot, patientId: a.patientIds[0] }),
          }),
        ),
        settle(
          racerB.appointment.create({
            data: appointmentRow(a, { ...slot, patientId: a.patientIds[1] }),
          }),
        ),
      ]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String((rejected[0] as { reason: unknown }).reason)).toMatch(
        /appointments_no_overlap_per_chair/,
      );
      await expect(
        raw.appointment.count({ where: { chairId: chair.id } }),
      ).resolves.toBe(1);
    });

    it('appointments_chair_fkey es (tenantId, locationId, chairId) → chairs, RESTRICT al borrar', async () => {
      const [row] = await raw.$queryRaw<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'appointments_chair_fkey'`;
      expect(row.def).toBe(
        'FOREIGN KEY ("tenantId", "locationId", "chairId") REFERENCES chairs("tenantId", "locationId", id) ON UPDATE CASCADE ON DELETE RESTRICT',
      );
    });
  });
});
