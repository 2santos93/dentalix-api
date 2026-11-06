import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaEquipmentRepository } from '../src/modules/equipment/infrastructure/repositories/prisma-equipment.repository';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-542, capa BD: la red bajo la API. Se escribe como owner (DIRECT_URL, sin
// RLS) para probar las restricciones en sí, sin los pre-checks de la app, y
// como `dentalix_app` (DATABASE_URL) para la RLS FORCE, los permisos y el
// aislamiento entre clínicas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appDb = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repository = new PrismaEquipmentRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx542-int-a', 'dx542-int-b'];
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);

interface Clinic {
  tenantId: string;
  norte: string;
  sur: string;
  chairNorte: string;
  chairSur: string;
  userId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = (name: string) =>
    raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId: tenant.id,
        name,
      }),
    });
  const norte = await location('Norte');
  const sur = await location('Sur');
  const chair = (locationId: string, name: string) =>
    raw.chair.create({ data: { tenantId: tenant.id, locationId, name } });
  const chairNorte = await chair(norte.id, 'Sillón N');
  const chairSur = await chair(sur.id, 'Sillón S');
  const user = await raw.user.create({
    data: {
      email: `admin@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Admin',
    },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'ADMIN' },
  });
  return {
    tenantId: tenant.id,
    norte: norte.id,
    sur: sur.id,
    chairNorte: chairNorte.id,
    chairSur: chairSur.id,
    userId: user.id,
  };
}

function equipmentRow(
  clinic: Clinic,
  data: Partial<Prisma.EquipmentUncheckedCreateInput> = {},
): Prisma.EquipmentUncheckedCreateInput {
  return {
    tenantId: clinic.tenantId,
    locationId: clinic.norte,
    name: 'Autoclave',
    category: 'AUTOCLAVE',
    ...data,
  };
}

function maintenanceRow(
  clinic: Clinic,
  equipmentId: string,
  data: Partial<Prisma.EquipmentMaintenanceUncheckedCreateInput> = {},
): Prisma.EquipmentMaintenanceUncheckedCreateInput {
  return {
    tenantId: clinic.tenantId,
    equipmentId,
    kind: 'PREVENTIVE',
    performedOn: DAY('2026-10-01'),
    description: 'Revisión',
    createdById: clinic.userId,
    ...data,
  };
}

/** Lo que hace la app: la clínica fijada en la transacción. */
function asTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  // Owner superusuario: el trigger deja borrar la hoja de vida en los tests.
  await raw.equipmentMaintenance.deleteMany({ where });
  await raw.equipment.deleteMany({ where });
  await raw.chair.deleteMany({ where });
  await raw.clinicMembership.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
  await raw.user.deleteMany({
    where: { email: { in: SUBDOMAINS.map((s) => `admin@${s}.test`) } },
  });
}

describe('equipos biomédicos en la BD (int, DX-542)', () => {
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
      prisma.$disconnect(),
    ]);
  });

  describe('RLS FORCE, política y permisos', () => {
    it.each(['equipment', 'equipment_maintenances'])(
      '%s tiene RLS activada y FORZADA con tenant_isolation (NULLIF) y la app sin DELETE',
      async (table) => {
        const [row] = await raw.$queryRaw<
          {
            enabled: boolean;
            forced: boolean;
            policy: string;
            canDelete: boolean;
            canUpdate: boolean;
          }[]
        >`
          SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                 (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p
                   WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy,
                 has_table_privilege('dentalix_app', c.oid, 'DELETE') AS "canDelete",
                 has_table_privilege('dentalix_app', c.oid, 'UPDATE') AS "canUpdate"
          FROM pg_class c WHERE c.relname = ${table}`;
        expect(row).toMatchObject({
          enabled: true,
          forced: true,
          canDelete: false,
          canUpdate: true,
        });
        expect(row.policy).toContain('NULLIF');
      },
    );

    it('aislamiento: la app de B no ve, no edita ni inserta equipos o mantenimientos de A', async () => {
      const eqA = await raw.equipment.create({ data: equipmentRow(a) });
      const mtA = await raw.equipmentMaintenance.create({
        data: maintenanceRow(a, eqA.id),
      });
      await raw.equipment.create({
        data: equipmentRow(b, { locationId: b.norte }),
      });

      const seenByB = await asTenant(b.tenantId, async (tx) => ({
        equipment: await tx.equipment.findMany({ select: { tenantId: true } }),
        maintenances: await tx.equipmentMaintenance.findMany({
          where: { id: mtA.id },
        }),
      }));
      expect(seenByB.equipment.length).toBeGreaterThan(0);
      expect(seenByB.equipment.every((e) => e.tenantId === b.tenantId)).toBe(
        true,
      );
      expect(seenByB.maintenances).toEqual([]);

      const updated = await asTenant(b.tenantId, (tx) =>
        tx.equipment.updateMany({
          where: { id: eqA.id },
          data: { name: 'Robado' },
        }),
      );
      expect(updated.count).toBe(0);
      await expect(
        asTenant(b.tenantId, (tx) =>
          tx.equipment.create({ data: equipmentRow(a) }),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asTenant(b.tenantId, (tx) =>
          tx.equipmentMaintenance.create({ data: maintenanceRow(a, eqA.id) }),
        ),
      ).rejects.toThrow(/row-level security/);
      // Sin clínica en la sesión: nada.
      await expect(appDb.equipment.count()).resolves.toBe(0);
      // A no borra: dentalix_app no tiene DELETE.
      await expect(
        asTenant(a.tenantId, (tx) =>
          tx.equipment.delete({ where: { id: eqA.id } }),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        raw.equipment.findUnique({ where: { id: eqA.id } }),
      ).resolves.toMatchObject({
        name: 'Autoclave',
      });
    });
  });

  describe('FK compuestas', () => {
    it('la sede es de la misma clínica', async () => {
      await expect(
        raw.equipment.create({
          data: equipmentRow(a, { locationId: b.norte }),
        }),
      ).rejects.toThrow(/equipment_location_fkey/);
    });

    it('el sillón es de la MISMA sede del equipo (y de la misma clínica)', async () => {
      await expect(
        raw.equipment.create({
          data: equipmentRow(a, { chairId: a.chairNorte }),
        }),
      ).resolves.toMatchObject({ chairId: a.chairNorte });
      await expect(
        raw.equipment.create({
          data: equipmentRow(a, { chairId: a.chairSur }),
        }),
      ).rejects.toThrow(/equipment_chair_fkey/);
      await expect(
        raw.equipment.create({
          data: equipmentRow(a, { chairId: b.chairNorte }),
        }),
      ).rejects.toThrow(/equipment_chair_fkey/);
    });

    it('el mantenimiento es de un equipo de la misma clínica', async () => {
      const eqB = await raw.equipment.create({
        data: equipmentRow(b, { locationId: b.norte }),
      });
      await expect(
        raw.equipmentMaintenance.create({ data: maintenanceRow(a, eqB.id) }),
      ).rejects.toThrow(/equipment_maintenances_equipment_fkey/);
    });
  });

  describe('CHECK y triggers', () => {
    it('la periodicidad va de 1 a 120 y la baja exige fecha, motivo y autor', async () => {
      await expect(
        raw.equipment.create({
          data: equipmentRow(a, { maintenanceIntervalMonths: 0 }),
        }),
      ).rejects.toThrow(/equipment_interval_check/);
      await expect(
        raw.equipment.create({ data: equipmentRow(a, { status: 'RETIRED' }) }),
      ).rejects.toThrow(/equipment_retired_check/);
      await expect(
        raw.equipment.create({
          data: equipmentRow(a, {
            acquiredOn: DAY('2026-05-01'),
            status: 'RETIRED',
            retiredOn: DAY('2026-04-30'),
            retiredReason: 'Roto',
            retiredById: a.userId,
          }),
        }),
      ).rejects.toThrow(/equipment_retired_after_acquired_check/);
    });

    it('un equipo dado de baja ya no cambia ni se reactiva', async () => {
      const eq = await raw.equipment.create({
        data: equipmentRow(a, {
          status: 'RETIRED',
          retiredOn: DAY('2026-10-01'),
          retiredReason: 'Reemplazado',
          retiredById: a.userId,
        }),
      });
      await expect(
        asTenant(a.tenantId, (tx) =>
          tx.equipment.update({
            where: { id: eq.id },
            data: {
              status: 'ACTIVE',
              retiredOn: null,
              retiredReason: null,
              retiredById: null,
            },
          }),
        ),
      ).rejects.toThrow(/dado de baja/);
    });

    it('el costo va siempre con su moneda y el próximo es posterior a la fecha', async () => {
      const eq = await raw.equipment.create({ data: equipmentRow(a) });
      await expect(
        raw.equipmentMaintenance.create({
          data: maintenanceRow(a, eq.id, { cost: new Prisma.Decimal(10) }),
        }),
      ).rejects.toThrow(/equipment_maintenances_cost_check/);
      await expect(
        raw.equipmentMaintenance.create({
          data: maintenanceRow(a, eq.id, { nextDueOn: DAY('2026-10-01') }),
        }),
      ).rejects.toThrow(/equipment_maintenances_next_due_check/);
    });

    it('un mantenimiento es inalterable: solo se anula una vez, y la app no lo borra', async () => {
      const eq = await raw.equipment.create({ data: equipmentRow(a) });
      const mt = await raw.equipmentMaintenance.create({
        data: maintenanceRow(a, eq.id),
      });
      await expect(
        asTenant(a.tenantId, (tx) =>
          tx.equipmentMaintenance.update({
            where: { id: mt.id },
            data: { description: 'Cambiado' },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
      const voided = await asTenant(a.tenantId, (tx) =>
        tx.equipmentMaintenance.update({
          where: { id: mt.id },
          data: {
            voidedAt: new Date(),
            voidedById: a.userId,
            voidReason: 'Error de carga',
          },
        }),
      );
      expect(voided.voidReason).toBe('Error de carga');
      await expect(
        asTenant(a.tenantId, (tx) =>
          tx.equipmentMaintenance.update({
            where: { id: mt.id },
            data: { voidReason: 'Otro motivo' },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
      await expect(
        asTenant(a.tenantId, (tx) =>
          tx.equipmentMaintenance.delete({ where: { id: mt.id } }),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('la fecha de grabación la pone el servidor', async () => {
      const eq = await raw.equipment.create({ data: equipmentRow(a) });
      const mt = await raw.equipmentMaintenance.create({
        data: maintenanceRow(a, eq.id, {
          createdAt: new Date('2000-01-01T00:00:00Z'),
        }),
      });
      expect(mt.createdAt.getUTCFullYear()).toBeGreaterThan(2000);
    });
  });

  describe('baja en carrera (repositorio Prisma)', () => {
    it('editar o registrar tras una baja que ganó la carrera devuelve null (409), no choca con el trigger', async () => {
      const eq = await raw.equipment.create({ data: equipmentRow(a) });
      // La otra petición da de baja entre la lectura y la escritura.
      await raw.equipment.update({
        where: { id: eq.id },
        data: {
          status: 'RETIRED',
          retiredOn: DAY('2026-11-01'),
          retiredReason: 'Reemplazado',
          retiredById: a.userId,
        },
      });
      const inTenant = <T>(fn: () => Promise<T>) =>
        tenantContext.run(a.tenantId, fn);
      await expect(
        inTenant(() =>
          repository.update(eq.id, { name: 'Nuevo', updatedById: a.userId }),
        ),
      ).resolves.toBeNull();
      await expect(
        inTenant(() =>
          repository.addMaintenance({
            equipmentId: eq.id,
            kind: 'CORRECTIVE',
            performedOn: '2026-11-02',
            technician: null,
            company: null,
            description: 'x',
            cost: null,
            currency: null,
            nextDueOn: null,
            createdById: a.userId,
          }),
        ),
      ).resolves.toBeNull();
      await expect(
        raw.equipmentMaintenance.count({ where: { equipmentId: eq.id } }),
      ).resolves.toBe(0);
    });

    it('si el trigger salta igualmente, el repositorio lo traduce a 409', async () => {
      const eq = await raw.equipment.create({
        data: equipmentRow(a, {
          status: 'RETIRED',
          retiredOn: DAY('2026-11-01'),
          retiredReason: 'Reemplazado',
          retiredById: a.userId,
        }),
      });
      // Simula una escritura que no pasó por el UPDATE condicional.
      const updateMany = jest
        .spyOn(PrismaService.prototype, 'runWithTenant')
        .mockImplementationOnce(() =>
          appDb.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
            await tx.equipment.update({
              where: { id: eq.id },
              data: { name: 'X' },
            });
            return null;
          }),
        );
      await expect(
        tenantContext.run(a.tenantId, () =>
          repository.update(eq.id, { name: 'X', updatedById: a.userId }),
        ),
      ).rejects.toMatchObject({ status: 409 });
      updateMany.mockRestore();
    });
  });

  it('el próximo explícito no va a más de 10 años (CHECK)', async () => {
    const eq = await raw.equipment.create({ data: equipmentRow(a) });
    await expect(
      raw.equipmentMaintenance.create({
        data: maintenanceRow(a, eq.id, { nextDueOn: DAY('2036-10-02') }),
      }),
    ).rejects.toThrow(/equipment_maintenances_next_due_check/);
  });
});
