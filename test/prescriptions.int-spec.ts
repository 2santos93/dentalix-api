import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-013, capa DB de prescriptions / prescription_items / prescription_templates.
// Cada caso escribe POR LA MISMA RUTA que la app (runWithTenant, rol
// dentalix_app, sujeto a RLS); `raw` (DIRECT_URL, owner) solo siembra y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const HASH = 'b'.repeat(64);

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  userId: string;
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
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: patient.id,
    userId: user.id,
  };
}

const ITEM = {
  position: 1,
  activeIngredient: 'Amoxicilina',
  concentration: '500 mg',
  pharmaceuticalForm: 'Cápsula',
  route: 'Oral',
  dose: '1 cápsula',
  frequency: 'Cada 8 horas',
  durationDays: 7,
  totalQuantity: 21,
  quantityUnit: 'cápsulas',
  quantityInWords: 'veintiuno',
};

function rxData(
  s: Seeded,
  extra: Partial<Prisma.PrescriptionUncheckedCreateInput> = {},
): Prisma.PrescriptionUncheckedCreateInput {
  return {
    tenantId: s.tenantId,
    locationId: s.locationId,
    patientId: s.patientId,
    professionalId: s.userId,
    country: 'CO',
    issuedAt: new Date(),
    dispensationDate: new Date('2026-10-16T00:00:00.000Z'),
    validUntil: new Date('2026-11-14T00:00:00.000Z'),
    patientName: 'Ana',
    clinicalRecordNumber: '123',
    professionalName: 'Dra. Prueba',
    professionalLicense: 'RM-1',
    clinicName: 'Clínica',
    locationName: 'Sede',
    contentHash: HASH,
    ...extra,
  };
}

