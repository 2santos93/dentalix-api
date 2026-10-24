import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-191, capa DB de patient_implants: FK compuestas, RLS FORCE,
// inalterabilidad (trigger dx_patient_implants_immutable), CHECKs y retención
// (DX-039). Cada caso escribe POR LA MISMA RUTA que la app (runWithTenant, rol
// dentalix_app); `raw` (DIRECT_URL, owner) solo siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const IMMUTABLE = /patient_implants es inalterable/;
const FK_VIOLATION = { code: 'P2003' };

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  userId: string;
  planItemId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: { tenantId: tenant.id, name: 'Sede' },
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: subdomain },
  });
  const user = await raw.user.create({
    data: {
      email: `dr@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Dra. Prueba',
    },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: `IMP-${subdomain}`,
      labelEs: 'Implante',
      kind: 'PROCEDURE',
      color: '#2563eb',
    },
  });
  const plan = await raw.treatmentPlan.create({
    data: { tenantId: tenant.id, patientId: patient.id, currency: 'COP' },
  });
  const item = await raw.treatmentPlanItem.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      toothNumber: '36',
      catalogItemId: catalog.id,
      price: 100,
    },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: patient.id,
    userId: user.id,
    planItemId: item.id,
  };
}

function implantData(
  s: Seeded,
  extra: Partial<Prisma.PatientImplantUncheckedCreateInput> = {},
): Prisma.PatientImplantUncheckedCreateInput {
  return {
    tenantId: s.tenantId,
    locationId: s.locationId,
    patientId: s.patientId,
    professionalId: s.userId,
    placedOn: new Date('2026-10-10T00:00:00.000Z'),
    toothNumber: '36',
    kind: 'IMPLANT',
    manufacturer: 'Straumann',
    reference: '021.5310',
    lot: 'LOT-INT',
    ...extra,
  };
}

async function cleanup(seeds: Seeded[]): Promise<void> {
  const tenantIds = seeds.map((s) => s.tenantId);
  const where = { tenantId: { in: tenantIds } };
  // Superusuario (owner de test): el trigger le deja borrar (purga).
  await raw.patientImplant.deleteMany({ where });
  await raw.treatmentPlanItem.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.user.deleteMany({
    where: { id: { in: seeds.map((s) => s.userId) } },
  });
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

describe('patient_implants: FK, RLS, inalterabilidad y retención (DX-191, int)', () => {
  let a: Seeded;
  let b: Seeded;
  let implantA: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('impl-int-a');
    b = await seedClinic('impl-int-b');
    implantA = (
      await prisma.runWithTenant(a.tenantId, (tx) =>
        tx.patientImplant.create({
          data: implantData(a, { treatmentPlanItemId: a.planItemId }),
        }),
      )
    ).id;
    await prisma.runWithTenant(b.tenantId, (tx) =>
      tx.patientImplant.create({ data: implantData(b) }),
    );
  });

  afterAll(async () => {
    await cleanup([a, b]);
    await raw.$disconnect();
    await appRole.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  /** SQL directo como dentalix_app, con el GUC de tenant como lo fija la app. */
  function asAppRole(sql: string, id: string) {
    return appRole.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
      return tx.$executeRawUnsafe(sql, id);
    });
  }

  describe('RLS FORCE', () => {
    it('está activada y forzada', async () => {
      const [row] = await raw.$queryRaw<
        { rls: boolean; force: boolean }[]
      >`SELECT relrowsecurity AS rls, relforcerowsecurity AS force
        FROM pg_class WHERE relname = 'patient_implants'`;
      expect(row).toEqual({ rls: true, force: true });
    });

    it('A solo ve lo suyo, también buscando el mismo lote', async () => {
      const seen = await asA((tx) =>
        tx.patientImplant.findMany({ where: { lot: 'LOT-INT' } }),
      );
      expect(seen.map((i) => i.tenantId)).toEqual([a.tenantId]);
    });

    it('B no puede escribir con el tenantId de A (WITH CHECK)', async () => {
      await expect(
        prisma.runWithTenant(b.tenantId, (tx) =>
          tx.patientImplant.create({ data: implantData(a) }),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('FK compuestas por tenant', () => {
    it.each([
      ['paciente', () => ({ patientId: b.patientId })],
      ['sede', () => ({ locationId: b.locationId })],
      ['ítem del plan', () => ({ treatmentPlanItemId: b.planItemId })],
    ])('no admite el %s de otra clínica', async (_name, extra) => {
      await expect(
        asA((tx) =>
          tx.patientImplant.create({ data: implantData(a, extra()) }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });
  });

  describe('CHECKs', () => {
    it.each([
      ['diente FDI', { toothNumber: '19' }, /patient_implants_tooth_fdi/],
      ['lote vacío', { lot: '  ' }, /patient_implants_lot_len/],
      [
        'fabricante vacío',
        { manufacturer: '' },
        /patient_implants_manufacturer_len/,
      ],
      [
        'referencia vacía',
        { reference: ' ' },
        /patient_implants_reference_len/,
      ],
      [
        'anulación sin motivo',
        { voidedAt: new Date() },
        /patient_implants_void_check/,
      ],
    ] as const)('rechaza %s', async (_name, extra, error) => {
      await expect(
        asA((tx) =>
          tx.patientImplant.create({
            data: implantData(
              a,
              extra as Partial<Prisma.PatientImplantUncheckedCreateInput>,
            ),
          }),
        ),
      ).rejects.toThrow(error);
    });
  });

  describe('inalterable (trigger)', () => {
    it('rechaza editar el lote por Prisma y por SQL', async () => {
      await expect(
        asA((tx) =>
          tx.patientImplant.update({
            where: { id: implantA },
            data: { lot: 'OTRO' },
          }),
        ),
      ).rejects.toThrow(IMMUTABLE);
      await expect(
        asAppRole(
          `UPDATE "patient_implants" SET "toothNumber" = '46' WHERE "id" = $1::uuid`,
          implantA,
        ),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('rechaza el DELETE de la app, también suplantando pg_roles (SEC-032)', async () => {
      await expect(
        asAppRole(
          `DELETE FROM "patient_implants" WHERE "id" = $1::uuid`,
          implantA,
        ),
      ).rejects.toThrow(IMMUTABLE);
      await expect(
        appRole.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          await tx.$executeRawUnsafe(
            'CREATE TEMP TABLE pg_roles (rolname name, rolsuper boolean) ON COMMIT DROP',
          );
          await tx.$executeRawUnsafe(
            'INSERT INTO pg_roles VALUES (current_user, true)',
          );
          return tx.$executeRawUnsafe(
            `DELETE FROM "patient_implants" WHERE "id" = $1::uuid`,
            implantA,
          );
        }),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('rechaza el UPDATE de contenido incluso al superusuario', async () => {
      await expect(
        raw.$executeRawUnsafe(
          `UPDATE "patient_implants" SET "notes" = 'x' WHERE "id" = $1::uuid`,
          implantA,
        ),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('deja marcar la entrega una vez y anular una vez, sin tocar nada más', async () => {
      const deliveredAt = new Date('2026-10-11T10:00:00.000Z');
      await asA((tx) =>
        tx.patientImplant.update({
          where: { id: implantA },
          data: { cardDeliveredAt: deliveredAt, cardDeliveredById: a.userId },
        }),
      );
      await expect(
        asA((tx) =>
          tx.patientImplant.update({
            where: { id: implantA },
            data: { cardDeliveredAt: new Date() },
          }),
        ),
      ).rejects.toThrow(IMMUTABLE);
      await asA((tx) =>
        tx.patientImplant.update({
          where: { id: implantA },
          data: {
            voidedAt: new Date(),
            voidedById: a.userId,
            voidReason: 'Lote mal transcrito',
          },
        }),
      );
      await expect(
        asA((tx) =>
          tx.patientImplant.update({
            where: { id: implantA },
            data: { voidReason: 'Cambio el motivo' },
          }),
        ),
      ).rejects.toThrow(IMMUTABLE);
      await expect(
        asA((tx) =>
          tx.patientImplant.update({
            where: { id: implantA },
            data: { voidedAt: new Date(), lot: 'OTRO' },
          }),
        ),
      ).rejects.toThrow(IMMUTABLE);
      const row = await raw.patientImplant.findUniqueOrThrow({
        where: { id: implantA },
      });
      expect(row).toMatchObject({
        lot: 'LOT-INT',
        cardDeliveredAt: deliveredAt,
        voidReason: 'Lote mal transcrito',
      });
    });
  });

  describe('retención (DX-039)', () => {
    it('la colocación adelanta la última atención del paciente, sin pasar de hoy', async () => {
      const patient = await raw.patient.findUniqueOrThrow({
        where: { id: a.patientId },
        select: { lastAttentionAt: true },
      });
      expect(patient.lastAttentionAt?.toISOString()).toBe(
        '2026-10-10T12:00:00.000Z',
      );
    });

    it('un paciente con implantes no se puede borrar en duro (RESTRICT)', async () => {
      await expect(
        asA((tx) => tx.patient.delete({ where: { id: a.patientId } })),
      ).rejects.toThrow();
    });
  });
});
