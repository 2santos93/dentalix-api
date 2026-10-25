import { NotFoundException } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { resolvePerformer } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-050, capa DB: la atribución del ítem realizado (quién, dónde, cuándo).
// FK COMPUESTA a la membresía (misma clínica Y mismo usuario) y a la sede,
// CHECK de pareja usuario/membresía y de «solo en DONE», los DONE de antes sin
// atribuir, y la corrección de la atribución en un plan cerrado. Cada caso
// escribe POR LA MISMA RUTA que la app (runWithTenant, rol dentalix_app,
// sujeto a RLS); `raw` (DIRECT_URL, owner) solo siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

interface Seeded {
  tenantId: string;
  userId: string;
  membershipId: string;
  otherUserId: string;
  otherMembershipId: string;
  locationId: string;
  patientId: string;
  catalogItemId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const [user, other] = await Promise.all(
    ['a', 'b'].map((suffix) =>
      raw.user.create({
        data: {
          email: `${subdomain}-${suffix}@example.com`,
          passwordHash: 'x',
          fullName: `Dra ${subdomain} ${suffix}`,
        },
      }),
    ),
  );
  const [membership, otherMembership] = await Promise.all(
    [user, other].map((u) =>
      raw.clinicMembership.create({
        data: { tenantId, userId: u.id, role: ClinicRole.DENTIST },
      }),
    ),
  );
  const location = await raw.location.create({
    data: { tenantId, name: 'Sede principal' },
  });
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: subdomain },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId,
      code: `c-${subdomain}`,
      kind: 'PROCEDURE',
      labelEs: 'Resina',
      color: '#123456',
    },
  });
  return {
    tenantId,
    userId: user.id,
    membershipId: membership.id,
    otherUserId: other.id,
    otherMembershipId: otherMembership.id,
    locationId: location.id,
    patientId: patient.id,
    catalogItemId: catalog.id,
  };
}

async function seedItem(
  s: Seeded,
  status: 'ACCEPTED' | 'DONE',
): Promise<{ planId: string; itemId: string }> {
  const plan = await raw.treatmentPlan.create({
    data: { tenantId: s.tenantId, patientId: s.patientId, currency: 'COP' },
  });
  const item = await raw.treatmentPlanItem.create({
    data: {
      tenantId: s.tenantId,
      planId: plan.id,
      toothNumber: '16',
      catalogItemId: s.catalogItemId,
      price: 100000,
      status,
    },
  });
  return { planId: plan.id, itemId: item.id };
}

async function cleanup(seeds: Seeded[]): Promise<void> {
  const where = { tenantId: { in: seeds.map((s) => s.tenantId) } };
  await raw.treatmentPlanItem.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.clinicMembership.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({
    where: { id: { in: seeds.map((s) => s.tenantId) } },
  });
  await raw.user.deleteMany({
    where: { id: { in: seeds.flatMap((s) => [s.userId, s.otherUserId]) } },
  });
}

const FK_VIOLATION = { code: 'P2003' };
const CHECK = /23514|check constraint/;
const CLOSED = /23001|cerrado/;