async function cleanup(seeds: Seeded[]): Promise<void> {
  const tenantIds = seeds.map((s) => s.tenantId);
  const where = { tenantId: { in: tenantIds } };
  // Sin `app.current_tenant` (conexión owner): los triggers dejan borrar.
  await raw.prescription.deleteMany({ where });
  await raw.prescriptionTemplate.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.user.deleteMany({
    where: { id: { in: seeds.map((s) => s.userId) } },
  });
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

const FK_VIOLATION = { code: 'P2003' };

describe('prescriptions: FK compuestas, RLS, inmutabilidad y CHECKs (DX-013, int)', () => {
  let a: Seeded;
  let b: Seeded;
  let rxA: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('rx-int-a');
    b = await seedClinic('rx-int-b');
    const created = await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.prescription.create({
        data: { ...rxData(a), items: { create: [ITEM] } },
      }),
    );
    rxA = created.id;
  });

  afterAll(async () => {
    await cleanup([a, b]);
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  describe('FK compuestas por tenant', () => {
    it('no admite el paciente ni la sede de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.prescription.create({
            data: rxData(a, { patientId: b.patientId }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
      await expect(
        asA((tx) =>
          tx.prescription.create({
            data: rxData(a, { locationId: b.locationId }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });
  });

  describe('RLS', () => {
    it('la clínica B no ve las recetas, medicamentos ni plantillas de A', async () => {
      await asA((tx) =>
        tx.prescriptionTemplate.create({
          data: {
            tenantId: a.tenantId,
            name: 'Post-exodoncia',
            items: [{ activeIngredient: 'Ibuprofeno' }],
          },
        }),
      );
      const seen = await prisma.runWithTenant(b.tenantId, async (tx) => ({
        rx: await tx.prescription.findMany(),
        items: await tx.prescriptionItem.findMany(),
        templates: await tx.prescriptionTemplate.findMany(),
      }));
      expect(seen).toEqual({ rx: [], items: [], templates: [] });
    });

    it('no deja insertar con el tenantId de otra clínica (WITH CHECK)', async () => {
      await expect(
        asA((tx) => tx.prescription.create({ data: rxData(b) })),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('inmutabilidad', () => {
    it('rechaza modificar el contenido, también como owner', async () => {
      await expect(
        asA(
          (tx) =>
            tx.$executeRaw`UPDATE "prescriptions" SET "patientName" = 'Otra' WHERE "id" = ${rxA}::uuid`,
        ),
      ).rejects.toThrow(/solo se puede anular/);
      await expect(
        raw.$executeRaw`UPDATE "prescriptions" SET "professionalLicense" = 'X' WHERE "id" = ${rxA}::uuid`,
      ).rejects.toThrow(/solo se puede anular/);
    });

    it('rechaza una anulación que además cambie el contenido', async () => {
      await expect(
        asA((tx) =>
          tx.prescription.update({
            where: { id: rxA },
            data: {
              status: 'VOIDED',
              voidedAt: new Date(),
              voidedById: a.userId,
              voidReason: 'x',
              notes: 'colada',
            },
          }),
        ),
      ).rejects.toThrow(/solo se puede anular/);
    });

    it('rechaza tocar, añadir o borrar medicamentos de una receta emitida', async () => {
      await expect(
        asA(
          (tx) =>
            tx.$executeRaw`UPDATE "prescription_items" SET "dose" = '2' WHERE "prescriptionId" = ${rxA}::uuid`,
        ),
      ).rejects.toThrow(/no se modifican/);
      await expect(
        asA((tx) =>
          tx.prescriptionItem.create({
            data: {
              ...ITEM,
              position: 2,
              tenantId: a.tenantId,
              prescriptionId: rxA,
            },
          }),
        ),
      ).rejects.toThrow(/ya emitida/);
      await expect(
        asA(
          (tx) =>
            tx.$executeRaw`DELETE FROM "prescription_items" WHERE "prescriptionId" = ${rxA}::uuid`,
        ),
      ).rejects.toThrow(/no se borran/);
    });

    it('no cuela medicamentos anulando en la misma transacción (la anulación renueva el xmin)', async () => {
      const other = await asA((tx) =>
        tx.prescription.create({
          data: { ...rxData(a), items: { create: [ITEM] } },
        }),
      );
      await expect(
        asA(async (tx) => {
          await tx.prescription.update({
            where: { id: other.id },
            data: {
              status: 'VOIDED',
              voidedAt: new Date(),
              voidedById: a.userId,
              voidReason: 'Prueba',
            },
          });
          return tx.prescriptionItem.create({
            data: {
              ...ITEM,
              position: 2,
              tenantId: a.tenantId,
              prescriptionId: other.id,
            },
          });
        }),
      ).rejects.toThrow(/ya emitida/);
    });

    it('rechaza el DELETE de la receta dentro de un contexto de tenant', async () => {
      await expect(
        asA(
          (tx) =>
            tx.$executeRaw`DELETE FROM "prescriptions" WHERE "id" = ${rxA}::uuid`,
        ),
      ).rejects.toThrow(/no se borra/);
    });

    it('admite la anulación (ISSUED → VOIDED) y después nada más', async () => {
      await asA((tx) =>
        tx.prescription.update({
          where: { id: rxA },
          data: {
            status: 'VOIDED',
            voidedAt: new Date(),
            voidedById: a.userId,
            voidReason: 'Error de dosis',
          },
        }),
      );
      const row = await raw.prescription.findUniqueOrThrow({
        where: { id: rxA },
      });
      expect(row).toMatchObject({
        status: 'VOIDED',
        voidReason: 'Error de dosis',
        patientName: 'Ana',
      });
      await expect(
        asA(
          (tx) =>
            tx.$executeRaw`UPDATE "prescriptions" SET "voidReason" = 'otro' WHERE "id" = ${rxA}::uuid`,
        ),
      ).rejects.toThrow(/solo se puede anular/);
    });
  });

  describe('CHECKs', () => {
    it('ES exige documento y año de nacimiento; CO, nº de historia clínica', async () => {
      await expect(
        asA((tx) =>
          tx.prescription.create({
            data: rxData(a, { country: 'ES', patientDocument: '12345678Z' }),
          }),
        ),
      ).rejects.toThrow(/prescriptions_country_fields_check/);
      await expect(
        asA((tx) =>
          tx.prescription.create({
            data: rxData(a, { clinicalRecordNumber: null }),
          }),
        ),
      ).rejects.toThrow(/prescriptions_country_fields_check/);
    });

    it('VOIDED exige motivo, autor y fecha; el hash es hex de 64', async () => {
      await expect(
        asA((tx) =>
          tx.prescription.create({ data: rxData(a, { status: 'VOIDED' }) }),
        ),
      ).rejects.toThrow(/prescriptions_void_check/);
      await expect(
        asA((tx) =>
          tx.prescription.create({ data: rxData(a, { contentHash: 'zz' }) }),
        ),
      ).rejects.toThrow(/prescriptions_content_hash_check/);
    });

    it('nombre de plantilla único entre las vivas; una retirada libera el nombre', async () => {
      await expect(
        asA((tx) =>
          tx.prescriptionTemplate.create({
            data: {
              tenantId: a.tenantId,
              name: 'Post-exodoncia',
              items: [{ activeIngredient: 'X' }],
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'P2002' });
      await asA((tx) =>
        tx.prescriptionTemplate.updateMany({
          where: { name: 'Post-exodoncia' },
          data: { deletedAt: new Date() },
        }),
      );
      await expect(
        asA((tx) =>
          tx.prescriptionTemplate.create({
            data: {
              tenantId: a.tenantId,
              name: 'Post-exodoncia',
              items: [{ activeIngredient: 'X' }],
            },
          }),
        ),
      ).resolves.toMatchObject({ name: 'Post-exodoncia' });
    });
  });
});