describe('DX-050 · atribución del ítem realizado en la BD (int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('dx050-int-a');
    b = await seedClinic('dx050-int-b');
  });

  afterAll(async () => {
    await cleanup([a, b]);
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  function attribute(
    itemId: string,
    data: Prisma.TreatmentPlanItemUncheckedUpdateInput,
  ) {
    return asA((tx) =>
      tx.treatmentPlanItem.update({ where: { id: itemId }, data }),
    );
  }

  it('las columnas existen y un DONE sin atribución sigue siendo válido («Sin atribuir»)', async () => {
    const { itemId } = await seedItem(a, 'DONE');
    const row = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(row).toMatchObject({
      status: 'DONE',
      performedById: null,
      performedByMembershipId: null,
      performedLocationId: null,
      completedAt: null,
    });
  });

  it('admite un miembro de la MISMA clínica y una sede suya', async () => {
    const { itemId } = await seedItem(a, 'DONE');
    const at = new Date('2026-10-20T15:00:00.000Z');
    await attribute(itemId, {
      performedById: a.userId,
      performedByMembershipId: a.membershipId,
      performedLocationId: a.locationId,
      completedAt: at,
    });
    expect(
      await raw.treatmentPlanItem.findUniqueOrThrow({ where: { id: itemId } }),
    ).toMatchObject({
      performedById: a.userId,
      performedByMembershipId: a.membershipId,
      performedLocationId: a.locationId,
      completedAt: at,
    });
  });

  it('FK compuesta: no admite la membresía de OTRA clínica', async () => {
    const { itemId } = await seedItem(a, 'DONE');
    await expect(
      attribute(itemId, {
        performedById: b.userId,
        performedByMembershipId: b.membershipId,
      }),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('FK compuesta: la membresía tiene que ser la del MISMO usuario', async () => {
    const { itemId } = await seedItem(a, 'DONE');
    await expect(
      attribute(itemId, {
        performedById: a.otherUserId,
        performedByMembershipId: a.membershipId,
      }),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('FK compuesta: no admite la sede de OTRA clínica', async () => {
    const { itemId } = await seedItem(a, 'DONE');
    await expect(
      attribute(itemId, { performedLocationId: b.locationId }),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('CHECK: usuario sin membresía (que saltaría la FK) se rechaza', async () => {
    const { itemId } = await seedItem(a, 'DONE');
    await expect(
      attribute(itemId, { performedById: b.userId }),
    ).rejects.toThrow(/treatment_plan_items_performed_by_pair|23514/);
  });

  it('CHECK: un ítem que no está DONE no lleva atribución', async () => {
    const { itemId } = await seedItem(a, 'ACCEPTED');
    await expect(
      attribute(itemId, { completedAt: new Date() }),
    ).rejects.toThrow(CHECK);
    const done = await seedItem(a, 'DONE');
    await attribute(done.itemId, {
      performedById: a.userId,
      performedByMembershipId: a.membershipId,
      completedAt: new Date(),
    });
    // Salir de DONE sin limpiar la atribución tampoco.
    await expect(
      attribute(done.itemId, { status: 'ACCEPTED' }),
    ).rejects.toThrow(/treatment_plan_items_attribution_only_done|23514/);
  });

  it('la membresía con ítems realizados no se borra (RESTRICT)', async () => {
    const { itemId } = await seedItem(a, 'DONE');
    await attribute(itemId, {
      performedById: a.otherUserId,
      performedByMembershipId: a.otherMembershipId,
    });
    await expect(
      raw.clinicMembership.delete({ where: { id: a.otherMembershipId } }),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  // Revisión DX-050: la membresía del profesional se busca por clínica en la
  // propia consulta, no solo por la RLS (misma regla que el resto de SQL a
  // mano del repo). Con una conexión que salta la RLS (owner), el profesional
  // de OTRA clínica sigue sin existir: 404, nunca su membresía.
  it('el profesional se resuelve en ESTA clínica aunque la conexión salte la RLS', async () => {
    await expect(
      raw.$transaction((tx) =>
        resolvePerformer(tx, a.tenantId, b.userId, null),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      raw.$transaction((tx) =>
        resolvePerformer(tx, a.tenantId, a.userId, a.locationId),
      ),
    ).resolves.toBe(a.membershipId);
  });

  describe('plan cerrado (DX-109)', () => {
    let itemId: string;
    let planId: string;

    beforeAll(async () => {
      ({ itemId, planId } = await seedItem(a, 'DONE'));
      await raw.treatmentPlanItem.update({
        where: { id: itemId },
        data: {
          performedById: a.userId,
          performedByMembershipId: a.membershipId,
          performedLocationId: a.locationId,
          completedAt: new Date('2026-10-20T15:00:00.000Z'),
        },
      });
      await raw.treatmentPlan.update({
        where: { id: planId },
        data: { status: 'COMPLETED' },
      });
    });

    it('admite corregir quién y cuándo de un ítem DONE', async () => {
      const at = new Date('2026-10-19T15:00:00.000Z');
      await attribute(itemId, {
        performedById: a.otherUserId,
        performedByMembershipId: a.otherMembershipId,
        completedAt: at,
      });
      expect(
        await raw.treatmentPlanItem.findUniqueOrThrow({
          where: { id: itemId },
        }),
      ).toMatchObject({ performedById: a.otherUserId, completedAt: at });
    });

    it('pero no a la vez que otra columna', async () => {
      await expect(
        attribute(itemId, {
          performedById: a.userId,
          performedByMembershipId: a.membershipId,
          notes: 'Cambiada',
        }),
      ).rejects.toThrow(CLOSED);
    });

    it('ni sacarlo de DONE', async () => {
      await expect(
        attribute(itemId, {
          status: 'ACCEPTED',
          performedById: null,
          performedByMembershipId: null,
          performedLocationId: null,
          completedAt: null,
        }),
      ).rejects.toThrow(CLOSED);
    });
  });
});
